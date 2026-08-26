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

const ACTION_KINDS = new Set<ActionRecord['kind']>([
  'proposal',
  'build',
  'evaluation',
  'reveal',
  'formal',
])

const ACTION_STATUS_BY_EVENT: Record<string, ActionStatus> = {
  'action.reserved': 'RESERVED',
  'action.launched': 'LAUNCHING',
  'action.running': 'RUNNING',
  'action.collecting': 'COLLECTING',
  'action.committed': 'COMMITTED',
  'action.failed': 'FAILED',
  'action.cancelled': 'CANCELLED',
  'action.abandoned': 'ABANDONED',
}

const ACTION_TRANSITIONS: Record<ActionStatus, ReadonlySet<ActionStatus>> = {
  PLANNED: new Set(['RESERVED', 'FAILED', 'CANCELLED', 'ABANDONED']),
  RESERVED: new Set(['LAUNCHING', 'FAILED', 'CANCELLED', 'ABANDONED']),
  LAUNCHING: new Set(['RUNNING', 'COLLECTING', 'COMMITTED', 'FAILED', 'CANCELLED', 'ABANDONED']),
  RUNNING: new Set(['COLLECTING', 'COMMITTED', 'FAILED', 'CANCELLED', 'ABANDONED']),
  COLLECTING: new Set(['COMMITTED', 'FAILED', 'CANCELLED', 'ABANDONED']),
  COMMITTED: new Set(),
  FAILED: new Set(),
  CANCELLED: new Set(),
  ABANDONED: new Set(),
}

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

function payloadOf(event: JournalEvent): Record<string, unknown> {
  if (event.payload === null || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    throw new Error(`reducer: ${event.type} payload must be an object`)
  }
  return event.payload as Record<string, unknown>
}

function requiredString(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value.includes('\0')
  ) {
    throw new Error(`reducer: ${field} must be a non-empty canonical string`)
  }
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field)
}

function assertMutableRun(state: ControllerState, eventType: string): void {
  if (state.runPhase === 'TERMINAL' || state.runPhase === 'EVIDENCE_CORRUPT') {
    throw new Error(`reducer: ${eventType} cannot mutate a ${state.runPhase} run`)
  }
}

function observationKey(
  row: Pick<ObservationRecord, 'candidateId' | 'taskId' | 'attemptIndex'>,
): string {
  return canonicalJson([row.candidateId, row.taskId, row.attemptIndex])
}

function validateObservationPayload(payload: Record<string, unknown>): ObservationRecord {
  const candidateId = requiredString(payload['candidateId'], 'candidateId')
  const taskId = requiredString(payload['taskId'], 'taskId')
  const attemptIndex = payload['attemptIndex']
  if (!Number.isSafeInteger(attemptIndex) || (attemptIndex as number) < 0) {
    throw new Error('reducer: attemptIndex must be a non-negative safe integer')
  }
  const status = payload['status']
  if (status !== 'pass' && status !== 'fail' && status !== 'invalid') {
    throw new Error('reducer: observation status is invalid')
  }
  const reward = payload['reward']
  if (status === 'invalid') {
    if (reward !== null) throw new Error('reducer: invalid observation requires a null reward')
  } else if (typeof reward !== 'number' || !Number.isFinite(reward)) {
    throw new Error('reducer: pass/fail observation requires a finite reward')
  }
  return {
    candidateId,
    taskId,
    attemptIndex: attemptIndex as number,
    status,
    reward: reward as number | null,
  }
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
      if (state.runPhase !== 'GENESIS') {
        throw new Error(`reducer: run.preflight cannot follow ${state.runPhase}`)
      }
      next.runPhase = 'PREFLIGHT'
      break
    case 'run.searching':
      if (state.runPhase !== 'PREFLIGHT') {
        throw new Error(`reducer: run.searching cannot follow ${state.runPhase}`)
      }
      next.runPhase = 'SEARCHING'
      break
    case 'candidate.admitted': {
      assertMutableRun(state, event.type)
      if (
        state.candidateLocked ||
        state.runPhase === 'CANDIDATE_LOCKED' ||
        state.runPhase === 'SEALED_REVEALED'
      ) {
        throw new Error('reducer: candidate admission is closed after candidate lock')
      }
      const payload = payloadOf(event)
      const candidateId = requiredString(payload['candidateId'], 'candidateId')
      if (state.candidates[candidateId] !== undefined) {
        throw new Error(`reducer: duplicate candidate admission ${candidateId}`)
      }
      const parentValue = payload['canonicalParent']
      if (parentValue !== null && typeof parentValue !== 'string') {
        throw new Error('reducer: canonicalParent must be a candidate id or null')
      }
      const canonicalParent = parentValue as string | null
      if (canonicalParent !== null) {
        requiredString(canonicalParent, 'canonicalParent')
        if (canonicalParent === candidateId)
          throw new Error('reducer: candidate cannot parent itself')
        if (state.candidates[canonicalParent] === undefined) {
          throw new Error(`reducer: lineage parent is unknown: ${canonicalParent}`)
        }
      }
      const donorsValue = payload['donorCandidates'] ?? []
      if (!Array.isArray(donorsValue)) throw new Error('reducer: donorCandidates must be an array')
      const donorCandidates = donorsValue.map((value) => requiredString(value, 'donor candidate'))
      if (new Set(donorCandidates).size !== donorCandidates.length) {
        throw new Error('reducer: duplicate donor candidate')
      }
      for (const donorCandidate of donorCandidates) {
        if (donorCandidate === candidateId)
          throw new Error('reducer: candidate cannot donate to itself')
        if (state.candidates[donorCandidate] === undefined) {
          throw new Error(`reducer: donor candidate is unknown: ${donorCandidate}`)
        }
      }
      next.candidates[candidateId] = {
        candidateId,
        canonicalParent,
        donorCandidates,
        status: 'ADMITTED_UNEVALUATED',
      }
      break
    }
    case 'candidate.dev_observed': {
      assertMutableRun(state, event.type)
      const candidateId = requiredString(payloadOf(event)['candidateId'], 'candidateId')
      const node = state.candidates[candidateId]
      if (node === undefined) throw new Error(`reducer: unknown candidate ${candidateId}`)
      if (node.status !== 'ADMITTED_UNEVALUATED') {
        throw new Error(
          `reducer: candidate ${candidateId} cannot become DEV_OBSERVED from ${node.status}`,
        )
      }
      next.candidates[candidateId] = { ...node, status: 'DEV_OBSERVED' }
      break
    }
    case 'candidate.archived': {
      assertMutableRun(state, event.type)
      const candidateId = requiredString(payloadOf(event)['candidateId'], 'candidateId')
      const node = state.candidates[candidateId]
      if (node === undefined) throw new Error(`reducer: unknown candidate ${candidateId}`)
      if (node.status !== 'ADMITTED_UNEVALUATED' && node.status !== 'DEV_OBSERVED') {
        throw new Error(`reducer: candidate ${candidateId} cannot be archived from ${node.status}`)
      }
      next.candidates[candidateId] = { ...node, status: 'ARCHIVED' }
      break
    }
    case 'action.planned': {
      assertMutableRun(state, event.type)
      const payload = payloadOf(event)
      const actionId = requiredString(payload['actionId'], 'actionId')
      if (state.actions[actionId] !== undefined) {
        throw new Error(`reducer: duplicate action plan ${actionId}`)
      }
      const kind = payload['kind']
      if (!ACTION_KINDS.has(kind as ActionRecord['kind'])) {
        throw new Error('reducer: action.planned requires a valid kind')
      }
      const idempotencyKey = requiredString(payload['idempotencyKey'], 'idempotencyKey')
      if (payload['externalJobId'] !== undefined) {
        throw new Error('reducer: action.planned cannot assign an external job')
      }
      next.actions[actionId] = {
        actionId,
        kind: kind as ActionRecord['kind'],
        status: 'PLANNED',
        idempotencyKey,
        externalJobId: null,
      }
      break
    }
    case 'action.reserved':
    case 'action.launched':
    case 'action.running':
    case 'action.collecting':
    case 'action.committed':
    case 'action.failed':
    case 'action.cancelled':
    case 'action.abandoned': {
      assertMutableRun(state, event.type)
      const payload = payloadOf(event)
      const actionId = requiredString(payload['actionId'], 'actionId')
      const existing = state.actions[actionId]
      if (existing === undefined) throw new Error(`reducer: unknown action ${actionId}`)
      const target = ACTION_STATUS_BY_EVENT[event.type]!
      if (!ACTION_TRANSITIONS[existing.status].has(target)) {
        throw new Error(
          `reducer: action ${actionId} cannot transition ${existing.status} -> ${target}`,
        )
      }
      if (payload['kind'] !== undefined && payload['kind'] !== existing.kind) {
        throw new Error(`reducer: action ${actionId} kind is immutable`)
      }
      const incomingKey = optionalString(payload['idempotencyKey'], 'idempotencyKey')
      if (incomingKey !== undefined && incomingKey !== existing.idempotencyKey) {
        throw new Error(`reducer: action ${actionId} idempotency key changed`)
      }

      let externalJobId = existing.externalJobId
      const incomingJobId = optionalString(payload['externalJobId'], 'externalJobId')
      if (incomingJobId !== undefined) {
        if (externalJobId !== null && externalJobId !== incomingJobId) {
          throw new Error(`reducer: action ${actionId} external job id changed`)
        }
        externalJobId = incomingJobId
      }
      if (target === 'LAUNCHING' && externalJobId === null) {
        throw new Error(`reducer: launched action ${actionId} lacks an external job id`)
      }

      next.actions[actionId] = {
        ...existing,
        status: target,
        externalJobId,
      }
      break
    }
    case 'evaluation.observed': {
      assertMutableRun(state, event.type)
      const observation = validateObservationPayload(payloadOf(event))
      const candidate = state.candidates[observation.candidateId]
      if (candidate === undefined) {
        throw new Error(
          `reducer: observation references unknown candidate ${observation.candidateId}`,
        )
      }
      if (candidate.status === 'ARCHIVED' || candidate.status === 'QUARANTINED') {
        throw new Error(
          `reducer: observation references inactive candidate ${observation.candidateId}`,
        )
      }
      const key = observationKey(observation)
      if (state.observations.some((row) => observationKey(row) === key)) {
        throw new Error(`reducer: duplicate observation ${key}`)
      }
      next.observations.push(observation)
      break
    }
    case 'candidate.locked': {
      if (state.runPhase !== 'SEARCHING' || state.candidateLocked) {
        throw new Error(`reducer: candidate.locked cannot follow ${state.runPhase}`)
      }
      next.candidateLocked = true
      next.runPhase = 'CANDIDATE_LOCKED'
      break
    }
    case 'sealed.revealed': {
      if (state.runPhase !== 'CANDIDATE_LOCKED' || !state.candidateLocked) {
        throw new Error(`reducer: sealed.revealed cannot follow ${state.runPhase}`)
      }
      next.runPhase = 'SEALED_REVEALED'
      break
    }
    case 'sealed.accessed': {
      if (state.runPhase !== 'SEALED_REVEALED') {
        throw new Error('reducer: sealed data cannot be accessed before reveal')
      }
      next.sealedAccessCount += 1
      break
    }
    case 'run.terminal':
      if (
        state.runPhase === 'GENESIS' ||
        state.runPhase === 'TERMINAL' ||
        state.runPhase === 'EVIDENCE_CORRUPT'
      ) {
        throw new Error(`reducer: run.terminal cannot follow ${state.runPhase}`)
      }
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
