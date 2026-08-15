/** Crash-resumable evaluation action saga (spec 06 §§12–13). */
import { release, reserve, spend, type BudgetLedger } from '../budget/index.js'
import { readAll } from '../journal/index.js'
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
