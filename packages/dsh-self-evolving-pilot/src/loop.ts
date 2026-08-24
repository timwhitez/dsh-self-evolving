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
  selectNodeByThompson,
  needsColdStart,
  RngStream,
  attributeObservation,
} from '@dsh-self-evolving/search'

/** The capabilities the loop drives (injected for testability). */
export interface PilotCapabilities {
  /** Generate >=1 child proposal from a full canonical parent source. */
  propose: (parentDigest: string, parentSource: string) => Promise<ProposedChild[]>
  /** Build a proposed child into an admitted candidate and retain its full source. */
  build: (
    child: ProposedChild,
  ) => Promise<{ candidateId: string; digest: string; source: string } | null>
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

/** Scheduler identity plus the exact immutable source used for future expansion. */
export interface PilotNode extends NodeUtility {
  digest: string
  source: string
}

/** The pilot's archive view (node utility + canonical source identity). */
export interface PilotArchive {
  nodes: PilotNode[]
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
  /** Persisted counter for the deterministic scheduler RNG stream. */
  schedulerRngCounter: number
  duplicateEdges: number
  buildRejects: number
  evalFailures: number
  terminal: boolean
  reason: string | null
}

export function initialPilotState(
  baselineId: string,
  config: PilotConfig,
  baselineDigest: string = baselineId,
  baselineSource = '',
): PilotState {
  const baselineNode: PilotNode = {
    candidateId: baselineId,
    digest: baselineDigest,
    source: baselineSource,
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
    schedulerRngCounter: 0,
    duplicateEdges: 0,
    buildRejects: 0,
    evalFailures: 0,
    terminal: false,
    reason: null,
  }
}

/** Validate the frozen development task inventory before any external action. */
export function validateDevTaskIds(taskIds: unknown): asserts taskIds is string[] {
  if (!Array.isArray(taskIds) || taskIds.length === 0) {
    throw new Error('pilot: devTaskIds must be a non-empty array')
  }
  const seen = new Set<string>()
  for (const [index, taskId] of taskIds.entries()) {
    if (
      typeof taskId !== 'string' ||
      taskId.length === 0 ||
      taskId !== taskId.trim() ||
      taskId.includes('\0')
    ) {
      throw new Error(`pilot: devTaskIds[${index}] is not a valid non-empty task id`)
    }
    if (seen.has(taskId)) throw new Error(`pilot: duplicate development task id ${taskId}`)
    seen.add(taskId)
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

function resolveParent(archive: PilotArchive, candidateId: string): PilotNode {
  const parent = archive.nodes.find((node) => node.candidateId === candidateId)
  if (parent === undefined) {
    throw new Error(`pilot: selected parent is absent from archive: ${candidateId}`)
  }
  if (parent.digest.length === 0 || parent.source.length === 0) {
    throw new Error(`pilot: selected parent has no resolvable canonical source: ${candidateId}`)
  }
  return parent
}

function nextUntestedDevTask(
  archive: PilotArchive,
  candidateId: string,
  devTaskIds: readonly string[],
): string | null {
  const tested = new Set(
    archive.observations
      .filter((observation) => observation.candidateId === candidateId)
      .map((observation) => observation.taskId),
  )
  return devTaskIds.find((taskId) => !tested.has(taskId)) ?? null
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
  state: PilotState = initialPilotState(baselineId, config, baselineDigest, baselineSource),
): Promise<PilotState> {
  validateDevTaskIds(config.devTaskIds)
  // PilotConfig predates SearchParams.K. Treat the explicit pilot K as the
  // single source of truth so a profile default cannot terminate a custom run.
  const params: SearchParams = { ...config.params, K: config.K }
  // Hard iteration cap as a liveness guard; a healthy run terminates via K or
  // B_eval. This prevents an infinite loop if the scheduler/deps misbehave.
  const MAX_ITERATIONS = config.K * 50 + config.B_eval + 100
  const maxRngCounter = MAX_ITERATIONS * Math.max(config.K, state.archive.nodes.length, 1)
  if (
    !Number.isSafeInteger(state.schedulerRngCounter) ||
    state.schedulerRngCounter < 0 ||
    state.schedulerRngCounter > maxRngCounter
  ) {
    throw new Error('pilot: invalid scheduler RNG counter')
  }
  const rng = new RngStream(config.masterSeed, 'pilot-scheduler')
  for (let counter = 0; counter < state.schedulerRngCounter; counter += 1) rng.nextU64()
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
      params,
    })
    if (decision === 'expand') {
      // Pick a parent via clade Thompson.
      const eligibleParents = state.archive.nodes.map((n) => n.candidateId)
      const parentId = selectParentByCladeThompson(
        toArchiveView(state.archive),
        eligibleParents,
        params,
        rng,
      )
      state.schedulerRngCounter = rng.currentCounter()
      if (parentId === null) {
        state.terminal = true
        state.reason = 'NO_ELIGIBLE_PARENT'
        break
      }
      const parent = resolveParent(state.archive, parentId)
      const children = await caps.propose(parent.digest, parent.source)
      for (const child of children) {
        const built = await caps.build(child)
        if (built === null) {
          state.buildRejects += 1
          continue
        }
        if (built.digest.length === 0 || built.source.length === 0) {
          throw new Error('pilot: admitted child is missing canonical digest or source')
        }
        // Dedup is content-addressed while scheduler/evaluator identity remains candidateId.
        const existing = state.archive.nodes.find((node) => node.digest === built.digest)
        if (existing) {
          state.duplicateEdges += 1
          continue
        }
        if (state.archive.nodes.some((node) => node.candidateId === built.candidateId)) {
          throw new Error(`pilot: candidate id reused for different content: ${built.candidateId}`)
        }
        const newNode: PilotNode = {
          candidateId: built.candidateId,
          digest: built.digest,
          source: built.source,
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
      // This pilot dispatches evaluations serially, so every node is below the
      // per-node pending cap at each decision. A node is otherwise eligible
      // only while the frozen development inventory has an untested task.
      const eligible = state.archive.nodes.flatMap((node) => {
        const taskId = nextUntestedDevTask(state.archive, node.candidateId, config.devTaskIds)
        return taskId === null ? [] : [{ node, taskId }]
      })
      const coldStartNode = eligible.find(({ node }) => needsColdStart(node, params))
      const selectedNodeId =
        coldStartNode?.node.candidateId ??
        selectNodeByThompson(
          toArchiveView(state.archive),
          eligible.map(({ node }) => node.candidateId),
          rng,
        )
      state.schedulerRngCounter = rng.currentCounter()
      const selection =
        selectedNodeId === null
          ? undefined
          : eligible.find(({ node }) => node.candidateId === selectedNodeId)
      if (selection === undefined) {
        state.terminal = true
        state.reason = 'NO_ELIGIBLE_EVALUATION_NODE'
        break
      }
      const { node: evalNode, taskId } = selection
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
