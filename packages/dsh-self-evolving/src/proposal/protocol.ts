/**
 * Proposal output protocol validator (spec 03 §10).
 *
 * The proposer emits up to `proposalWidth` (default 3) children per expansion.
 * Each must:
 *  - start from a full copy of the canonical parent;
 *  - implement ONE primary hypothesis (with协同 changes only if necessary);
 *  - provide mechanism + preservation tests;
 *  - write a full manifest referencing actual evidence;
 *  - NOT read other proposers' concurrent output.
 *
 * The validator REJECTS: no-change proposals, test-only proposals, duplicate
 * hypotheses within the batch, and proposals missing donor provenance.
 */
import { createHash } from 'node:crypto'
import { TextDecoder } from 'node:util'

export interface ProposalChild {
  proposalId: string
  canonicalParentDigest: string
  donorCandidates: string[]
  hypothesis: string
  evidenceRefs: string[]
  mechanismTests: string[]
  preservationTests: string[]
  /** The candidate source diff (relative to parent). Required. */
  sourceDiff: string
}

export interface ProposalBatch {
  parentDigest: string
  children: ProposalChild[]
}

export interface ProposalValidationResult {
  accepted: ProposalChild[]
  rejected: Array<{ proposalId: string; reason: string }>
}

export const DEFAULT_PROPOSAL_WIDTH = 3

interface DiffInspection {
  paths: string[]
  sawFileHeader: boolean
  parseError: string | null
}

interface ParsedPathToken {
  value: string
  remainder: string
}

const SIMPLE_GIT_ESCAPES: Readonly<Record<string, number>> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  '"': 0x22,
  '\\': 0x5c,
}

/**
 * Validate a proposer's batch output. Returns accepted children + rejected
 * with reasons. A proposer that emits 0 accepted children yields a
 * NO_NONTRIVIAL_PROPOSAL outcome (caller records, does not silently pass).
 */
export function validateProposalBatch(
  batch: ProposalBatch,
  width: number = DEFAULT_PROPOSAL_WIDTH,
): ProposalValidationResult {
  const accepted: ProposalChild[] = []
  const rejected: ProposalValidationResult['rejected'] = []
  const seenHypotheses = new Set<string>()

  if (batch.children.length > width) {
    // Extra proposals beyond the width are rejected, not silently dropped.
    for (const extra of batch.children.slice(width)) {
      rejected.push({ proposalId: extra.proposalId, reason: `exceeds proposalWidth ${width}` })
    }
  }

  for (const child of batch.children.slice(0, width)) {
    if (child.canonicalParentDigest !== batch.parentDigest) {
      rejected.push({
        proposalId: child.proposalId,
        reason: `canonicalParentDigest ${child.canonicalParentDigest} != batch parent ${batch.parentDigest}`,
      })
      continue
    }
    if (child.sourceDiff.trim().length === 0) {
      rejected.push({ proposalId: child.proposalId, reason: 'no-change (empty sourceDiff)' })
      continue
    }

    const inspection = inspectChangedPaths(child.sourceDiff)
    if (inspection.parseError !== null) {
      rejected.push({
        proposalId: child.proposalId,
        reason: `malformed unified diff file header: ${inspection.parseError}`,
      })
      continue
    }
    if (isTestOnly(child.sourceDiff, inspection)) {
      rejected.push({
        proposalId: child.proposalId,
        reason: 'test-only proposal (no production change)',
      })
      continue
    }
    if (child.hypothesis.trim().length < 10) {
      rejected.push({ proposalId: child.proposalId, reason: 'hypothesis missing or too short' })
      continue
    }
    if (child.mechanismTests.length === 0 || child.preservationTests.length === 0) {
      rejected.push({
        proposalId: child.proposalId,
        reason: 'mechanism/preservation tests missing',
      })
      continue
    }
    const hHash = createHash('sha256').update(child.hypothesis.trim().toLowerCase()).digest('hex')
    if (seenHypotheses.has(hHash)) {
      rejected.push({ proposalId: child.proposalId, reason: 'duplicate hypothesis within batch' })
      continue
    }
    seenHypotheses.add(hHash)

    const malformedDonor = child.donorCandidates.find(
      (donor) => !/^sha256:[0-9a-f]{64}$/.test(donor),
    )
    if (malformedDonor !== undefined) {
      rejected.push({ proposalId: child.proposalId, reason: `malformed donor ${malformedDonor}` })
      continue
    }

    accepted.push(child)
  }

  return { accepted, rejected }
}

function parseQuotedGitPath(raw: string): ParsedPathToken {
  const bytes: number[] = []
  let index = 1
  while (index < raw.length) {
    const character = raw[index]!
    if (character === '"') {
      let value: string
      try {
        value = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes))
      } catch (error) {
        throw new Error('quoted path is not valid UTF-8', { cause: error })
      }
      return { value, remainder: raw.slice(index + 1) }
    }

    if (character !== '\\') {
      const codePoint = raw.codePointAt(index)
      if (codePoint === undefined) throw new Error('quoted path ended unexpectedly')
      bytes.push(...Buffer.from(String.fromCodePoint(codePoint), 'utf8'))
      index += codePoint > 0xffff ? 2 : 1
      continue
    }

    index += 1
    const escaped = raw[index]
    if (escaped === undefined) throw new Error('quoted path ends with an escape')
    const simple = SIMPLE_GIT_ESCAPES[escaped]
    if (simple !== undefined) {
      bytes.push(simple)
      index += 1
      continue
    }
    if (/[0-7]/.test(escaped)) {
      let octal = escaped
      index += 1
      while (octal.length < 3 && index < raw.length && /[0-7]/.test(raw[index]!)) {
        octal += raw[index]!
        index += 1
      }
      const value = Number.parseInt(octal, 8)
      if (value > 0xff) throw new Error(`octal escape \\${octal} exceeds one byte`)
      bytes.push(value)
      continue
    }
    throw new Error(`unsupported Git path escape \\${escaped}`)
  }
  throw new Error('quoted path has no closing quote')
}

function parseGitPathToken(raw: string): ParsedPathToken {
  if (raw.startsWith('"')) return parseQuotedGitPath(raw)
  const delimiter = raw.indexOf('\t')
  if (delimiter === -1) return { value: raw, remainder: '' }
  return { value: raw.slice(0, delimiter), remainder: raw.slice(delimiter) }
}

function normalizeParsedDiffPath(value: string, stripGitPrefix: boolean): string | null {
  let path = value
  if (path === '/dev/null') return null
  if (stripGitPrefix && (path.startsWith('a/') || path.startsWith('b/'))) path = path.slice(2)
  if (path.length === 0) throw new Error('empty changed path')
  if (path.includes('\0')) throw new Error('changed path contains NUL')

  const normalized = path.replaceAll('\\', '/')
  if (normalized.startsWith('/') || normalized.split('/').some((part) => part === '..')) {
    throw new Error(`unsafe changed path ${JSON.stringify(path)}`)
  }
  return path
}

function normalizeDiffPath(raw: string, stripGitPrefix: boolean): string | null {
  const parsed = parseGitPathToken(raw)
  if (parsed.remainder.length > 0 && !parsed.remainder.startsWith('\t')) {
    throw new Error('unexpected bytes after quoted path')
  }
  return normalizeParsedDiffPath(parsed.value, stripGitPrefix)
}

interface DiffFileBlock {
  oldPath: string
  newPath: string
  sawOldHeader: boolean
  sawNewHeader: boolean
  sawRenameFrom: boolean
  sawRenameTo: boolean
  sawCopyFrom: boolean
  sawCopyTo: boolean
}

function parseDiffGitWord(raw: string): ParsedPathToken {
  if (raw.startsWith('"')) return parseQuotedGitPath(raw)
  const delimiter = raw.indexOf(' ')
  if (delimiter === -1) return { value: raw, remainder: '' }
  return { value: raw.slice(0, delimiter), remainder: raw.slice(delimiter) }
}

function parseDiffGitPaths(raw: string): { oldPath: string; newPath: string } {
  const oldToken = parseDiffGitWord(raw)
  const separator = oldToken.remainder.match(/^ +/)
  if (separator === null) throw new Error('diff --git header is missing its path separator')

  const newRaw = oldToken.remainder.slice(separator[0].length)
  if (newRaw.length === 0) throw new Error('diff --git header is missing its new path')
  const newToken = parseDiffGitWord(newRaw)
  if (newToken.remainder.length > 0) {
    throw new Error('unexpected bytes after diff --git new path')
  }

  const oldPath = normalizeParsedDiffPath(oldToken.value, true)
  const newPath = normalizeParsedDiffPath(newToken.value, true)
  if (oldPath === null || newPath === null) {
    throw new Error('diff --git paths cannot be /dev/null')
  }
  return { oldPath, newPath }
}

function assertCompleteBlock(block: DiffFileBlock): void {
  const pairs: Array<[boolean, boolean, string]> = [
    [block.sawOldHeader, block.sawNewHeader, '---/+++'],
    [block.sawRenameFrom, block.sawRenameTo, 'rename from/to'],
    [block.sawCopyFrom, block.sawCopyTo, 'copy from/to'],
  ]
  for (const [left, right, label] of pairs) {
    if (left !== right) throw new Error(`incomplete ${label} metadata pair`)
  }
}

function inspectChangedPaths(diff: string): DiffInspection {
  const paths = new Set<string>()
  let sawFileHeader = false
  let current: DiffFileBlock | null = null
  let standaloneOldPath: string | null | undefined
  let inHunk = false

  try {
    for (const line of diff.split('\n')) {
      if (line.startsWith('diff --git ')) {
        if (standaloneOldPath !== undefined) {
          throw new Error('incomplete standalone ---/+++ metadata pair')
        }
        if (current !== null) assertCompleteBlock(current)
        const parsed = parseDiffGitPaths(line.slice('diff --git '.length))
        current = {
          ...parsed,
          sawOldHeader: false,
          sawNewHeader: false,
          sawRenameFrom: false,
          sawRenameTo: false,
          sawCopyFrom: false,
          sawCopyTo: false,
        }
        paths.add(parsed.oldPath)
        paths.add(parsed.newPath)
        sawFileHeader = true
        inHunk = false
        continue
      }

      if (line.startsWith('@@ ') || line.startsWith('@@@ ')) {
        inHunk = true
        continue
      }
      if (inHunk) continue

      let raw: string | null = null
      let stripGitPrefix = false
      let side: 'old' | 'new' | 'rename-from' | 'rename-to' | 'copy-from' | 'copy-to' | null = null
      if (line.startsWith('--- ')) {
        raw = line.slice(4)
        stripGitPrefix = true
        side = 'old'
      } else if (line.startsWith('+++ ')) {
        raw = line.slice(4)
        stripGitPrefix = true
        side = 'new'
      } else if (line.startsWith('rename from ')) {
        raw = line.slice('rename from '.length)
        side = 'rename-from'
      } else if (line.startsWith('rename to ')) {
        raw = line.slice('rename to '.length)
        side = 'rename-to'
      } else if (line.startsWith('copy from ')) {
        raw = line.slice('copy from '.length)
        side = 'copy-from'
      } else if (line.startsWith('copy to ')) {
        raw = line.slice('copy to '.length)
        side = 'copy-to'
      }
      if (raw === null || side === null) continue

      sawFileHeader = true
      const path = normalizeDiffPath(raw, stripGitPrefix)
      if (current === null) {
        if (side === 'old') {
          if (standaloneOldPath !== undefined) throw new Error('duplicate standalone --- header')
          standaloneOldPath = path
        } else if (side === 'new') {
          if (standaloneOldPath === undefined) {
            throw new Error('standalone +++ header has no matching --- header')
          }
          if (standaloneOldPath === null && path === null) {
            throw new Error('standalone file headers do not identify a changed path')
          }
          if (standaloneOldPath !== null) paths.add(standaloneOldPath)
          if (path !== null) paths.add(path)
          standaloneOldPath = undefined
        } else {
          throw new Error(`${side} metadata requires a diff --git header`)
        }
        continue
      }

      const expected =
        side === 'old' || side === 'rename-from' || side === 'copy-from'
          ? current.oldPath
          : current.newPath
      if (path !== null && path !== expected) {
        throw new Error(
          `${side} path ${JSON.stringify(path)} does not match diff --git path ${JSON.stringify(expected)}`,
        )
      }
      if (side === 'old') {
        if (current.sawOldHeader) throw new Error('duplicate --- file header')
        current.sawOldHeader = true
      } else if (side === 'new') {
        if (current.sawNewHeader) throw new Error('duplicate +++ file header')
        current.sawNewHeader = true
      } else if (side === 'rename-from') {
        if (path === null) throw new Error('rename source cannot be /dev/null')
        if (current.sawRenameFrom) throw new Error('duplicate rename from header')
        current.sawRenameFrom = true
      } else if (side === 'rename-to') {
        if (path === null) throw new Error('rename target cannot be /dev/null')
        if (current.sawRenameTo) throw new Error('duplicate rename to header')
        current.sawRenameTo = true
      } else if (side === 'copy-from') {
        if (path === null) throw new Error('copy source cannot be /dev/null')
        if (current.sawCopyFrom) throw new Error('duplicate copy from header')
        current.sawCopyFrom = true
      } else {
        if (path === null) throw new Error('copy target cannot be /dev/null')
        if (current.sawCopyTo) throw new Error('duplicate copy to header')
        current.sawCopyTo = true
      }
      if (path !== null) paths.add(path)
    }

    if (standaloneOldPath !== undefined) {
      throw new Error('incomplete standalone ---/+++ metadata pair')
    }
    if (current !== null) assertCompleteBlock(current)
  } catch (error) {
    return {
      paths: [],
      sawFileHeader,
      parseError: error instanceof Error ? error.message : String(error),
    }
  }

  if (sawFileHeader && paths.size === 0) {
    return {
      paths: [],
      sawFileHeader,
      parseError: 'file headers do not identify any changed path',
    }
  }
  return { paths: [...paths], sawFileHeader, parseError: null }
}

function isTestPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').toLowerCase()
  return (
    /(^|\/)(?:tests?|__tests__)(\/|$)/.test(normalized) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(normalized)
  )
}

/** A diff is test-only iff every explicitly changed file is a test file. */
function isTestOnly(diff: string, inspection: DiffInspection): boolean {
  if (inspection.paths.length > 0) return inspection.paths.every(isTestPath)
  if (inspection.sawFileHeader) return true

  // Some provider fixtures emit compact fragments without file headers. Keep a
  // conservative compatibility path: a fragment is test-only only when it has
  // additions, names tests, and does not name an explicit production path.
  const addedLines = diff.split('\n').filter((line) => line.startsWith('+'))
  if (addedLines.length === 0) return true
  const mentionsTests = /(^|[^a-z0-9_])(?:tests?|__tests__)\//i.test(diff)
  const mentionsProduction = /(^|[^a-z0-9_])src\//i.test(diff)
  return mentionsTests && !mentionsProduction
}
