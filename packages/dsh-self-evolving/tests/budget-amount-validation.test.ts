import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  computeTotals,
  release,
  reserve,
  spend,
  type BudgetEntry,
  type BudgetLedger,
  type BudgetLimits,
} from '../src/index.js'

let root: string | undefined

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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-budget-amount-validation-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function ledger(): BudgetLedger {
  return { ledgerPath: join(root!, 'budget-ledger.jsonl'), limits: { ...LIMITS } }
}

function canonicalEntry(entry: object): string {
  return JSON.stringify(entry, Object.keys(entry).sort())
}

type RawEntry = Record<string, unknown> & {
  seq: number
  previousHash: string | null
}

function chainedEntries(overrides: Array<Record<string, unknown>>): RawEntry[] {
  const entries: RawEntry[] = []
  let previousHash: string | null = null
  for (const [index, override] of overrides.entries()) {
    const withoutHash = {
      seq: index + 1,
      kind: 'reserve',
      dimension: 'usd',
      actionId: `action-${index + 1}`,
      amount: 1,
      at: '2026-08-23T00:00:00.000Z',
      previousHash,
      ...override,
    } as RawEntry
    const entryHash =
      'sha256:' + createHash('sha256').update(canonicalEntry(withoutHash)).digest('hex')
    const entry = { ...withoutHash, entryHash }
    entries.push(entry)
    previousHash = entryHash
  }
  return entries
}

async function writeEntries(entries: RawEntry[]): Promise<void> {
  await writeFile(
    ledger().ledgerPath,
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  )
}

async function expectNoLedgerMutation(operation: () => Promise<unknown>, pattern: RegExp) {
  const path = ledger().ledgerPath
  await expect(operation()).rejects.toThrow(pattern)
  expect(await stat(path).catch(() => null)).toBeNull()
  expect(await stat(`${path}.lock`).catch(() => null)).toBeNull()
}

describe('budget mutation amount validation', () => {
  const invalidAmounts = [
    { label: '-1', value: -1 },
    { label: '-0', value: -0 },
    { label: 'NaN', value: Number.NaN },
    { label: 'Infinity', value: Number.POSITIVE_INFINITY },
    { label: '-Infinity', value: Number.NEGATIVE_INFINITY },
  ]

  for (const { label, value } of invalidAmounts) {
    it(`rejects reserve amount ${label} before touching the ledger`, async () => {
      await expectNoLedgerMutation(
        () => reserve(ledger(), 'reserve-invalid', 'usd', value),
        /reserve amount.*finite non-negative/,
      )
    })

    it(`rejects spend amount ${label} before touching the ledger`, async () => {
      await expectNoLedgerMutation(
        () => spend(ledger(), 'spend-invalid', 'usd', value),
        /spend amount.*finite non-negative/,
      )
    })

    it(`rejects release amount ${label} before touching the ledger`, async () => {
      await expectNoLedgerMutation(
        () => release(ledger(), 'release-invalid', 'usd', value),
        /release amount.*finite non-negative/,
      )
    })
  }

  it('enforces USD micros and safe-integer resource units before mutation', async () => {
    await expectNoLedgerMutation(
      () => reserve(ledger(), 'over-precise-usd', 'usd', 0.0000001),
      /safe integer USD micros/,
    )
    await expectNoLedgerMutation(
      () => reserve(ledger(), 'fractional-token', 'solverTokens', 1.5),
      /non-negative safe integer/,
    )
    await expectNoLedgerMutation(
      () => reserve(ledger(), 'unsafe-token', 'solverTokens', Number.MAX_SAFE_INTEGER + 1),
      /non-negative safe integer/,
    )
  })

  it('rejects malformed action and dimension inputs before mutation', async () => {
    await expectNoLedgerMutation(() => reserve(ledger(), ' ', 'usd', 1), /actionId is invalid/)
    await expectNoLedgerMutation(
      () => reserve(ledger(), 'unknown-dimension', 'gpuHours' as never, 1),
      /dimension is invalid/,
    )
  })

  it('canonicalizes harmless binary floating-point drift to exact USD micros', async () => {
    const l = ledger()
    const entry = await reserve(l, 'binary-drift', 'usd', 0.1 + 0.2)

    expect(entry.amount).toBe(0.3)
    expect((await computeTotals(l)).totals.reserved.usd).toBe(0.3)
  })

  it('accumulates fractional USD in integer micros without drift or oversell', async () => {
    const l = ledger()
    l.limits.usd = 1
    for (let index = 0; index < 10; index += 1) {
      await reserve(l, `tenth-${index}`, 'usd', 0.1)
    }

    const { totals } = await computeTotals(l)
    expect(totals.reserved.usd).toBe(1)
    await expect(reserve(l, 'eleventh', 'usd', 0.1)).rejects.toThrow(/hard limit exceeded/)
  })

  it('validates the complete frozen limit object before touching disk', async () => {
    const malformedLimits: Array<{ label: string; limits: unknown }> = [
      { label: 'non-finite USD', limits: { ...LIMITS, usd: Number.NaN } },
      { label: 'negative-zero USD', limits: { ...LIMITS, usd: -0 } },
      { label: 'over-precise USD', limits: { ...LIMITS, usd: 0.0000001 } },
      { label: 'fractional token', limits: { ...LIMITS, solverTokens: 1.5 } },
      {
        label: 'missing dimension',
        limits: Object.fromEntries(
          Object.entries(LIMITS).filter(([dimension]) => dimension !== 'storageBytes'),
        ),
      },
      { label: 'unknown dimension', limits: { ...LIMITS, unexpected: 1 } },
    ]
    for (const { label, limits } of malformedLimits) {
      await expectNoLedgerMutation(
        () =>
          reserve(
            { ledgerPath: ledger().ledgerPath, limits: limits as BudgetLimits },
            `invalid-limit-${label}`,
            'usd',
            1,
          ),
        /budget: (invalid limit|limits must)/,
      )
    }
  })

  it('freezes ledger path and limits before the first asynchronous boundary', async () => {
    const l = ledger()
    const originalPath = l.ledgerPath
    const redirectedPath = join(root!, 'redirected-ledger.jsonl')
    const mutation = reserve(l, 'snapshot', 'usd', 1)
    l.ledgerPath = redirectedPath
    l.limits.usd = 0

    await mutation

    expect(await stat(originalPath)).not.toBeNull()
    expect(await stat(redirectedPath).catch(() => null)).toBeNull()
    l.ledgerPath = originalPath
    l.limits.usd = 10
    expect((await computeTotals(l)).totals.reserved.usd).toBe(1)
  })

  it('preserves zero and fractional finite USD amounts', async () => {
    const l = ledger()
    await reserve(l, 'fractional', 'usd', 1.5)
    await spend(l, 'fractional', 'usd', 0.5)
    await release(l, 'fractional', 'usd', 1)
    const { totals } = await computeTotals(l)
    expect(totals.reserved.usd).toBe(0)
    expect(totals.spent.usd).toBe(0.5)

    await reserve(l, 'zero', 'usd', 0)
    expect((await computeTotals(l)).totals.reserved.usd).toBe(0)
  })

  it('rejects hash-consistent entries with unknown or malformed schema fields', async () => {
    const cases: Array<{ label: string; override: Record<string, unknown>; pattern: RegExp }> = [
      { label: 'kind', override: { kind: 'mint' }, pattern: /invalid kind/ },
      { label: 'dimension', override: { dimension: 'gpuHours' }, pattern: /invalid dimension/ },
      { label: 'actionId', override: { actionId: ' ' }, pattern: /invalid actionId/ },
      { label: 'timestamp', override: { at: 'not-an-iso-time' }, pattern: /invalid timestamp/ },
      { label: 'extra field', override: { extra: true }, pattern: /invalid schema/ },
    ]
    for (const { label, override, pattern } of cases) {
      await writeEntries(chainedEntries([override]))
      await expect(computeTotals(ledger()), label).rejects.toThrow(pattern)
    }
  })

  it('validates sequence and both hash fields before replay', async () => {
    const cases: Array<{ label: string; mutate: (entry: RawEntry) => void; pattern: RegExp }> = [
      {
        label: 'unsafe sequence',
        mutate: (entry) => {
          entry.seq = Number.MAX_SAFE_INTEGER
        },
        pattern: /budget seq/,
      },
      {
        label: 'entry hash format',
        mutate: (entry) => {
          entry['entryHash'] = 'sha256:short'
        },
        pattern: /invalid entryHash/,
      },
      {
        label: 'previous hash format',
        mutate: (entry) => {
          entry.previousHash = 'sha256:short'
        },
        pattern: /invalid previousHash/,
      },
    ]
    for (const { label, mutate, pattern } of cases) {
      const [entry] = chainedEntries([{}])
      mutate(entry!)
      await writeEntries([entry!])
      await expect(computeTotals(ledger()), label).rejects.toThrow(pattern)
    }
  })

  it('rejects non-canonical JSON even when duplicate-key semantics and hash agree', async () => {
    const [entry] = chainedEntries([{}])
    const canonical = JSON.stringify(entry)
    const duplicateAmount = canonical.replace('"amount":1', '"amount":2,"amount":1')
    await writeFile(ledger().ledgerPath, duplicateAmount + '\n')

    await expect(computeTotals(ledger())).rejects.toThrow(/canonical JSON encoding/)
  })

  it('rejects hash-consistent persisted amounts outside the fixed precision domain', async () => {
    await writeEntries(chainedEntries([{ amount: 0.0000001 }]))
    await expect(computeTotals(ledger())).rejects.toThrow(/invalid amount.*USD micros/)

    await writeEntries(chainedEntries([{ dimension: 'solverTokens', amount: 1.5 }]))
    await expect(computeTotals(ledger())).rejects.toThrow(/invalid amount.*safe integer/)
  })

  it('rejects hash-consistent negative action balances for spend, release, and refund', async () => {
    const cases: Array<{ label: string; entries: Array<Record<string, unknown>> }> = [
      {
        label: 'spend without reserve',
        entries: [{ kind: 'spend', actionId: 'unreserved-spend', amount: 1 }],
      },
      {
        label: 'release beyond reserve',
        entries: [
          { kind: 'reserve', actionId: 'over-release', amount: 1 },
          { kind: 'release', actionId: 'over-release', amount: 2 },
        ],
      },
      {
        label: 'refund beyond spend',
        entries: [
          { kind: 'reserve', actionId: 'over-refund', amount: 1 },
          { kind: 'spend', actionId: 'over-refund', amount: 1 },
          { kind: 'refund', actionId: 'over-refund', amount: 2 },
        ],
      },
    ]
    for (const { label, entries } of cases) {
      await writeEntries(chainedEntries(entries))
      await expect(computeTotals(ledger()), label).rejects.toThrow(/exceeds its durable balance/)
    }
  })

  it('replays refund as spent-to-reserved without changing committed budget', async () => {
    await writeEntries(
      chainedEntries([
        { kind: 'reserve', actionId: 'refunded', amount: 2 },
        { kind: 'spend', actionId: 'refunded', amount: 2 },
        { kind: 'refund', actionId: 'refunded', amount: 1 },
      ]),
    )

    const { totals } = await computeTotals(ledger())
    expect(totals.reserved.usd).toBe(1)
    expect(totals.spent.usd).toBe(1)
  })

  it('rejects hash-consistent arithmetic overflow and frozen-limit violations', async () => {
    await writeEntries(
      chainedEntries([
        { dimension: 'storageBytes', actionId: 'large-a', amount: 5_000_000_000_000_000 },
        { dimension: 'storageBytes', actionId: 'large-b', amount: 5_000_000_000_000_000 },
      ]),
    )
    await expect(
      computeTotals({
        ledgerPath: ledger().ledgerPath,
        limits: { ...LIMITS, storageBytes: Number.MAX_SAFE_INTEGER },
      }),
    ).rejects.toThrow(/arithmetic overflow/)

    await writeEntries(chainedEntries([{ actionId: 'over-limit', amount: 11 }]))
    await expect(computeTotals(ledger())).rejects.toThrow(/exceeds the frozen usd limit/)
  })

  it('rejects duplicate durable mutations that the idempotent API cannot append', async () => {
    await writeEntries(
      chainedEntries([
        { kind: 'reserve', actionId: 'duplicate', amount: 1 },
        { kind: 'reserve', actionId: 'duplicate', amount: 1 },
      ]),
    )

    await expect(computeTotals(ledger())).rejects.toThrow(/duplicate reserve mutation/)
  })

  it('fails closed when an on-disk entry contains a non-number amount', async () => {
    const withoutHash = {
      seq: 1,
      kind: 'reserve' as const,
      dimension: 'usd' as const,
      actionId: 'forged',
      amount: null,
      at: '2026-08-23T00:00:00.000Z',
      previousHash: null,
    }
    const entry = {
      ...withoutHash,
      entryHash:
        'sha256:' +
        createHash('sha256')
          .update(canonicalEntry(withoutHash as unknown as Omit<BudgetEntry, 'entryHash'>))
          .digest('hex'),
    }
    await writeFile(ledger().ledgerPath, JSON.stringify(entry) + '\n')

    await expect(computeTotals(ledger())).rejects.toThrow(
      /EVIDENCE_CORRUPT: budget entry 1 has invalid amount/,
    )
    expect(await readFile(ledger().ledgerPath, 'utf8')).toBe(JSON.stringify(entry) + '\n')
  })
})
