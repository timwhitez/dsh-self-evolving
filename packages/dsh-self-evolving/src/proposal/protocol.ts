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
    if (isTestOnly(child.sourceDiff)) {
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

/** A diff is "test-only" if every changed path is under a tests/ dir. */
function isTestOnly(diff: string): boolean {
  const lines = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'))
  if (lines.length === 0) return true
  const hasTestPath = diff.includes('tests/') || diff.includes('test/')
  const hasProdChange = /\+(export |function |class |const |import )/.test(diff) && !hasTestPath
  return hasTestPath && !hasProdChange
}
