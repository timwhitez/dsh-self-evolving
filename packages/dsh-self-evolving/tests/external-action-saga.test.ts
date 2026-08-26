/**
 * External-action saga contracts (issues #53 / #45).
 *
 * Proposal/build capabilities run under the same durable-intent lifecycle as
 * evaluations: PLANNED → RESERVED (before any external effect) → effect →
 * LAUNCHED → COMMITTED. A crash between the effect and the commit reconciles
 * from the semantic completion record without re-invoking the capability; a
 * committed action fast-paths to its recorded result; conflicting idempotency
 * keys fail closed.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { append, readAll, type Journal, type JournalEvent } from '../src/index.js'
import {
  failExternalAction,
  recoverExternalAction,
  type ExternalActionService,
} from '../src/index.js'

let root: string | undefined
let journal: Journal | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'external-action-saga-'))
  journal = {
    journalDir: join(root, 'journal'),
    runId: 'run-external-saga',
    segmentMaxBytes: 1_000_000,
  }
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function mk(type: string, payload: Record<string, unknown>): JournalEvent {
  return {
    eventId: `seed-${type}-${Math.random().toString(36).slice(2, 8)}`,
    occurredAt: '2026-08-27T00:00:00.000Z',
    type,
    causationId: 'seed',
    correlationId: 'seed',
    actor: 'test',
    payload,
  } as JournalEvent
}

/** Real-journal-backed service double; recordOnce semantics via append-once eventIds. */
function service(): ExternalActionService & { recorded: string[] } {
  const recorded: string[] = []
  return {
    journal: journal!,
    async record(input) {
      const existing = (await readAll(journal!)).find((event) => event.eventId === input.eventId)
      if (existing !== undefined) return undefined
      recorded.push(input.eventId)
      await append(journal!, input as Parameters<typeof append>[1])
      return undefined
    },
    recorded,
  }
}

const spec = {
  actionId: 'proposal:1:1',
  kind: 'proposal' as const,
  idempotencyKey: 'run/proposal/1/1/parent',
  externalJobId: '/state/artifacts/proposal-1-1',
}

function seeded(): Promise<void> {
  return append(journal!, mk('run.preflight', {})).then(() => undefined)
}

describe('recoverExternalAction', () => {
  it('plans, reserves, runs the effect once and commits with the artifact identity', async () => {
    await seeded()
    const svc = service()
    let calls = 0
    const result = await recoverExternalAction(
      svc,
      spec,
      async () => {
        calls += 1
        return { value: 'p1' }
      },
      async () => undefined,
    )
    expect(result).toEqual({ value: 'p1' })
    expect(calls).toBe(1)
    const events = await readAll(journal!)
    expect(events.map((event) => event.type)).toContain('action.planned')
    expect(events.map((event) => event.type)).toContain('action.reserved')
    expect(events.map((event) => event.type)).toContain('action.launched')
    expect(events.map((event) => event.type)).toContain('action.committed')
    const launched = events.find((event) => event.type === 'action.launched')!
    expect((launched.payload as { externalJobId: string }).externalJobId).toBe(spec.externalJobId)
  })

  it('fast-paths a committed action to the reconciled result without re-invoking', async () => {
    await seeded()
    const svc = service()
    let calls = 0
    const first = await recoverExternalAction(
      svc,
      spec,
      async () => {
        calls += 1
        return { value: 'p1' }
      },
      async () => (calls === 0 ? undefined : { value: 'p1' }),
    )
    expect(first).toEqual({ value: 'p1' })
    const before = (await readAll(journal!)).length
    const second = await recoverExternalAction(
      svc,
      spec,
      async () => {
        calls += 1
        return { value: 'DIFFERENT' }
      },
      async () => ({ value: 'p1' }),
    )
    expect(second).toEqual({ value: 'p1' })
    expect(calls).toBe(1)
    // Fast path writes nothing new.
    expect((await readAll(journal!)).length).toBe(before)
  })

  it('reconciles a crash between the effect and the commit without re-invoking', async () => {
    await seeded()
    const svc = service()
    // Simulate: durable intent recorded, effect completed its semantic record
    // externally, process died before launched/committed.
    await svc.record({
      eventId: `${spec.actionId}:planned`,
      occurredAt: '2026-08-27T00:00:00.000Z',
      type: 'action.planned',
      causationId: spec.actionId,
      correlationId: spec.actionId,
      actor: 'test',
      payload: { actionId: spec.actionId, kind: spec.kind, idempotencyKey: spec.idempotencyKey },
    } as never)
    await svc.record({
      eventId: `${spec.actionId}:reserved`,
      occurredAt: '2026-08-27T00:00:00.000Z',
      type: 'action.reserved',
      causationId: spec.actionId,
      correlationId: spec.actionId,
      actor: 'test',
      payload: { actionId: spec.actionId, idempotencyKey: spec.idempotencyKey },
    } as never)
    let calls = 0
    const resumed = await recoverExternalAction(
      svc,
      spec,
      async () => {
        calls += 1
        return { value: 'SHOULD-NOT-RUN' }
      },
      async () => ({ value: 'p1' }),
    )
    expect(resumed).toEqual({ value: 'p1' })
    expect(calls).toBe(0)
    const events = await readAll(journal!)
    expect(events.some((event) => event.type === 'action.committed')).toBe(true)
  })

  it('fails closed on a conflicting idempotency key for the same action', async () => {
    await seeded()
    const svc = service()
    await recoverExternalAction(
      svc,
      spec,
      async () => ({ value: 'p1' }),
      async () => undefined,
    )
    await expect(
      recoverExternalAction(
        svc,
        { ...spec, idempotencyKey: 'run/proposal/1/1/OTHER-PARENT' },
        async () => ({ value: 'x' }),
        async () => undefined,
      ),
    ).rejects.toThrow(/conflicting idempotency key/)
  })

  it('failExternalAction marks a rejected attempt terminal without double-failing', async () => {
    await seeded()
    const svc = service()
    await svc.record({
      eventId: `${spec.actionId}:planned`,
      occurredAt: '2026-08-27T00:00:00.000Z',
      type: 'action.planned',
      causationId: spec.actionId,
      correlationId: spec.actionId,
      actor: 'test',
      payload: { actionId: spec.actionId, kind: spec.kind, idempotencyKey: spec.idempotencyKey },
    } as never)
    await failExternalAction(svc, spec.actionId)
    await failExternalAction(svc, spec.actionId) // idempotent
    const events = await readAll(journal!)
    expect(events.filter((event) => event.type === 'action.failed')).toHaveLength(1)
  })
})
