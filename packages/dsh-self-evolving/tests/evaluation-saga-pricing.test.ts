/**
 * Unpriced-usage settlement tests (issue #108).
 *
 * A paid evaluation whose DSH usage evidence is missing, unreadable, or
 * eventless must not release its reservation as if its measured cost were
 * zero: the saga settles the FULL reservation and keeps the action
 * auditable, and the stable audit rejects any unresolved unpriced usage.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  append,
  computeTotals,
  observationPricing,
  readAll,
  recoverEvaluationAction,
  replay,
  type BudgetLedger,
  type BudgetLimits,
  type EvaluationObservation,
  type EvaluationProvider,
  type Journal,
  type JournalEvent,
} from '../src/index.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-pricing-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const LIMITS: BudgetLimits = {
  usd: 100,
  solverTokens: 1e7,
  proposerTokens: 1e7,
  taskTrials: 1000,
  proposalCalls: 100,
  wallClockSec: 57_600,
  concurrencySlots: 8,
  storageBytes: 1e11,
}

function journal(): Journal {
  return { journalDir: join(root!, 'journal'), runId: 'run-pricing', segmentMaxBytes: 1_000_000 }
}

function ledger(): BudgetLedger {
  return { ledgerPath: join(root!, 'budget.jsonl'), limits: LIMITS }
}

async function seed(j: Journal): Promise<void> {
  await append(j, { ...mk('run.preflight', {}), eventId: 'pricing:preflight' })
  await append(
    j,
    mk('candidate.admitted', { candidateId: 'baseline', canonicalParent: null }),
  )
}

function mk(type: string, payload: Record<string, unknown>): JournalEvent {
  return {
    eventId: `pricing:${type}`,
    occurredAt: '2026-08-14T00:00:00.000Z',
    type,
    causationId: 'act-pricing',
    correlationId: 'act-pricing',
    actor: 'test',
    payload,
  }
}

/**
 * Real-journal-backed service double mirroring production record semantics:
 * the underlying append does NOT dedupe by eventId.
 */
function service(j: Journal) {
  return {
    journal: j,
    async record(input: { eventId: string; type: string; payload: unknown }) {
      await append(j, {
        ...input,
        occurredAt: '2026-08-14T00:00:00.000Z',
        causationId: 'act-pricing',
        correlationId: 'act-pricing',
        actor: 'test',
        payload: input.payload as Record<string, unknown>,
      } as Parameters<typeof append>[1])
      return undefined
    },
  } as never as Parameters<typeof recoverEvaluationAction>[0]
}

function observation(overrides: Partial<EvaluationObservation>): EvaluationObservation {
  return {
    candidateId: 'baseline',
    taskId: 'task-1',
    attemptIndex: 0,
    status: 'pass',
    reward: 1,
    costUsd: 0.001,
    pricing: { state: 'priced' },
    ...overrides,
  }
}

function provider(
  rows: EvaluationObservation[],
): EvaluationProvider & { collected: () => number } {
  let collected = 0
  const providers = new Map<string, { externalJobId: string; terminal: boolean }>()
  return {
    collected: () => collected,
    async inspect(key) {
      const state = providers.get(key)
      return state === undefined
        ? { status: 'absent' }
        : { status: state.terminal ? 'terminal' : 'running', externalJobId: state.externalJobId }
    },
    async launch(key) {
      const state = { externalJobId: `job-${key.slice(-8)}`, terminal: true }
      providers.set(key, state)
      return { externalJobId: state.externalJobId }
    },
    async collect() {
      collected += 1
      return rows[Math.min(collected - 1, rows.length - 1)]!
    },
  }
}

const SPEC = { actionId: 'act-pricing', idempotencyKey: 'run/eval/1', reserveUsd: 0.5 }

describe('unpriced usage settlement (issue #108)', () => {
  it('settles an unpriced evaluation at the full reservation, not a measured zero', async () => {
    const j = journal()
    await seed(j)
    const result = await recoverEvaluationAction(
      service(j),
      { ...SPEC, budgetLedger: ledger() },
      provider([
        observation({
          costUsd: 0,
          pricing: { state: 'unknown', reason: 'DSH usage evidence missing' },
        }),
      ]),
    )
    expect(result.status).toBe('committed')
    const totals = await computeTotals(ledger())
    expect(totals.totals.spent.usd).toBe(SPEC.reserveUsd)
    expect(totals.totals.reserved.usd).toBe(0)
    const events = await readAll(j)
    const observed = events.find((event) => event.type === 'evaluation.observed')
    expect(observationPricing(observed?.payload as unknown as EvaluationObservation)).toMatchObject(
      { state: 'unknown' },
    )
  })

  it('treats a pre-#108 observation without pricing state as unknown and settles fully', async () => {
    const j = journal()
    await seed(j)
    const legacy = observation()
    delete (legacy as { pricing?: unknown }).pricing
    const result = await recoverEvaluationAction(
      service(j),
      { ...SPEC, budgetLedger: ledger() },
      provider([legacy]),
    )
    expect(result.status).toBe('committed')
    expect((await computeTotals(ledger())).totals.spent.usd).toBe(SPEC.reserveUsd)
  })

  it('downgrades a priced claim with non-finite cost to unknown', () => {
    // Non-finite costs are refused by journal canonicalization before they can
    // be recorded; observationPricing still downgrades them defensively.
    expect(
      observationPricing(observation({ costUsd: Number.NaN, pricing: { state: 'priced' } })),
    ).toMatchObject({ state: 'unknown' })
    expect(
      observationPricing(observation({ costUsd: Number.POSITIVE_INFINITY })),
    ).toMatchObject({ state: 'unknown' })
  })

  it('settles a priced evaluation at its measured cost exactly as before', async () => {
    const j = journal()
    await seed(j)
    const result = await recoverEvaluationAction(
      service(j),
      { ...SPEC, budgetLedger: ledger() },
      provider([observation({ costUsd: 0.001 })]),
    )
    expect(result.status).toBe('committed')
    const totals = await computeTotals(ledger())
    expect(totals.totals.spent.usd).toBe(0.001)
    // The remainder is released, so nothing stays reserved in either case;
    // the difference is what was spent (measured vs full reservation).
    expect(totals.totals.reserved.usd).toBe(0)
  })

  it('reservation settlement stays idempotent across a crash-resume of an unpriced action', async () => {
    const j = journal()
    await seed(j)
    const prov = provider([
      observation({
        costUsd: 0,
        pricing: { state: 'unknown', reason: 'DSH session log corrupt' },
      }),
    ])
    await recoverEvaluationAction(service(j), { ...SPEC, budgetLedger: ledger() }, prov)
    const afterFirst = await computeTotals(ledger())
    // Resume the committed action: no double spend, no re-collect.
    const resumed = await recoverEvaluationAction(
      service(j),
      { ...SPEC, budgetLedger: ledger() },
      prov,
    )
    expect(resumed.status).toBe('committed')
    expect(prov.collected()).toBe(1)
    const afterSecond = await computeTotals(ledger())
    expect(afterSecond.totals.spent.usd).toBe(afterFirst.totals.spent.usd)
    expect(afterSecond.totals.spent.usd).toBe(SPEC.reserveUsd)
  })

  it('observationPricing preserves a recorded unknown reason and rejects malformed states', () => {
    expect(
      observationPricing(
        observation({ pricing: { state: 'unknown', reason: 'two session logs' } }),
      ),
    ).toEqual({ state: 'unknown', reason: 'two session logs' })
    expect(observationPricing(observation({ pricing: {} as never }))).toEqual({
      state: 'unknown',
      reason: 'pricing state absent or invalid in recorded observation',
    })
    expect(observationPricing(observation({ pricing: { state: 'other' } as never }))).toMatchObject(
      { state: 'unknown' },
    )
    expect(observationPricing(observation({ costUsd: -1 }))).toMatchObject({ state: 'unknown' })
  })

  it('a settled unpriced action leaves no live reservation in reducer state', async () => {
    const j = journal()
    await seed(j)
    await recoverEvaluationAction(
      service(j),
      { ...SPEC, budgetLedger: ledger() },
      provider([
        observation({ costUsd: 0, pricing: { state: 'unknown', reason: 'no usage events' } }),
      ]),
    )
    const state = replay(await readAll(j))
    expect(state.actions['act-pricing']?.status).toBe('COMMITTED')
    expect(state.actions['act-pricing']?.externalJobId).toBeTruthy()
  })
})
