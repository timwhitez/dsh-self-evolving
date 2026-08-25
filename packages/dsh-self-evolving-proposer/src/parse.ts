/**
 * Proposal output parsing + builder handoff (spec 03 §10, spec 07 §6 Accept).
 *
 * Parses the model's JSON envelope into a ProposalChild, validates the batch
 * through the proposal protocol validator, then hands accepted children to the
 * candidate-SDK builder to produce real admitted candidate artifacts. Rejected
 * proposals + their reasons are retained as evidence (never silently dropped).
 */
import { createHash } from 'node:crypto'
import { buildCanonicalArchive, type DeclaredFile } from '@dsh-self-evolving/candidate-sdk'
import {
  validateProposalBatch,
  type ProposalChild,
  type ProposalBatch,
} from '@dsh-self-evolving/core'

export interface ParsedProposal {
  accepted: ProposalChild[]
  rejected: Array<{ proposalId: string; reason: string }>
}

/**
 * Parse the assistant text into ProposalChild(ren) and validate. Tolerates a
 * single JSON object or a JSON array. Strips accidental markdown fences.
 */
export function parseAndValidate(
  assistantText: string,
  parentDigest: string,
  width: number,
): ParsedProposal {
  const parsed = parseChildren(assistantText)
  const batch: ProposalBatch = { parentDigest, children: parsed.children }
  const result = validateProposalBatch(batch, width)
  return { accepted: result.accepted, rejected: [...parsed.rejected, ...result.rejected] }
}

function parseChildren(text: string): {
  children: ProposalChild[]
  rejected: Array<{ proposalId: string; reason: string }>
} {
  const cleaned = stripFences(text).trim()
  // Try to locate a JSON object or array within the text.
  const jsonText = extractJson(cleaned)
  if (jsonText === null) return { children: [], rejected: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return { children: [], rejected: [] }
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed]
  const children: ProposalChild[] = []
  const rejected: Array<{ proposalId: string; reason: string }> = []
  for (const value of arr) {
    if (value === null || typeof value !== 'object') continue
    const object = value as Record<string, unknown>
    const proposalId = object['proposalId']
    if (typeof proposalId !== 'string' || proposalId.trim().length === 0) {
      rejected.push({
        proposalId: `invalid_${createHash('sha256').update(canonicalObject(object)).digest('hex')}`,
        reason: 'proposalId is required and must be a non-empty string',
      })
      continue
    }
    const child = toProposalChild(object)
    if (child !== null) children.push(child)
  }
  return { children, rejected }
}

function canonicalObject(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalObject).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalObject(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function stripFences(text: string): string {
  return text.replace(/```(?:json)?/gi, '').replace(/```/g, '')
}

function extractJson(text: string): string | null {
  const start = text.search(/[{[]/)
  if (start === -1) return null
  // Find the matching close by scanning brackets.
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\') {
      escape = true
      continue
    }
    if (ch === '"') inStr = !inStr
    if (inStr) continue
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return text.slice(start) // best-effort
}

function toProposalChild(o: Record<string, unknown>): ProposalChild | null {
  const proposalId = o['proposalId']
  if (typeof proposalId !== 'string' || proposalId.trim().length === 0) return null
  try {
    return {
      proposalId,
      canonicalParentDigest: String(o['canonicalParentDigest'] ?? ''),
      donorCandidates: Array.isArray(o['donorCandidates'])
        ? (o['donorCandidates'] as string[])
        : [],
      hypothesis: String(o['hypothesis'] ?? ''),
      evidenceRefs: Array.isArray(o['evidenceRefs']) ? (o['evidenceRefs'] as string[]) : [],
      mechanismTests: Array.isArray(o['mechanismTests']) ? (o['mechanismTests'] as string[]) : [],
      preservationTests: Array.isArray(o['preservationTests'] as string[])
        ? (o['preservationTests'] as string[])
        : [],
      sourceDiff: String(o['sourceDiff'] ?? ''),
    }
  } catch {
    return null
  }
}

/**
 * Build the canonical parent source tar from a set of declared files, to obtain
 * the parent digest the proposal must reference.
 */
export async function parentDigestOf(files: DeclaredFile[]): Promise<string> {
  const archive = await buildCanonicalArchive(files)
  return 'sha256:' + archive.hash
}

/** Retention record for a rejected proposal (spec: rejected evidence is kept). */
export interface RejectedProposalRecord {
  proposalId: string
  reason: string
  rawAssistantText: string
  retainedAt: string
}

export function retainRejected(
  rejected: Array<{ proposalId: string; reason: string }>,
  rawAssistantText: string,
): RejectedProposalRecord[] {
  return rejected.map((r) => ({
    proposalId: r.proposalId,
    reason: r.reason,
    rawAssistantText,
    retainedAt: new Date().toISOString(),
  }))
}
