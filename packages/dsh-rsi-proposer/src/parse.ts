/**
 * Proposal output parsing + builder handoff (spec 03 §10, spec 07 §6 Accept).
 *
 * Parses the model's JSON envelope into a ProposalChild, validates the batch
 * through the proposal protocol validator, then hands accepted children to the
 * candidate-SDK builder to produce real admitted candidate artifacts. Rejected
 * proposals + their reasons are retained as evidence (never silently dropped).
 */
import { validateProposalBatch, type ProposalChild, type ProposalBatch } from '@dsh-rsi/core'
import { buildCanonicalArchive, type DeclaredFile } from '@dsh-rsi/candidate-sdk'

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
  const children = parseChildren(assistantText)
  const batch: ProposalBatch = { parentDigest, children }
  const result = validateProposalBatch(batch, width)
  return { accepted: result.accepted, rejected: result.rejected }
}

function parseChildren(text: string): ProposalChild[] {
  const cleaned = stripFences(text).trim()
  // Try to locate a JSON object or array within the text.
  const jsonText = extractJson(cleaned)
  if (jsonText === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return []
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed]
  return arr
    .filter((o): o is Record<string, unknown> => o !== null && typeof o === 'object')
    .map((o) => toProposalChild(o))
    .filter((c): c is ProposalChild => c !== null)
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
  try {
    return {
      proposalId: String(o['proposalId'] ?? `prop-${Math.random().toString(36).slice(2, 8)}`),
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
