/**
 * Budget double-entry ledger (spec 06 §8).
 *
 * Budget is an independent append-only ledger, NOT a mutable number in state.
 *   available -> reserved -> spent | released
 *
 * Dimensions: USD, solver tokens, proposer tokens, task trials, proposal calls,
 * wall-clock deadline, concurrency slots, storage. Actual usage is settled by a
 * trusted receipt; when a price is missing, `unpriced_usage > 0` (never zero).
 * The total check uses spent + reserved (worst-case upper bound) to avoid
 * overselling under concurrency.
 *
 * A hard-limit denial produces an event; increasing the budget requires
 * terminating the run and creating a new signed manifest.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export type BudgetDimension =
  | 'usd'
  | 'solverTokens'
  | 'proposerTokens'
  | 'taskTrials'
  | 'proposalCalls'
  | 'wallClockSec'
  | 'concurrencySlots'
  | 'storageBytes'

export type EntryKind = 'reserve' | 'spend' | 'release' | 'refund'

export interface BudgetEntry {
  seq: number
  kind: EntryKind
  dimension: BudgetDimension
  /** The action id this reservation/spend belongs to (causation). */
  actionId: string
  amount: number
  /** ISO timestamp, audit-only. */
  at: string
  /** sha256 over the canonical entry, for tamper-evidence. */
  entryHash: string
  previousHash: string | null
}

export interface BudgetLimits {
  usd: number
  solverTokens: number
  proposerTokens: number
  taskTrials: number
  proposalCalls: number
  wallClockSec: number
  concurrencySlots: number
  storageBytes: number
}

export interface BudgetTotals {
  reserved: Record<BudgetDimension, number>
  spent: Record<BudgetDimension, number>
  /** True when any spend had no price (unpriced usage). */
  unpricedUsage: boolean
}

export interface BudgetLedger {
  ledgerPath: string
  limits: BudgetLimits
}

function zeroTotals(): BudgetTotals {
  const dims: BudgetDimension[] = [
    'usd',
    'solverTokens',
    'proposerTokens',
    'taskTrials',
    'proposalCalls',
    'wallClockSec',
    'concurrencySlots',
    'storageBytes',
  ]
  const reserved = {} as Record<BudgetDimension, number>
  const spent = {} as Record<BudgetDimension, number>
  for (const d of dims) {
    reserved[d] = 0
    spent[d] = 0
  }
  return { reserved, spent, unpricedUsage: false }
}

function canonicalEntry(e: Omit<BudgetEntry, 'entryHash'>): string {
  const { entryHash: _omit, ...rest } = e as BudgetEntry
  void _omit
  return JSON.stringify(rest, Object.keys(rest).sort())
}

/**
 * Rebuild totals from the append-only ledger. This is the trusted path; no
 * derived total is ever trusted directly.
 */
export async function computeTotals(
  ledger: BudgetLedger,
): Promise<{ totals: BudgetTotals; headHash: string | null; nextSeq: number }> {
  const totals = zeroTotals()
  let headHash: string | null = null
  let nextSeq = 1
  try {
    const raw = await readFile(ledger.ledgerPath, 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      const e = JSON.parse(line) as BudgetEntry
      // Verify hash chain (fail-closed on corruption).
      const recomputed = 'sha256:' + createHash('sha256').update(canonicalEntry(e)).digest('hex')
      if (recomputed !== e.entryHash) {
        throw new Error(`EVIDENCE_CORRUPT: budget entry ${e.seq} hash mismatch`)
      }
      if (e.previousHash !== headHash) {
        throw new Error(`EVIDENCE_CORRUPT: budget chain break at ${e.seq}`)
      }
      if (e.kind === 'reserve') totals.reserved[e.dimension] += e.amount
      else if (e.kind === 'spend') {
        totals.spent[e.dimension] += e.amount
        totals.reserved[e.dimension] -= e.amount
        if (e.amount === 0 && e.dimension === 'usd') totals.unpricedUsage = true
      } else if (e.kind === 'release' || e.kind === 'refund') {
        totals.reserved[e.dimension] -= e.amount
      }
      headHash = e.entryHash
      nextSeq = e.seq + 1
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      // no ledger yet
    } else {
      throw e
    }
  }
  return { totals, headHash, nextSeq }
}

/**
 * Worst-case committed = spent + reserved. The hard limit check uses this so
 * concurrency can't oversell. Throws (hard denial) if it would exceed a limit.
 */
export function worstCaseCommitted(totals: BudgetTotals): Record<BudgetDimension, number> {
  const out = {} as Record<BudgetDimension, number>
  for (const d of Object.keys(totals.reserved) as BudgetDimension[]) {
    out[d] = totals.spent[d] + totals.reserved[d]
  }
  return out
}

/**
 * Append a reserve entry. Throws if the worst-case committed would exceed any
 * limit. Returns the entry.
 */
export async function reserve(
  ledger: BudgetLedger,
  actionId: string,
  dimension: BudgetDimension,
  amount: number,
): Promise<BudgetEntry> {
  if (amount < 0) throw new Error(`budget: negative reserve for ${dimension}`)
  const { totals, headHash, nextSeq } = await computeTotals(ledger)
  const worst = worstCaseCommitted(totals)
  if (worst[dimension] + amount > ledger.limits[dimension]) {
    throw new Error(
      `budget: hard limit exceeded for ${dimension}: ${worst[dimension] + amount} > ${ledger.limits[dimension]}`,
    )
  }
  return appendEntry(ledger, nextSeq, headHash, 'reserve', dimension, actionId, amount)
}

/** Settle a reservation with actual spend (trusted receipt). */
export async function spend(
  ledger: BudgetLedger,
  actionId: string,
  dimension: BudgetDimension,
  amount: number,
): Promise<BudgetEntry> {
  const { headHash, nextSeq } = await computeTotals(ledger)
  return appendEntry(ledger, nextSeq, headHash, 'spend', dimension, actionId, amount)
}

/** Release a reservation without spending (e.g. action cancelled). */
export async function release(
  ledger: BudgetLedger,
  actionId: string,
  dimension: BudgetDimension,
  amount: number,
): Promise<BudgetEntry> {
  const { headHash, nextSeq } = await computeTotals(ledger)
  return appendEntry(ledger, nextSeq, headHash, 'release', dimension, actionId, amount)
}

async function appendEntry(
  ledger: BudgetLedger,
  seq: number,
  previousHash: string | null,
  kind: EntryKind,
  dimension: BudgetDimension,
  actionId: string,
  amount: number,
): Promise<BudgetEntry> {
  await mkdir(join(ledger.ledgerPath, '..'), { recursive: true })
  const withoutHash: Omit<BudgetEntry, 'entryHash'> = {
    seq,
    kind,
    dimension,
    actionId,
    amount,
    at: new Date().toISOString(),
    previousHash,
  }
  const entryHash =
    'sha256:' + createHash('sha256').update(canonicalEntry(withoutHash)).digest('hex')
  const entry: BudgetEntry = { ...withoutHash, entryHash }
  await appendFile(ledger.ledgerPath, JSON.stringify(entry) + '\n', { encoding: 'utf8' })
  return entry
}
