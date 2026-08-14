import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EvidenceCitation } from '@dsh-rsi/candidate-sdk'
import type { ExportManifest } from './export.js'

export interface ResolvedCitation {
  citation: EvidenceCitation
  label: 'PUBLIC_SPEC' | 'DEV_OBSERVED'
  resolvedDigest: `sha256:${string}`
  valueDigest: `sha256:${string}`
}

function jsonPointer(root: unknown, pointer: string): unknown {
  if (pointer === '') return root
  if (!pointer.startsWith('/')) throw new Error('v0.1.1 citation: invalid JSON Pointer')
  let current = root
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) {
        throw new Error(`v0.1.1 citation: array pointer token is invalid: ${token}`)
      }
      current = current[Number(token)]
    } else if (current !== null && typeof current === 'object') {
      if (!Object.prototype.hasOwnProperty.call(current, token)) {
        throw new Error(`v0.1.1 citation: pointer does not resolve: ${pointer}`)
      }
      current = (current as Record<string, unknown>)[token]
    } else {
      throw new Error(`v0.1.1 citation: pointer traverses scalar: ${pointer}`)
    }
    if (current === undefined)
      throw new Error(`v0.1.1 citation: pointer does not resolve: ${pointer}`)
  }
  return current
}

export async function resolveV011Citation(input: {
  citation: EvidenceCitation
  exportManifest: ExportManifest
  exportRoot: string
}): Promise<ResolvedCitation> {
  const digest = input.citation.objectDigest.replace(/^sha256:/, '')
  const entry = input.exportManifest.objects.find((object) => object.digest === digest)
  if (entry === undefined) throw new Error('v0.1.1 citation: digest is absent from bound export')
  if (entry.label !== 'PUBLIC_SPEC' && entry.label !== 'DEV_OBSERVED') {
    throw new Error(`v0.1.1 citation: disallowed export label ${entry.label}`)
  }
  if (entry.mediaType !== input.citation.mediaType) {
    throw new Error('v0.1.1 citation: media type does not match immutable export entry')
  }
  const bytes = await readFile(join(input.exportRoot, 'objects', digest))
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== digest) throw new Error('v0.1.1 citation: exported object bytes are corrupt')
  let resolved: unknown
  if (input.citation.locator.kind === 'json-pointer') {
    let parsed: unknown
    try {
      parsed = JSON.parse(bytes.toString('utf8')) as unknown
    } catch (error) {
      throw new Error('v0.1.1 citation: JSON Pointer used for non-JSON bytes', { cause: error })
    }
    resolved = jsonPointer(parsed, input.citation.locator.value)
  } else {
    const { startLine, endLine } = input.citation.locator
    if (endLine < startLine) throw new Error('v0.1.1 citation: JSONL line range is reversed')
    const lines = bytes.toString('utf8').replace(/\n$/, '').split('\n')
    if (endLine > lines.length) throw new Error('v0.1.1 citation: JSONL line range exceeds object')
    const selected = lines.slice(startLine - 1, endLine)
    for (const line of selected) {
      try {
        JSON.parse(line)
      } catch (error) {
        throw new Error('v0.1.1 citation: selected JSONL line is invalid', { cause: error })
      }
    }
    resolved = selected
  }
  return {
    citation: input.citation,
    label: entry.label,
    resolvedDigest: `sha256:${digest}`,
    valueDigest: `sha256:${createHash('sha256').update(JSON.stringify(resolved)).digest('hex')}`,
  }
}

export async function resolveV011Citations(input: {
  citations: EvidenceCitation[]
  exportManifest: ExportManifest
  exportRoot: string
}): Promise<ResolvedCitation[]> {
  return Promise.all(
    input.citations.map((citation) =>
      resolveV011Citation({
        citation,
        exportManifest: input.exportManifest,
        exportRoot: input.exportRoot,
      }),
    ),
  )
}
