/**
 * Budget ledger tests (spec 06 §8): reserve→spend|release, worst-case bound,
 * hard-limit denial, hash chain.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  reserve,
  spend,
  release,
  computeTotals,
  worstCaseCommitted,
  type BudgetLedger,
  type BudgetLimits,
} from '../src/index.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-rsi-budget-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const LIMITS: BudgetLimits = {
  usd: 10,
  solverTokens: 1_000_000,
  proposerTokens: 500_000,
  taskTrials: 100,
  proposalCalls: 50,
  wallClockSec: 57_600,
  concurrencySlots: 4,
  storageBytes: 10_000_000_000,
}

function ledger(): BudgetLedger {
  return { ledgerPath: join(root!, 'budget-ledger.jsonl'), limits: LIMITS }
}

describe('budget ledger', () => {
  it('reserve then spend: reserved decreases, spent increases', async () => {
    const l = ledger()
    await reserve(l, 'a1', 'usd', 3)
    let { totals } = await computeTotals(l)
    expect(totals.reserved.usd).toBe(3)
    expect(totals.spent.usd).toBe(0)
    await spend(l, 'a1', 'usd', 2)
    ;({ totals } = await computeTotals(l))
    expect(totals.reserved.usd).toBe(1)
    expect(totals.spent.usd).toBe(2)
  })

  it('reserve then release: reserved returns to available', async () => {
    const l = ledger()
    await reserve(l, 'a2', 'usd', 4)
    await release(l, 'a2', 'usd', 4)
    const { totals } = await computeTotals(l)
    expect(totals.reserved.usd).toBe(0)
    expect(totals.spent.usd).toBe(0)
  })

  it('worst-case committed = spent + reserved (no oversell)', async () => {
    const l = ledger()
    await reserve(l, 'a3', 'usd', 5)
    await spend(l, 'a3', 'usd', 2)
    const { totals } = await computeTotals(l)
    const worst = worstCaseCommitted(totals)
    expect(worst.usd).toBe(5) // 3 reserved + 2 spent
  })

  it('hard-limit denial: reserve exceeding the limit throws', async () => {
    const l = ledger()
    await reserve(l, 'a4', 'usd', 8)
    // 8 reserved; worst-case 8; adding 3 more → 11 > 10 limit.
    await expect(reserve(l, 'a5', 'usd', 3)).rejects.toThrow(/hard limit exceeded/)
  })

  it('a zero-amount USD spend flags unpriced usage (never silently zero)', async () => {
    const l = ledger()
    await reserve(l, 'a6', 'usd', 2)
    await spend(l, 'a6', 'usd', 0) // unpriced
    const { totals } = await computeTotals(l)
    expect(totals.unpricedUsage).toBe(true)
  })

  it('computeTotals fails closed on a broken budget chain', async () => {
    const l = ledger()
    await reserve(l, 'a7', 'usd', 1)
    // Tamper: append a forged entry with a wrong previousHash via direct file write.
    const { appendFile } = await import('node:fs/promises')
    await appendFile(
      l.ledgerPath,
      JSON.stringify({
        seq: 99,
        kind: 'spend',
        dimension: 'usd',
        actionId: 'forged',
        amount: 5,
        at: '2026-08-14T00:00:00.000Z',
        previousHash: 'sha256:wrong',
        entryHash: 'sha256:alsowrong',
      }) + '\n',
    )
    await expect(computeTotals(l)).rejects.toThrow(/EVIDENCE_CORRUPT/)
  })
})
