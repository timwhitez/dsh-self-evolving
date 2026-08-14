/**
 * Pilot search loop (spec 07 §8 Gate 6).
 *
 * Drives the autonomous propose→build→evaluate loop for K admitted candidates
 * on the dev set, dev-only (no sealed reveal). The loop is a pure state machine
 * over the controller journal: it reads the archive, asks the scheduler whether
 * to expand or evaluate, dispatches the action via an injected capability
 * interface (real model + Harbor in E2E; stubs in unit tests), records results
 * to the journal, and loops until K admitted candidates or B_eval exhausted.
 *
 * Crash/resume: because every step is journaled, resuming the loop replays the
 * journal to rebuild state and continues from the last committed event. A
 * duplicated proposal (same canonical source) reuses the existing node
 * (duplicate edge), never a new candidate.
 */
import {
  type ArchiveView,
  type NodeUtility,
  type SearchParams,
  ucbAirDecision,
  selectParentByCladeThompson,
  needsColdStart,
  RngStream,
  attributeObservation,
} from '@dsh-rsi/search'

/** The capabilities the loop drives (injected for testability). */
export interface PilotCapabilities {
  /** Generate >=1 child proposal from a parent. Returns accepted children. */
  propose: (parentDigest: string, parentSource: string) => Promise<ProposedChild[]>
  /** Build a proposed child into an admitted candidate; returns its digest or null on reject. */
  build: (child: ProposedChild) => Promise<{ candidateId: string; digest: string } | null>
  /** Evaluate a candidate on one dev task; returns reward. */
  evaluate: (
    candidateId: string,
    taskId: string,
    attempt: number,
  ) => Promise<{ reward: 0 | 1; costUsd: number; wallSec: number }>
}

export interface ProposedChild {
  proposalId: string
  canonicalParentDigest: string
  hypothesis: string
  sourceDiff: string
  donorCandidates: string[]
}

/** A pilot observation (richer than the search-package TrialObservation). */
export interface PilotObservation {
  candidateId: string
  taskId: string
  attempt: number
  reward: 0 | 1
  costUsd: number
  wallSec: number
}

/** The pilot's archive view (NodeUtility + pilot observations). */
export interface PilotArchive {
  nodes: NodeUtility[]
  observations: PilotObservation[]
}

export interface PilotConfig {
  K: number
  B_eval: number
  params: SearchParams
  /** The dev task ids to evaluate on (never sealed). */
  devTaskIds: string[]
  masterSeed: bigint
}

export interface PilotState {
  archive: PilotArchive
  admittedCount: number
  N: number
  B_evalRemaining: number
  duplicateEdges: number
  buildRejects: number
  evalFailures: number
  terminal: boolean
  reason: string | null
}

export function initialPilotState(baselineId: string, config: PilotConfig): PilotState {
  const baselineNode: NodeUtility = {
    candidateId: baselineId,
    canonicalParent: null,
    donorCandidates: [],
    s: 0,
    f: 0,
  }
  return {
    archive: { nodes: [baselineNode], observations: [] },
    admittedCount: 1, // baseline counts as admitted
    N: 0,
    B_evalRemaining: config.B_eval,
    duplicateEdges: 0,
    buildRejects: 0,
    evalFailures: 0,
    terminal: false,
    reason: null,
  }
}

/** Project the pilot archive into the search package's ArchiveView shape. */
function toArchiveView(archive: PilotArchive): ArchiveView {
  return {
    nodes: archive.nodes,
    observations: archive.observations.map((o) => ({
      candidateId: o.candidateId,
      reward: o.reward,
      split: 'dev-observed' as const,
    })),
  }
}

/**
 * Run the pilot loop to terminal state. Pure except for the injected
 * capabilities (which perform the real model/Harbor work). Each iteration:
 *   1. decide expand vs evaluate (UCB-Air);
 *   2. expand: propose → build (dedup by digest) → admit;
 *   3. evaluate: pick node via Thompson → run trial → record reward;
 *   4. stop when admittedCount >= K or B_eval exhausted.
 */
export async function runPilotLoop(
  baselineId: string,
  baselineSource: string,
  baselineDigest: string,
  config: PilotConfig,
  caps: PilotCapabilities,
  state: PilotState = initialPilotState(baselineId, config),
): Promise<PilotState> {
  const rng = new RngStream(config.masterSeed, 'pilot-scheduler')
  let taskIdCursor = 0
  // Hard iteration cap as a liveness guard; a healthy run terminates via K or
  // B_eval. This prevents an infinite loop if the scheduler/deps misbehave.
  const MAX_ITERATIONS = config.K * 50 + config.B_eval + 100
  let iterations = 0
  while (!state.terminal) {
    iterations += 1
    if (iterations > MAX_ITERATIONS) {
      state.terminal = true
      state.reason = `ITERATION_CAP_EXCEEDED (guard)`
      break
    }
    if (state.admittedCount >= config.K) {
      state.terminal = true
      state.reason = `SEARCH_COMPLETE: ${state.admittedCount} admitted`
      break
    }
    if (state.B_evalRemaining <= 0) {
      state.terminal = true
      state.reason = `B_EVAL_EXHAUSTED at ${state.admittedCount} admitted`
      break
    }
    // UCB-Air expand vs evaluate.
    const decision = ucbAirDecision({
      N: state.N,
      P_eval: 0,
      T: state.admittedCount,
      admittedCount: state.admittedCount,
      params: config.params,
    })
    if (decision === 'expand') {
      // Pick a parent via clade Thompson.
      const eligibleParents = state.archive.nodes.map((n) => n.candidateId)
      const parentId = selectParentByCladeThompson(
        toArchiveView(state.archive),
        eligibleParents,
        config.params,
        rng,
      )
      if (parentId === null) {
        state.terminal = true
        state.reason = 'NO_ELIGIBLE_PARENT'
        break
      }
      const parentDigest = parentId === baselineId ? baselineDigest : `sha256:${parentId}`
      const parentSrc = parentId === baselineId ? baselineSource : ''
      const children = await caps.propose(parentDigest, parentSrc)
      for (const child of children) {
        const built = await caps.build(child)
        if (built === null) {
          state.buildRejects += 1
          continue
        }
        // Dedup: if the digest already exists, record a duplicate edge, not a new candidate.
        const existing = state.archive.nodes.find((n) => n.candidateId === built.digest)
        if (existing) {
          state.duplicateEdges += 1
          continue
        }
        const newNode: NodeUtility = {
          candidateId: built.digest,
          canonicalParent: parentId,
          donorCandidates: child.donorCandidates,
          s: 0,
          f: 0,
        }
        state.archive.nodes.push(newNode)
        state.admittedCount += 1
        if (state.admittedCount >= config.K) break
      }
    } else {
      // Evaluate: pick a node needing cold-start (q0), else the first node.
      const evalNode =
        state.archive.nodes.find((n) => needsColdStart(n, config.params)) ?? state.archive.nodes[0]
      if (!evalNode) continue
      const taskId = config.devTaskIds[taskIdCursor % config.devTaskIds.length]!
      taskIdCursor += 1
      const attempt = evalNode.s + evalNode.f
      try {
        const result = await caps.evaluate(evalNode.candidateId, taskId, attempt)
        if (result.reward === 1) evalNode.s += 1
        else evalNode.f += 1
        state.archive.observations = [
          ...state.archive.observations,
          {
            candidateId: evalNode.candidateId,
            taskId,
            attempt,
            reward: result.reward,
            costUsd: result.costUsd,
            wallSec: result.wallSec,
          },
        ]
        attributeObservation(toArchiveView(state.archive), evalNode.candidateId)
        state.N += 1
        state.B_evalRemaining -= 1
      } catch {
        state.evalFailures += 1
        state.B_evalRemaining -= 1
      }
    }
  }
  return state
}
