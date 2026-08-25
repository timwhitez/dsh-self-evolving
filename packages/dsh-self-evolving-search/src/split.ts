/**
 * Deterministic split ceremony + sealed service information-flow guard
 * (spec 04 §3, spec 05 §4).
 *
 * The 89 TB tasks are split deterministically:
 *   48 dev-observed + 12 dev-guard + 29 sealed = 89
 * The split is a content-addressed commitment: a Merkle root over the
 * frozen inventory, seed commitment, split sizes, and (taskId → label)
 * assignment, recorded BEFORE any evaluation. The sealed 29 are concealed by
 * the sealed service; selector/proposer only ever see the commitment, never the
 * mapping, until the single reveal.
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
  /** Versioned commitment protocol; version 2 binds the frozen task inventory. */
  schemaVersion: 2
  /** Fixed split sizes. */
  sizes: { devObserved: number; devGuard: number; sealed: number }
  /** sha256 master seed commitment (the seed itself is held by the sealed service). */
  seedCommitment: string
  /** Digest of the exact sorted unique task inventory. */
  taskInventoryDigest: string
  /** Merkle root over protocol metadata and the sorted (taskId, label) assignment. */
  merkleRoot: string
  /** The assignment is NOT included here — it lives in the sealed service. */
}

export const SPLIT_SIZES = { devObserved: 48, devGuard: 12, sealed: 29 }

const SPLIT_COMMITMENT_DOMAIN = 'dsh-self-evolving-split-v2'
const TASK_INVENTORY_DOMAIN = 'dsh-self-evolving-task-inventory-v1'
const digestPattern = /^sha256:[0-9a-f]{64}$/
const validLabels = new Set<SplitLabel>(['dev-observed', 'dev-guard', 'sealed'])

/** Canonical protocol order: unsigned UTF-8 bytes with a total code-unit fallback. */
function bytewise(left: string, right: string): number {
  const byteOrder = Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
  if (byteOrder !== 0 || left === right) return byteOrder

  // Distinct JavaScript strings containing unpaired surrogates can encode to
  // identical UTF-8 replacement bytes. Keep the ordering total even when
  // runtime callers bypass TypeScript types.
  return left < right ? -1 : 1
}

function validateTaskId(taskId: unknown): asserts taskId is string {
  if (
    typeof taskId !== 'string' ||
    taskId.length === 0 ||
    taskId.trim() !== taskId ||
    taskId.includes('\0') ||
    taskId.normalize('NFC') !== taskId
  ) {
    throw new Error('split: task IDs must be non-empty canonical NFC strings')
  }
}

function canonicalInventory(taskIds: readonly string[]): string[] {
  const seen = new Set<string>()
  const canonical = taskIds.map((taskId) => {
    validateTaskId(taskId)
    if (seen.has(taskId)) throw new Error(`split: duplicate frozen task ID ${taskId}`)
    seen.add(taskId)
    return taskId
  })
  canonical.sort(bytewise)
  return canonical
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function taskInventoryDigest(taskIds: readonly string[]): string {
  return sha256(JSON.stringify([TASK_INVENTORY_DOMAIN, ...taskIds]))
}

/**
 * Compute the split commitment from an assignment and an independently frozen
 * task inventory. The assignment is produced deterministically from the
 * concealed master seed + sorted task IDs; this function proves it contains
 * exactly one label for every frozen task and commits all ceremony metadata.
 */
export function commitSplit(
  assignment: readonly SplitAssignment[],
  seedCommitment: string,
  expectedTaskIds: readonly string[],
  sizes: { devObserved: number; devGuard: number; sealed: number } = SPLIT_SIZES,
): SplitCommitment {
  if (!digestPattern.test(seedCommitment)) {
    throw new Error('split: seed commitment must be canonical sha256')
  }
  const frozenSizes = {
    devObserved: sizes.devObserved,
    devGuard: sizes.devGuard,
    sealed: sizes.sealed,
  }
  for (const [name, value] of Object.entries(frozenSizes)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`split: ${name} size must be a non-negative safe integer`)
    }
  }

  const frozenInventory = canonicalInventory(expectedTaskIds)
  const expectedTotal = frozenSizes.devObserved + frozenSizes.devGuard + frozenSizes.sealed
  if (expectedTotal !== assignment.length || expectedTotal !== frozenInventory.length) {
    throw new Error(
      'split: declared sizes, assignment length, and frozen inventory length must match exactly',
    )
  }

  const expectedSet = new Set(frozenInventory)
  const counts = { 'dev-observed': 0, 'dev-guard': 0, sealed: 0 } as Record<SplitLabel, number>
  const seenTaskIds = new Set<string>()
  const canonicalAssignment = assignment.map((entry) => {
    validateTaskId(entry.taskId)
    if (!validLabels.has(entry.label)) throw new Error(`split: invalid label for ${entry.taskId}`)
    if (seenTaskIds.has(entry.taskId)) {
      throw new Error(`split: duplicate task ID ${entry.taskId}`)
    }
    if (!expectedSet.has(entry.taskId)) {
      throw new Error(`split: task outside frozen inventory: ${entry.taskId}`)
    }
    seenTaskIds.add(entry.taskId)
    counts[entry.label] += 1
    return { taskId: entry.taskId, label: entry.label }
  })

  for (const taskId of frozenInventory) {
    if (!seenTaskIds.has(taskId)) throw new Error(`split: frozen task is unassigned: ${taskId}`)
  }
  if (counts['dev-observed'] !== frozenSizes.devObserved) {
    throw new Error(
      `split: dev-observed count ${counts['dev-observed']} != ${frozenSizes.devObserved}`,
    )
  }
  if (counts['dev-guard'] !== frozenSizes.devGuard) {
    throw new Error(`split: dev-guard count ${counts['dev-guard']} != ${frozenSizes.devGuard}`)
  }
  if (counts.sealed !== frozenSizes.sealed) {
    throw new Error(`split: sealed count ${counts.sealed} != ${frozenSizes.sealed}`)
  }

  canonicalAssignment.sort((left, right) => bytewise(left.taskId, right.taskId))
  const inventoryDigest = taskInventoryDigest(frozenInventory)
  const merkleRoot = merkle([
    JSON.stringify([
      SPLIT_COMMITMENT_DOMAIN,
      2,
      seedCommitment,
      inventoryDigest,
      frozenSizes.devObserved,
      frozenSizes.devGuard,
      frozenSizes.sealed,
    ]),
    ...canonicalAssignment.map((entry) => JSON.stringify([entry.taskId, entry.label])),
  ])
  return {
    schemaVersion: 2,
    sizes: frozenSizes,
    seedCommitment,
    taskInventoryDigest: inventoryDigest,
    merkleRoot,
  }
}

/** Verify a later-revealed assignment against the exact trusted inventory. */
export function verifySplit(
  commitment: SplitCommitment,
  assignment: readonly SplitAssignment[],
  expectedTaskIds: readonly string[],
): boolean {
  try {
    if (commitment.schemaVersion !== 2 || !digestPattern.test(commitment.taskInventoryDigest)) {
      return false
    }
    const recomputed = commitSplit(
      assignment,
      commitment.seedCommitment,
      expectedTaskIds,
      commitment.sizes,
    )
    return (
      recomputed.taskInventoryDigest === commitment.taskInventoryDigest &&
      recomputed.merkleRoot === commitment.merkleRoot
    )
  } catch {
    return false
  }
}

function merkle(leaves: string[]): string {
  if (leaves.length === 0) return sha256('empty-split')
  let layer = leaves.map((leaf) => sha256(`split-leaf:${leaf}`).slice('sha256:'.length))
  while (layer.length > 1) {
    const next: string[] = []
    for (let index = 0; index < layer.length; index += 2) {
      const left = layer[index]!
      const right = layer[index + 1] ?? left
      next.push(sha256(`split-node:${left}:${right}`).slice('sha256:'.length))
    }
    layer = next
  }
  return `sha256:${layer[0]!}`
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
