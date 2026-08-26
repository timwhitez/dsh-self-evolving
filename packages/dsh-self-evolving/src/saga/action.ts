/** Crash-resumable evaluation action saga (spec 06 §§12–13). */
import { release, reserve, spend, type BudgetLedger } from '../budget/index.js'
import { readAll, type Journal } from '../journal/index.js'
import { replay } from '../reducer/index.js'
import type { RecordInput, SelfEvolvingService } from '../service.js'

export type DurableBoundary = 'intent' | 'launch' | 'collect' | 'commit'

export interface EvaluationObservation {
  candidateId: string
  taskId: string
  attemptIndex: number
  status: 'pass' | 'fail' | 'invalid'
  reward: number | null
  costUsd: number
}

export interface ProviderInspection {
  status: 'absent' | 'running' | 'terminal'
  externalJobId?: string
}

export interface EvaluationProvider {
  inspect(idempotencyKey: string): Promise<ProviderInspection>
  launch(idempotencyKey: string): Promise<{ externalJobId: string }>
  collect(externalJobId: string): Promise<EvaluationObservation>
}

export interface EvaluationActionSpec {
  actionId: string
  idempotencyKey: string
  reserveUsd: number
  budgetLedger: BudgetLedger
}

export type EvaluationActionResult =
  | { status: 'pending'; externalJobId: string }
  | { status: 'committed'; externalJobId: string; observation: EvaluationObservation }

export interface SagaHooks {
  /** Fault-injection/observability hook called only after the named durable boundary. */
  onDurableBoundary?: (boundary: DurableBoundary) => void | Promise<void>
}

function eventInput<P>(actionId: string, type: string, payload: P): RecordInput<P> {
  return {
    eventId: `${actionId}:${type}`,
    occurredAt: new Date().toISOString(),
    type,
    causationId: actionId,
    correlationId: actionId,
    actor: 'dsh-self-evolving-controller',
    payload,
  }
}

/**
 * Advance one action as far as the provider's current state permits. Every
 * external launch is preceded by durable intent and reconciled by key before
 * submit. Observation and cost settlement are independently idempotent.
 */
export async function recoverEvaluationAction(
  service: SelfEvolvingService,
  spec: EvaluationActionSpec,
  provider: EvaluationProvider,
  hooks: SagaHooks = {},
): Promise<EvaluationActionResult> {
  let events = await readAll(service.journal)
  let state = replay(events)
  let action = state.actions[spec.actionId]

  if (action === undefined) {
    await service.record(
      eventInput(spec.actionId, 'action.planned', {
        actionId: spec.actionId,
        kind: 'evaluation',
        idempotencyKey: spec.idempotencyKey,
      }),
    )
    action = replay(await readAll(service.journal)).actions[spec.actionId]
  }
  if (action === undefined) throw new Error('PROTOCOL_INVALID: planned action missing after commit')
  if (action.idempotencyKey !== spec.idempotencyKey) {
    throw new Error(`PROTOCOL_INVALID: conflicting idempotency key for ${spec.actionId}`)
  }

  if (action.status === 'PLANNED') {
    await reserve(spec.budgetLedger, spec.actionId, 'usd', spec.reserveUsd)
    await service.record(
      eventInput(spec.actionId, 'action.reserved', {
        actionId: spec.actionId,
        idempotencyKey: spec.idempotencyKey,
      }),
    )
    await hooks.onDurableBoundary?.('intent')
    action = replay(await readAll(service.journal)).actions[spec.actionId]!
  }

  let externalJobId = action.externalJobId
  if (externalJobId === null) {
    const inspected = await provider.inspect(spec.idempotencyKey)
    if (inspected.status === 'absent') {
      externalJobId = (await provider.launch(spec.idempotencyKey)).externalJobId
    } else {
      externalJobId = inspected.externalJobId ?? null
      if (externalJobId === null) {
        throw new Error('PROTOCOL_INVALID: provider inspection omitted external job id')
      }
    }
    await service.record(
      eventInput(spec.actionId, 'action.launched', {
        actionId: spec.actionId,
        externalJobId,
      }),
    )
    await hooks.onDurableBoundary?.('launch')
  }

  events = await readAll(service.journal)
  state = replay(events)
  action = state.actions[spec.actionId]!
  externalJobId = action.externalJobId
  if (externalJobId === null) throw new Error('PROTOCOL_INVALID: launched action has no job id')

  const observedEvent = events.find(
    (event) => event.type === 'evaluation.observed' && event.causationId === spec.actionId,
  )
  let observation = observedEvent?.payload as EvaluationObservation | undefined
  if (observation === undefined) {
    const inspected = await provider.inspect(spec.idempotencyKey)
    if (inspected.status === 'absent') {
      throw new Error('PROTOCOL_INVALID: provider lost a durably launched job')
    }
    if (inspected.externalJobId !== undefined && inspected.externalJobId !== externalJobId) {
      throw new Error('PROTOCOL_INVALID: provider job id changed during reconciliation')
    }
    if (inspected.status === 'running') return { status: 'pending', externalJobId }

    if (action.status !== 'COLLECTING') {
      await service.record(
        eventInput(spec.actionId, 'action.collecting', {
          actionId: spec.actionId,
          externalJobId,
        }),
      )
    }
    observation = await provider.collect(externalJobId)
    await service.record(eventInput(spec.actionId, 'evaluation.observed', observation))
  }

  if (observation.costUsd > spec.reserveUsd) {
    throw new Error('PROTOCOL_INVALID: actual cost exceeds the durable reservation')
  }
  await spend(spec.budgetLedger, spec.actionId, 'usd', observation.costUsd)
  await release(spec.budgetLedger, spec.actionId, 'usd', spec.reserveUsd - observation.costUsd)
  await hooks.onDurableBoundary?.('collect')

  state = replay(await readAll(service.journal))
  if (state.actions[spec.actionId]?.status !== 'COMMITTED') {
    await service.record(
      eventInput(spec.actionId, 'action.committed', {
        actionId: spec.actionId,
        externalJobId,
      }),
    )
    await hooks.onDurableBoundary?.('commit')
  }
  return { status: 'committed', externalJobId, observation }
}

/** Minimal service surface the external-action saga depends on. */
export interface ExternalActionService {
  journal: Journal
  record<P = Record<string, unknown>>(input: RecordInput<P>): Promise<unknown>
}

export interface ExternalActionSpec {
  actionId: string
  kind: 'proposal' | 'build'
  /** Stable logical identity of the external work; bound into the durable intent. */
  idempotencyKey: string
  /** Deterministic durable identity of the external artifact (path or digest). */
  externalJobId: string
}

/**
 * Durable-intent wrapper for proposal/build side effects (issue #53).
 *
 * Unified exactly-once lifecycle for non-evaluation capabilities:
 *   PLANNED → RESERVED (durable intent, BEFORE any external effect) →
 *   external effect → LAUNCHED (artifact identity) → COMMITTED.
 *
 * Reconcile-before-retry: a crash between the external effect and the journal
 * commit is detected through the caller's semantic completion record
 * (`reconcile`), re-committing from that record WITHOUT re-invoking the paid
 * capability. A committed action fast-paths straight to the recorded result.
 * The capability itself must still key its artifacts by `idempotencyKey` so a
 * crash before the semantic record falls back to capability-level dedupe.
 */
export async function recoverExternalAction<T>(
  service: ExternalActionService,
  spec: ExternalActionSpec,
  effect: () => Promise<T>,
  reconcile: () => Promise<T | undefined>,
): Promise<T> {
  await recordExternal(service, `${spec.actionId}:planned`, 'action.planned', {
    actionId: spec.actionId,
    kind: spec.kind,
    idempotencyKey: spec.idempotencyKey,
  })
  const action = replay(await readAll(service.journal)).actions[spec.actionId]
  if (action === undefined) {
    throw new Error(`PROTOCOL_INVALID: planned action missing ${spec.actionId}`)
  }
  if (action.idempotencyKey !== spec.idempotencyKey) {
    throw new Error(`PROTOCOL_INVALID: conflicting idempotency key for ${spec.actionId}`)
  }
  if (action.status === 'COMMITTED') {
    const recorded = await reconcile()
    if (recorded === undefined) {
      throw new Error(
        `PROTOCOL_INVALID: committed action lacks a reconcilable result ${spec.actionId}`,
      )
    }
    return recorded
  }
  // Crash window between the external effect and the journal commit.
  const preCompleted = await reconcile()
  if (preCompleted !== undefined) {
    await recordExternal(service, `${spec.actionId}:launched`, 'action.launched', {
      actionId: spec.actionId,
      externalJobId: spec.externalJobId,
    })
    await recordExternal(service, `${spec.actionId}:committed`, 'action.committed', {
      actionId: spec.actionId,
      externalJobId: spec.externalJobId,
    })
    return preCompleted
  }
  if (action.status === 'PLANNED') {
    await recordExternal(service, `${spec.actionId}:reserved`, 'action.reserved', {
      actionId: spec.actionId,
      idempotencyKey: spec.idempotencyKey,
    })
  }
  const result = await effect()
  await recordExternal(service, `${spec.actionId}:launched`, 'action.launched', {
    actionId: spec.actionId,
    externalJobId: spec.externalJobId,
  })
  await recordExternal(service, `${spec.actionId}:committed`, 'action.committed', {
    actionId: spec.actionId,
    externalJobId: spec.externalJobId,
  })
  return result
}

async function recordExternal<P>(
  service: ExternalActionService,
  eventId: string,
  type: string,
  payload: P,
): Promise<void> {
  const existing = (await readAll(service.journal)).find((event) => event.eventId === eventId)
  if (existing !== undefined) return
  await service.record(eventInput(eventId, type, payload))
}

/** Mark an external action terminally FAILED after a rejected effect. */
export async function failExternalAction(
  service: ExternalActionService,
  actionId: string,
): Promise<void> {
  const action = replay(await readAll(service.journal)).actions[actionId]
  if (action === undefined || action.status === 'COMMITTED' || action.status === 'FAILED') return
  await recordExternal(service, `${actionId}:failed`, 'action.failed', { actionId })
}
