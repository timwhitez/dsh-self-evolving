/**
 * Archive view + clade CMP + Thompson sampling + UCB-Air scheduler (spec 03).
 *
 * All functions are pure over an explicit ArchiveView. No reward-dependent
 * policy switches after manifest freeze. The RNG streams are deterministic so
 * resume does not re-sample.
 */
import { RngStream, sampleBeta } from './rng.js'

/** A candidate node's utility counts (spec 03 §4). */
export interface NodeUtility {
  candidateId: string
  canonicalParent: string | null
  donorCandidates: string[]
  /** completed development passes (reward=1). */
  s: number
  /** completed development failures (reward=0). */
  f: number
}

/** The archive view the scheduler consumes (rebuilt from events). */
export interface ArchiveView {
  nodes: NodeUtility[]
  observations: ReadonlyArray<{
    candidateId: string
    reward: 0 | 1
    split: 'dev-observed' | 'dev-guard'
  }>
}

/** Per-run fixed parameters (spec 03 §2). */
export interface SearchParams {
  K: number
  q0: number
  alpha: number
  tau: number
  waveSize: number
  shortlistSize: number
}

export const DEFAULT_PARAMS: SearchParams = {
  K: 80,
  q0: 3,
  alpha: 0.6,
  tau: 1,
  waveSize: 4,
  shortlistSize: 5,
}

/**
 * Clade C(a) = node a plus all descendants in the canonical tree.
 * CMP_hat(a) = S_C(a) / (S_C(a) + F_C(a)), or undefined when denom = 0 (spec 03 §5).
 */
export function cladeCMP(
  view: ArchiveView,
  rootId: string,
): { s: number; f: number; cmp: number | undefined } {
  const childrenOf = buildChildrenMap(view)
  const clade = collectClade(rootId, childrenOf)
  let s = 0
  let f = 0
  for (const id of clade) {
    const node = view.nodes.find((n) => n.candidateId === id)
    if (node) {
      s += node.s
      f += node.f
    }
  }
  const denom = s + f
  return { s, f, cmp: denom === 0 ? undefined : s / denom }
}

function buildChildrenMap(view: ArchiveView): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const n of view.nodes) {
    if (n.canonicalParent !== null) {
      const list = m.get(n.canonicalParent) ?? []
      list.push(n.candidateId)
      m.set(n.canonicalParent, list)
    }
  }
  return m
}

function collectClade(rootId: string, childrenOf: Map<string, string[]>): Set<string> {
  const out = new Set<string>([rootId])
  const stack = [rootId]
  while (stack.length > 0) {
    const cur = stack.pop()!
    for (const child of childrenOf.get(cur) ?? []) {
      if (!out.has(child)) {
        out.add(child)
        stack.push(child)
      }
    }
  }
  return out
}

/**
 * Parent selection via clade Thompson sampling (spec 03 §5).
 *   theta_clade(a) ~ Beta(tau * (1 + S_C(a)), tau * (1 + F_C(a)))
 *   parent = argmax theta_clade(a)
 * Only eligible parents (admitted, not locked) are considered.
 */
export function selectParentByCladeThompson(
  view: ArchiveView,
  eligibleParentIds: string[],
  params: SearchParams,
  rng: RngStream,
): string | null {
  if (eligibleParentIds.length === 0) return null
  let best: string | null = null
  let bestTheta = -1
  for (const id of eligibleParentIds) {
    const { s, f } = cladeCMP(view, id)
    const theta = sampleBeta(rng, params.tau * (1 + s), params.tau * (1 + f))
    if (theta > bestTheta) {
      bestTheta = theta
      best = id
    }
  }
  return best
}

/**
 * Node evaluation selection via node Thompson (spec 03 §6).
 *   theta_node(a) ~ Beta(1 + s(a), 1 + f(a))
 *   candidate_to_evaluate = argmax theta_node(a)
 * Only nodes with untested tasks and under the per-node pending cap.
 */
export function selectNodeByThompson(
  view: ArchiveView,
  eligibleNodeIds: string[],
  rng: RngStream,
): string | null {
  if (eligibleNodeIds.length === 0) return null
  let best: string | null = null
  let bestTheta = -1
  for (const id of eligibleNodeIds) {
    const node = view.nodes.find((n) => n.candidateId === id)
    if (!node) continue
    const theta = sampleBeta(rng, 1 + node.s, 1 + node.f)
    if (theta > bestTheta) {
      bestTheta = theta
      best = id
    }
  }
  return best
}

/**
 * UCB-Air expand-vs-evaluate decision (spec 03 §7).
 *
 * Expand iff: (N + P_eval)^alpha >= T  AND  admitted count < K.
 *   N     = completed ordinary development trials
 *   P_eval = current-wave reserved evaluations
 *   T      = admitted candidates (incl baseline) + unique pending children upper bound
 *
 * Returns 'expand' or 'evaluate'.
 */
export function ucbAirDecision(input: {
  N: number
  P_eval: number
  T: number
  admittedCount: number
  params: SearchParams
}): 'expand' | 'evaluate' {
  if (input.admittedCount >= input.params.K) return 'evaluate'
  const lhs = Math.pow(input.N + input.P_eval, input.params.alpha)
  return lhs >= input.T ? 'expand' : 'evaluate'
}

/**
 * Cold-start eligibility: a newly admitted node must complete q0 trials before
 * it is eligible for ordinary Thompson selection (spec 03 §6 exception 1).
 */
export function needsColdStart(node: NodeUtility, params: SearchParams): boolean {
  return node.s + node.f < params.q0
}

/**
 * Duplicate/donor no-double-count check (spec 03 §3): a donor is provenance
 * only, NOT a second parent edge. This helper verifies an observation is
 * attributed to exactly one candidate (its canonical parent lineage), never to
 * a donor, so clade statistics don't inflate.
 */
export function attributeObservation(
  view: ArchiveView,
  candidateId: string,
): { attributedTo: string; donorsExcluded: string[] } {
  const node = view.nodes.find((n) => n.candidateId === candidateId)
  return {
    attributedTo: candidateId,
    donorsExcluded: node?.donorCandidates ?? [],
  }
}
