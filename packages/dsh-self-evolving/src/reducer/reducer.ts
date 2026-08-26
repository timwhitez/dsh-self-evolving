/**
 * Pure state reducer (spec 06 §5).
 *
 *   State_(n+1) = reduce(State_n, Event_(n+1))
 *
 * The reducer is a pure function: it does NOT read network, current time, RNG,
 * or arbitrary filesystem. Every fact it needs is in the event payload or object
 * ref. Wall-clock `occurredAt` is audit-only and never drives decisions.
 *
 * State tracks: run phase, candidate statuses + lineage, observations, pending/
 * reserved actions, budget totals, external job mappings, locks. A canonical
 * state hash lets us prove full-replay == snapshot-resume.
 */
import { canonicalJson } from '../journal/index.js'
import { createHash } from 'node:crypto'
import type { JournalEvent } from '../journal/index.js'

export type RunPhase =
  | 'GENESIS'
  | 'PREFLIGHT'
  | 'SEARCHING'
  | 'CANDIDATE_LOCKED'
  | 'SEALED_REVEALED'
  | 'TERMINAL'
  | 'EVIDENCE_CORRUPT'

export type CandidateStatus = 'ADMITTED_UNEVALUATED' | 'DEV_OBSERVED' | 'ARCHIVED' | 'QUARANTINED'

export type ActionStatus =
  | 'PLANNED'
  | 'RESERVED'
  | 'LAUNCHING'
  | 'RUNNING'
  | 'COLLECTING'
  | 'COMMITTED'
  | 'FAILED'
  | 'CANCELLED'
  | 'ABANDONED'

export interface CandidateNode {
  candidateId: string
  canonicalParent: string | null
  donorCandidates: string[]
  status: CandidateStatus
}

export interface ActionRecord {
  actionId: string
  kind: 'proposal' | 'build' | 'evaluation' | 'reveal' | 'formal'
  status: ActionStatus
  idempotencyKey: string
  externalJobId: string | null
}

export interface ObservationRecord {
  candidateId: string
  taskId: string
  attemptIndex: number
  status: 'pass' | 'fail' | 'invalid'
  reward: number | null
}

export interface ControllerState {
  reducerVersion: 1
  runPhase: RunPhase
  lastSeq: number
  lastEventHash: string | null
  candidates: Record<string, CandidateNode>
  actions: Record<string, ActionRecord>
  observations: ObservationRecord[]
  /** Whether the candidate has been locked (selector/proposer permanently refused). */
  candidateLocked: boolean
  /** Sealed store access count before reveal (must be 0). */
  sealedAccessCount: number
}

export type LogicalControllerState = Omit<ControllerState, 'lastSeq' | 'lastEventHash'>

export function genesisState(): ControllerState {
  return {
    reducerVersion: 1,
    runPhase: 'GENESIS',
    lastSeq: 0,
    lastEventHash: null,
    candidates: {},
    actions: {},
    observations: [],
    candidateLocked: false,
    sealedAccessCount: 0,
  }
}

function compareObservations(left: ObservationRecord, right: ObservationRecord): number {
  const leftKey = canonicalJson(left)
  const rightKey = canonicalJson(right)
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
}

/**
 * Apply one event to the state. Pure — returns a NEW state object.
 * Throws on a reducer-version mismatch or an event that violates invariants.
 */
export function reduce(state: ControllerState, event: JournalEvent): ControllerState {
  if (state.reducerVersion !== 1) throw new Error('reducer: unsupported reducerVersion')
  const next: ControllerState = {
    ...state,
    candidates: { ...state.candidates },
    actions: { ...state.actions },
    observations: [...state.observations],
  }
  next.lastSeq = event.seq
  next.lastEventHash = event.eventHash

  switch (event.type) {
    case 'run.preflight':
      next.runPhase = 'PREFLIGHT'
      break
    case 'run.searching':
      next.runPhase = 'SEARCHING'
      break
    case 'candidate.admitted': {
      const p = event.payload as {
        candidateId: string
        canonicalParent: string | null
        donorCandidates?: string[]
      }
      next.candidates[p.candidateId] = {
        candidateId: p.candidateId,
        canonicalParent: p.canonicalParent,
        donorCandidates: p.donorCandidates ?? [],
        status: 'ADMITTED_UNEVALUATED',
      }
      break
    }
    case 'candidate.dev_observed': {
      const p = event.payload as { candidateId: string }
      const node = next.candidates[p.candidateId]
      if (node) next.candidates[p.candidateId] = { ...node, status: 'DEV_OBSERVED' }
      break
    }
    case 'candidate.archived': {
      const p = event.payload as { candidateId: string }
      const node = next.candidates[p.candidateId]
      if (node) next.candidates[p.candidateId] = { ...node, status: 'ARCHIVED' }
      break
    }
    case 'action.planned':
    case 'action.reserved':
    case 'action.launched':
    case 'action.running':
    case 'action.collecting':
    case 'action.committed':
    case 'action.failed':
    case 'action.cancelled':
    case 'action.abandoned': {
      const p = event.payload as {
        actionId: string
        kind?: ActionRecord['kind']
        idempotencyKey?: string
        externalJobId?: string | null
      }
      const existing = next.actions[p.actionId]
      const statusMap: Record<string, ActionStatus> = {
        'action.planned': 'PLANNED',
        'action.reserved': 'RESERVED',
        'action.launched': 'LAUNCHING',
        'action.running': 'RUNNING',
        'action.collecting': 'COLLECTING',
        'action.committed': 'COMMITTED',
        'action.failed': 'FAILED',
        'action.cancelled': 'CANCELLED',
        'action.abandoned': 'ABANDONED',
      }
      next.actions[p.actionId] = {
        actionId: p.actionId,
        kind: existing?.kind ?? p.kind ?? 'evaluation',
        status: statusMap[event.type]!,
        idempotencyKey: existing?.idempotencyKey ?? p.idempotencyKey ?? '',
        externalJobId:
          p.externalJobId !== undefined ? p.externalJobId : (existing?.externalJobId ?? null),
      }
      break
    }
    case 'evaluation.observed': {
      const p = event.payload as {
        candidateId: string
        taskId: string
        attemptIndex: number
        status: 'pass' | 'fail' | 'invalid'
        reward: number | null
      }
      next.observations.push({
        candidateId: p.candidateId,
        taskId: p.taskId,
        attemptIndex: p.attemptIndex,
        status: p.status,
        reward: p.reward,
      })
      break
    }
    case 'candidate.locked': {
      // Once locked, selector/proposer are permanently refused.
      next.candidateLocked = true
      next.runPhase = 'CANDIDATE_LOCKED'
      break
    }
    case 'sealed.revealed': {
      next.runPhase = 'SEALED_REVEALED'
      break
    }
    case 'sealed.accessed': {
      next.sealedAccessCount += 1
      break
    }
    case 'run.terminal':
      next.runPhase = 'TERMINAL'
      break
    default:
      // Unknown event types are audit-only; do not mutate derived state.
      break
  }
  return next
}

/** Canonical exact state hash — proves full-replay == snapshot-resume. */
export function stateHash(state: ControllerState): string {
  return 'sha256:' + createHash('sha256').update(canonicalJson(state)).digest('hex')
}

/**
 * Canonical logical projection for order-independent fact comparisons.
 *
 * The exact checkpoint hash above remains bound to the real journal cursor and
 * persisted array order. This projection excludes only transport cursor fields
 * and canonicalizes observations, which are protocol facts keyed by
 * candidate/task/attempt rather than by same-wave completion time.
 */
export function logicalStateProjection(state: ControllerState): LogicalControllerState {
  return {
    reducerVersion: state.reducerVersion,
    runPhase: state.runPhase,
    candidates: state.candidates,
    actions: state.actions,
    observations: [...state.observations].sort(compareObservations),
    candidateLocked: state.candidateLocked,
    sealedAccessCount: state.sealedAccessCount,
  }
}

export function logicalStateHash(state: ControllerState): string {
  return (
    'sha256:' +
    createHash('sha256')
      .update(canonicalJson(logicalStateProjection(state)))
      .digest('hex')
  )
}

/**
 * Replay a full event sequence from genesis. Returns the final state.
 * This is the trusted path; snapshots are only an optimization.
 */
export function replay(events: JournalEvent[]): ControllerState {
  let state = genesisState()
  for (const ev of events) state = reduce(state, ev)
  return state
}
