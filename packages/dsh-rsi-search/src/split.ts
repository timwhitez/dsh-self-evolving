/**
 * Deterministic split ceremony + sealed service information-flow guard
 * (spec 04 §3, spec 05 §4).
 *
 * The 89 TB tasks are split deterministically:
 *   48 dev-observed + 12 dev-guard + 29 sealed = 89
 * The split is a content-addressed commitment: a Merkle root over the
 * (taskId → label) assignment, recorded BEFORE any evaluation. The sealed 29
 * are concealed by the sealed service; selector/proposer only ever see the
 * commitment, never the mapping, until the single reveal.
 *
 * The sealed service aborts if a selector/proposer principal touches a sealed
 * event or canary before the candidate lock.
 */
import { createHash } from 'node:crypto'

export type SplitLabel = 'dev-observed' | 'dev-guard' | 'sealed'

export interface SplitAssignment {
  taskId: string
  label: SplitLabel
}

export interface SplitCommitment {
  /** Fixed split sizes. */
  sizes: { devObserved: number; devGuard: number; sealed: number }
  /** sha256 master seed commitment (the seed itself is held by the sealed service). */
  seedCommitment: string
  /** Merkle root over the sorted (taskId, label) assignment. */
  merkleRoot: string
  /** The assignment is NOT included here — it lives in the sealed service. */
}

export const SPLIT_SIZES = { devObserved: 48, devGuard: 12, sealed: 29 }

/**
 * Compute the split commitment from an assignment. The assignment is produced
 * deterministically from the (concealed) master seed + sorted task ids; this
 * function only commits to it via a Merkle root.
 */
export function commitSplit(
  assignment: SplitAssignment[],
  seedCommitment: string,
  sizes: { devObserved: number; devGuard: number; sealed: number } = SPLIT_SIZES,
): SplitCommitment {
  // Validate sizes.
  const counts = { 'dev-observed': 0, 'dev-guard': 0, sealed: 0 } as Record<SplitLabel, number>
  for (const a of assignment) counts[a.label] += 1
  if (counts['dev-observed'] !== sizes.devObserved) {
    throw new Error(`split: dev-observed count ${counts['dev-observed']} != ${sizes.devObserved}`)
  }
  if (counts['dev-guard'] !== sizes.devGuard) {
    throw new Error(`split: dev-guard count ${counts['dev-guard']} != ${sizes.devGuard}`)
  }
  if (counts['sealed'] !== sizes.sealed) {
    throw new Error(`split: sealed count ${counts['sealed']} != ${sizes.sealed}`)
  }
  const merkleRoot = merkle(
    [...assignment]
      .sort((a, b) => a.taskId.localeCompare(b.taskId))
      .map((a) => `${a.taskId}:${a.label}`),
  )
  return { sizes, seedCommitment, merkleRoot }
}

/** Verify a (later-revealed) assignment matches the commitment. */
export function verifySplit(commitment: SplitCommitment, assignment: SplitAssignment[]): boolean {
  try {
    const recomputed = commitSplit(assignment, commitment.seedCommitment, commitment.sizes)
    return recomputed.merkleRoot === commitment.merkleRoot
  } catch {
    return false
  }
}

function merkle(leaves: string[]): string {
  if (leaves.length === 0) return createHash('sha256').update('empty-split').digest('hex')
  let layer = leaves.map((l) =>
    createHash('sha256')
      .update('split-leaf:' + l)
      .digest('hex'),
  )
  while (layer.length > 1) {
    const next: string[] = []
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i]!
      const right = layer[i + 1] ?? left
      next.push(
        createHash('sha256')
          .update(left + right)
          .digest('hex'),
      )
    }
    layer = next
  }
  return 'sha256:' + layer[0]!
}

/**
 * Sealed service information-flow guard (spec 05 §4).
 * A selector/proposer principal that touches a sealed event/canary MUST abort.
 * This returns true (abort) if the principal is not sealed-authorized AND the
 * resource label is sealed.
 */
export function assertNoSealedLeak(
  principal: string,
  resourceLabel: SplitLabel,
  sealedRevealed: boolean,
): void {
  if (sealedRevealed) return // after the single reveal, sealed is visible
  const isSealedPrincipal = principal.startsWith('sealed:')
  if (resourceLabel === 'sealed' && !isSealedPrincipal) {
    throw new Error(
      `INFORMATION_FLOW_VIOLATION: principal ${principal} accessed sealed resource before reveal`,
    )
  }
}

/**
 * Candidate lock transaction (spec 03, spec 06): once the candidate is locked,
 * selector/proposer calls are permanently refused. This is a pure check the
 * reducer + every selector/proposer entrypoint consults.
 */
export function assertNotLocked(candidateLocked: boolean, operation: string): void {
  if (candidateLocked) {
    throw new Error(`LOCKED: ${operation} refused after candidate lock`)
  }
}
