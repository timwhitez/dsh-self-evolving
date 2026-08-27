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
 *
 * UPGRADE NOTE (issue #223): an action settled by pre-#108 code — a missing
 * usage record was spent as 0 and the full reservation released — is NOT
 * re-settleable by post-#108 code, which settles unpriced usage at the full
 * reservation: re-driving such an action throws `budget: conflicting spend
 * replay` (amount mismatch on the same (kind, actionId, dimension) key).
 * That is the intended fail-closed behavior; mid-run controller upgrades
 * across the #108 boundary are additionally discouraged by the run
 * manifest's code-commit binding.
 */
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open, readFile, type FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
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

interface BudgetFileLock {
  file: FileHandle
}

interface LegacyBudgetLockRecord {
  pid: number
  processStartTicks: string
}

const mutationQueues = new Map<string, Promise<void>>()

const BUDGET_DIMENSIONS = [
  'usd',
  'solverTokens',
  'proposerTokens',
  'taskTrials',
  'proposalCalls',
  'wallClockSec',
  'concurrencySlots',
  'storageBytes',
] as const satisfies readonly BudgetDimension[]
const ENTRY_KINDS = [
  'reserve',
  'spend',
  'release',
  'refund',
] as const satisfies readonly EntryKind[]
const ENTRY_KEYS = [
  'actionId',
  'amount',
  'at',
  'dimension',
  'entryHash',
  'kind',
  'previousHash',
  'seq',
] as const
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/
const USD_MICRO_SCALE = 1_000_000
const USD_UNIT_TOLERANCE = 1e-6

type BudgetUnitRecord = Record<BudgetDimension, number>

function isBudgetDimension(value: unknown): value is BudgetDimension {
  return typeof value === 'string' && BUDGET_DIMENSIONS.includes(value as BudgetDimension)
}

function isEntryKind(value: unknown): value is EntryKind {
  return typeof value === 'string' && ENTRY_KINDS.includes(value as EntryKind)
}

function isActionId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value === value.trim() && !value.includes('\0')
  )
}

function amountToUnits(amount: unknown, dimension: BudgetDimension): number {
  if (
    typeof amount !== 'number' ||
    !Number.isFinite(amount) ||
    amount < 0 ||
    Object.is(amount, -0)
  ) {
    throw new Error('must be a finite non-negative number and not negative zero')
  }
  if (dimension === 'usd') {
    const scaled = amount * USD_MICRO_SCALE
    const rounded = Math.round(scaled)
    if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > USD_UNIT_TOLERANCE) {
      throw new Error('must use safe integer USD micros (at most six decimal places)')
    }
    return rounded
  }
  if (!Number.isSafeInteger(amount)) {
    throw new Error('must be a non-negative safe integer')
  }
  return amount
}

function amountFromUnits(units: number, dimension: BudgetDimension): number {
  return dimension === 'usd' ? units / USD_MICRO_SCALE : units
}

function zeroUnitRecord(): BudgetUnitRecord {
  return Object.fromEntries(
    BUDGET_DIMENSIONS.map((dimension) => [dimension, 0]),
  ) as BudgetUnitRecord
}

function zeroTotals(): BudgetTotals {
  const reserved = {} as Record<BudgetDimension, number>
  const spent = {} as Record<BudgetDimension, number>
  for (const dimension of BUDGET_DIMENSIONS) {
    reserved[dimension] = 0
    spent[dimension] = 0
  }
  return { reserved, spent, unpricedUsage: false }
}

function totalsFromUnits(
  reservedUnits: BudgetUnitRecord,
  spentUnits: BudgetUnitRecord,
  unpricedUsage: boolean,
): BudgetTotals {
  const totals = zeroTotals()
  totals.unpricedUsage = unpricedUsage
  for (const dimension of BUDGET_DIMENSIONS) {
    totals.reserved[dimension] = amountFromUnits(reservedUnits[dimension], dimension)
    totals.spent[dimension] = amountFromUnits(spentUnits[dimension], dimension)
  }
  return totals
}

function canonicalEntry(e: Omit<BudgetEntry, 'entryHash'>): string {
  const { entryHash: _omit, ...rest } = e as BudgetEntry
  void _omit
  return JSON.stringify(rest, Object.keys(rest).sort())
}

function assertValidLimits(limits: unknown): asserts limits is BudgetLimits {
  if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) {
    throw new Error('budget: limits must be a complete budget-limit object')
  }
  const keys = Object.keys(limits).sort()
  const expectedKeys = [...BUDGET_DIMENSIONS].sort()
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error('budget: limits must contain exactly the protocol budget dimensions')
  }
  for (const dimension of BUDGET_DIMENSIONS) {
    try {
      amountToUnits((limits as Record<string, unknown>)[dimension], dimension)
    } catch (error) {
      throw new Error(`budget: invalid limit for ${dimension}: ${(error as Error).message}`, {
        cause: error,
      })
    }
  }
}

function validatedLedgerSnapshot(ledger: BudgetLedger): BudgetLedger {
  if (
    typeof ledger !== 'object' ||
    ledger === null ||
    typeof ledger.ledgerPath !== 'string' ||
    ledger.ledgerPath.length === 0
  ) {
    throw new Error('budget: ledgerPath must be a non-empty string')
  }
  assertValidLimits(ledger.limits)
  const limits = {} as BudgetLimits
  for (const dimension of BUDGET_DIMENSIONS) {
    limits[dimension] = amountFromUnits(
      amountToUnits(ledger.limits[dimension], dimension),
      dimension,
    )
  }
  return Object.freeze({
    ledgerPath: ledger.ledgerPath,
    limits: Object.freeze(limits),
  }) as BudgetLedger
}

function assertValidMutationInput(
  ledger: BudgetLedger,
  kind: EntryKind,
  actionId: unknown,
  dimension: unknown,
  amount: unknown,
): asserts actionId is string {
  validatedLedgerSnapshot(ledger)
  if (!isActionId(actionId)) throw new Error(`budget: ${kind} actionId is invalid`)
  if (!isBudgetDimension(dimension)) throw new Error(`budget: ${kind} dimension is invalid`)
  try {
    amountToUnits(amount, dimension)
  } catch (error) {
    throw new Error(`budget: ${kind} amount for ${dimension} ${(error as Error).message}`, {
      cause: error,
    })
  }
}

function corrupt(message: string, cause?: unknown): never {
  throw new Error(`EVIDENCE_CORRUPT: ${message}`, cause === undefined ? undefined : { cause })
}

function safeAddUnits(left: number, right: number, context: string): number {
  const result = left + right
  if (!Number.isSafeInteger(result) || result < 0)
    corrupt(`budget arithmetic overflow at ${context}`)
  return result
}

function safeSubtractUnits(left: number, right: number, context: string): number {
  if (right > left) corrupt(`budget ${context} exceeds its durable balance`)
  return left - right
}

function parseEntry(value: unknown, expectedSeq: number): { entry: BudgetEntry; units: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    corrupt(`budget entry ${expectedSeq} is not an object`)
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.length !== ENTRY_KEYS.length || keys.some((key, index) => key !== ENTRY_KEYS[index])) {
    corrupt(`budget entry ${expectedSeq} has an invalid schema`)
  }
  if (
    !Number.isSafeInteger(record['seq']) ||
    (record['seq'] as number) <= 0 ||
    (record['seq'] as number) >= Number.MAX_SAFE_INTEGER ||
    record['seq'] !== expectedSeq
  ) {
    corrupt(`budget seq ${String(record['seq'])} != expected ${expectedSeq}`)
  }
  if (!isEntryKind(record['kind'])) corrupt(`budget entry ${expectedSeq} has invalid kind`)
  if (!isBudgetDimension(record['dimension'])) {
    corrupt(`budget entry ${expectedSeq} has invalid dimension`)
  }
  if (!isActionId(record['actionId'])) corrupt(`budget entry ${expectedSeq} has invalid actionId`)
  if (
    typeof record['at'] !== 'string' ||
    !Number.isFinite(Date.parse(record['at'])) ||
    new Date(record['at']).toISOString() !== record['at']
  ) {
    corrupt(`budget entry ${expectedSeq} has invalid timestamp`)
  }
  if (typeof record['entryHash'] !== 'string' || !HASH_PATTERN.test(record['entryHash'])) {
    corrupt(`budget entry ${expectedSeq} has invalid entryHash`)
  }
  if (
    record['previousHash'] !== null &&
    (typeof record['previousHash'] !== 'string' || !HASH_PATTERN.test(record['previousHash']))
  ) {
    corrupt(`budget entry ${expectedSeq} has invalid previousHash`)
  }
  let units: number
  try {
    units = amountToUnits(record['amount'], record['dimension'])
  } catch (error) {
    corrupt(`budget entry ${expectedSeq} has invalid amount: ${(error as Error).message}`, error)
  }
  return { entry: record as unknown as BudgetEntry, units }
}

/**
 * Rebuild totals from the append-only ledger. This is the trusted path; no
 * derived total is ever trusted directly.
 */
export async function computeTotals(ledger: BudgetLedger): Promise<{
  totals: BudgetTotals
  headHash: string | null
  nextSeq: number
  entries: BudgetEntry[]
}> {
  const frozenLedger = validatedLedgerSnapshot(ledger)
  const reservedUnits = zeroUnitRecord()
  const spentUnits = zeroUnitRecord()
  const limitUnits = Object.fromEntries(
    BUDGET_DIMENSIONS.map((dimension) => [
      dimension,
      amountToUnits(frozenLedger.limits[dimension], dimension),
    ]),
  ) as BudgetUnitRecord
  const actionReserved = new Map<string, number>()
  const actionSpent = new Map<string, number>()
  const seenMutations = new Set<string>()
  const entries: BudgetEntry[] = []
  let headHash: string | null = null
  let nextSeq = 1
  let unpricedUsage = false
  try {
    const raw = await readFile(frozenLedger.ledgerPath, 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let decoded: unknown
      try {
        decoded = JSON.parse(line) as unknown
      } catch (error) {
        corrupt(`budget entry ${nextSeq} is not valid JSON`, error)
      }
      if (JSON.stringify(decoded) !== line) {
        corrupt(`budget entry ${nextSeq} does not use canonical JSON encoding`)
      }
      const { entry, units } = parseEntry(decoded, nextSeq)
      // Verify hash chain (fail-closed on corruption).
      const recomputed =
        'sha256:' + createHash('sha256').update(canonicalEntry(entry)).digest('hex')
      if (recomputed !== entry.entryHash) {
        corrupt(`budget entry ${entry.seq} hash mismatch`)
      }
      if (entry.previousHash !== headHash) {
        corrupt(`budget chain break at ${entry.seq}`)
      }
      const mutationKey = JSON.stringify([entry.kind, entry.actionId, entry.dimension])
      if (seenMutations.has(mutationKey)) {
        corrupt(`duplicate ${entry.kind} mutation for ${entry.actionId}/${entry.dimension}`)
      }
      seenMutations.add(mutationKey)

      const actionKey = JSON.stringify([entry.actionId, entry.dimension])
      const reservedForAction = actionReserved.get(actionKey) ?? 0
      const spentForAction = actionSpent.get(actionKey) ?? 0
      if (entry.kind === 'reserve') {
        actionReserved.set(
          actionKey,
          safeAddUnits(reservedForAction, units, `action reserve ${entry.seq}`),
        )
        reservedUnits[entry.dimension] = safeAddUnits(
          reservedUnits[entry.dimension],
          units,
          `reserve ${entry.seq}`,
        )
      } else if (entry.kind === 'spend') {
        actionReserved.set(
          actionKey,
          safeSubtractUnits(reservedForAction, units, `spend at entry ${entry.seq}`),
        )
        actionSpent.set(actionKey, safeAddUnits(spentForAction, units, `action spend ${entry.seq}`))
        reservedUnits[entry.dimension] = safeSubtractUnits(
          reservedUnits[entry.dimension],
          units,
          `spend at entry ${entry.seq}`,
        )
        spentUnits[entry.dimension] = safeAddUnits(
          spentUnits[entry.dimension],
          units,
          `spend ${entry.seq}`,
        )
        if (units === 0 && entry.dimension === 'usd') unpricedUsage = true
      } else if (entry.kind === 'release') {
        actionReserved.set(
          actionKey,
          safeSubtractUnits(reservedForAction, units, `release at entry ${entry.seq}`),
        )
        reservedUnits[entry.dimension] = safeSubtractUnits(
          reservedUnits[entry.dimension],
          units,
          `release at entry ${entry.seq}`,
        )
      } else {
        actionSpent.set(
          actionKey,
          safeSubtractUnits(spentForAction, units, `refund at entry ${entry.seq}`),
        )
        actionReserved.set(
          actionKey,
          safeAddUnits(reservedForAction, units, `action refund ${entry.seq}`),
        )
        spentUnits[entry.dimension] = safeSubtractUnits(
          spentUnits[entry.dimension],
          units,
          `refund at entry ${entry.seq}`,
        )
        reservedUnits[entry.dimension] = safeAddUnits(
          reservedUnits[entry.dimension],
          units,
          `refund ${entry.seq}`,
        )
      }
      const committed = safeAddUnits(
        reservedUnits[entry.dimension],
        spentUnits[entry.dimension],
        `committed total ${entry.seq}`,
      )
      if (committed > limitUnits[entry.dimension]) {
        corrupt(`budget entry ${entry.seq} exceeds the frozen ${entry.dimension} limit`)
      }
      headHash = entry.entryHash
      nextSeq = entry.seq + 1
      entries.push(entry)
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      // no ledger yet
    } else {
      throw e
    }
  }
  const totals = totalsFromUnits(reservedUnits, spentUnits, unpricedUsage)
  return { totals, headHash, nextSeq, entries }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r')
  try {
    await directory.sync()
  } catch {
    // Directory fsync is best-effort on filesystems that do not support it.
  } finally {
    await directory.close()
  }
}

async function processStartTicks(pid: number): Promise<string | null> {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8')
    const close = raw.lastIndexOf(') ')
    if (close === -1) throw new Error(`budget: malformed /proc/${pid}/stat`)
    const start = raw
      .slice(close + 2)
      .trim()
      .split(/\s+/)[19]
    if (start === undefined || !/^\d+$/.test(start)) {
      throw new Error(`budget: missing process start identity for pid ${pid}`)
    }
    return start
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function rejectLiveLegacyOwner(raw: string): Promise<void> {
  // The kernel-lock protocol uses a permanent empty inode. Non-empty content
  // can only be a pre-migration ownership record.
  if (raw === '') return
  let pid: number
  let recordedStart: string | null
  if (/^\d+\s*$/.test(raw)) {
    pid = Number(raw.trim())
    recordedStart = null
  } else {
    let parsed: Partial<LegacyBudgetLockRecord>
    try {
      parsed = JSON.parse(raw) as Partial<LegacyBudgetLockRecord>
    } catch (error) {
      throw new Error('budget: existing lock has no verifiable owner identity', { cause: error })
    }
    if (
      typeof parsed.pid !== 'number' ||
      !Number.isSafeInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.processStartTicks !== 'string' ||
      !/^\d+$/.test(parsed.processStartTicks)
    ) {
      throw new Error('budget: existing lock has no verifiable owner identity')
    }
    pid = parsed.pid
    recordedStart = parsed.processStartTicks
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('budget: existing lock has no verifiable owner identity')
  }
  const currentStart = await processStartTicks(pid)
  if (recordedStart === null ? currentStart !== null : currentStart === recordedStart) {
    throw new Error(`budget: mutation ledger is already locked by legacy pid ${pid}`)
  }
}

function acquireKernelLock(file: FileHandle): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    const child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], {
      // fd 3 is a dup of the parent's open file description. flock(2) binds
      // ownership to that shared description, so the lock remains held by the
      // parent FileHandle after this short helper exits.
      stdio: ['ignore', 'ignore', 'pipe', file.fd],
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', (error) => {
      reject(new Error('budget: failed to start the OS lock helper', { cause: error }))
    })
    child.once('close', (code, signal) => {
      if (code === 0 && signal === null) {
        resolve()
        return
      }
      if (code === 1 && signal === null) {
        reject(new Error('budget: mutation ledger is already locked'))
      } else {
        const detail = stderr.trim() || `code=${String(code)} signal=${String(signal)}`
        reject(new Error(`budget: OS lock helper failed during acquisition: ${detail}`))
      }
    })
  })
}

async function verifyCanonicalLockPath(lockPath: string, file: FileHandle): Promise<void> {
  const [held, canonical] = await Promise.all([file.stat(), lstat(lockPath)])
  if (
    !held.isFile() ||
    !canonical.isFile() ||
    held.dev !== canonical.dev ||
    held.ino !== canonical.ino
  ) {
    throw new Error('budget: lock path changed or is not a regular file')
  }
}

async function acquireBudgetFileLock(lockPath: string): Promise<BudgetFileLock> {
  const directory = dirname(lockPath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const lockFile = await open(
    lockPath,
    fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
    0o600,
  )
  try {
    await verifyCanonicalLockPath(lockPath, lockFile)
    await lockFile.chmod(0o600)
    await lockFile.sync()
    await syncDirectory(directory)
    await rejectLiveLegacyOwner(await lockFile.readFile('utf8'))
    await acquireKernelLock(lockFile)
    // Convert a dead legacy record only after this process owns the kernel
    // lock. Empty is the complete new-format state, so a crash around truncate
    // cannot leave a partial marker. The path is never unlinked.
    await lockFile.truncate(0)
    await lockFile.sync()
    await verifyCanonicalLockPath(lockPath, lockFile)
  } catch (error) {
    await lockFile.close().catch(() => undefined)
    throw error
  }
  return { file: lockFile }
}

async function releaseBudgetFileLock(lock: BudgetFileLock): Promise<void> {
  await lock.file.close()
}

async function withMutationLock<T>(ledger: BudgetLedger, operation: () => Promise<T>): Promise<T> {
  const key = ledger.ledgerPath
  const previous = mutationQueues.get(key) ?? Promise.resolve()
  let releaseQueue!: () => void
  const gate = new Promise<void>((done) => {
    releaseQueue = done
  })
  const tail = previous.then(() => gate)
  mutationQueues.set(key, tail)
  await previous

  const lockPath = `${ledger.ledgerPath}.lock`
  let lock: BudgetFileLock
  try {
    lock = await acquireBudgetFileLock(lockPath)
  } catch (error) {
    releaseQueue()
    if (mutationQueues.get(key) === tail) mutationQueues.delete(key)
    throw error
  }

  try {
    return await operation()
  } finally {
    try {
      await releaseBudgetFileLock(lock)
    } finally {
      releaseQueue()
      if (mutationQueues.get(key) === tail) mutationQueues.delete(key)
    }
  }
}

function existingMutation(
  entries: BudgetEntry[],
  kind: EntryKind,
  actionId: string,
  dimension: BudgetDimension,
  amount: number,
): BudgetEntry | null {
  const existing = entries.find(
    (entry) => entry.kind === kind && entry.actionId === actionId && entry.dimension === dimension,
  )
  if (existing === undefined) return null
  if (amountToUnits(existing.amount, dimension) !== amountToUnits(amount, dimension)) {
    throw new Error(
      `budget: conflicting ${kind} replay for ${actionId}/${dimension}: ${amount} != ${existing.amount}`,
    )
  }
  return existing
}

function actionReservationUnits(
  entries: BudgetEntry[],
  actionId: string,
  dimension: BudgetDimension,
): number {
  return entries
    .filter((entry) => entry.actionId === actionId && entry.dimension === dimension)
    .reduce((balance, entry) => {
      const units = amountToUnits(entry.amount, dimension)
      if (entry.kind === 'reserve' || entry.kind === 'refund') {
        return safeAddUnits(balance, units, `action balance ${actionId}/${dimension}`)
      }
      return safeSubtractUnits(balance, units, `action balance ${actionId}/${dimension}`)
    }, 0)
}

/**
 * Worst-case committed = spent + reserved. The hard limit check uses this so
 * concurrency can't oversell. Throws (hard denial) if it would exceed a limit.
 */
export function worstCaseCommitted(totals: BudgetTotals): Record<BudgetDimension, number> {
  const out = {} as Record<BudgetDimension, number>
  for (const dimension of BUDGET_DIMENSIONS) {
    let reserved: number
    let spent: number
    try {
      reserved = amountToUnits(totals.reserved[dimension], dimension)
      spent = amountToUnits(totals.spent[dimension], dimension)
    } catch (error) {
      throw new Error(`budget: invalid totals for ${dimension}`, { cause: error })
    }
    out[dimension] = amountFromUnits(
      safeAddUnits(reserved, spent, `worst-case ${dimension}`),
      dimension,
    )
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
  const frozenLedger = validatedLedgerSnapshot(ledger)
  assertValidMutationInput(frozenLedger, 'reserve', actionId, dimension, amount)
  return withMutationLock(frozenLedger, async () => {
    const { totals, headHash, nextSeq, entries } = await computeTotals(frozenLedger)
    const existing = existingMutation(entries, 'reserve', actionId, dimension, amount)
    if (existing !== null) return existing
    const worst = worstCaseCommitted(totals)
    const committedUnits = amountToUnits(worst[dimension], dimension)
    const requestedUnits = amountToUnits(amount, dimension)
    const limitUnits = amountToUnits(frozenLedger.limits[dimension], dimension)
    if (requestedUnits > limitUnits - committedUnits) {
      throw new Error(
        `budget: hard limit exceeded for ${dimension}: committed ${worst[dimension]}, requested ${amount} > ${frozenLedger.limits[dimension]}`,
      )
    }
    return appendEntry(frozenLedger, nextSeq, headHash, 'reserve', dimension, actionId, amount)
  })
}

/** Settle a reservation with actual spend (trusted receipt). */
export async function spend(
  ledger: BudgetLedger,
  actionId: string,
  dimension: BudgetDimension,
  amount: number,
): Promise<BudgetEntry> {
  const frozenLedger = validatedLedgerSnapshot(ledger)
  assertValidMutationInput(frozenLedger, 'spend', actionId, dimension, amount)
  return withMutationLock(frozenLedger, async () => {
    const { headHash, nextSeq, entries } = await computeTotals(frozenLedger)
    const existing = existingMutation(entries, 'spend', actionId, dimension, amount)
    if (existing !== null) return existing
    if (amountToUnits(amount, dimension) > actionReservationUnits(entries, actionId, dimension)) {
      throw new Error(`budget: spend exceeds reservation for ${actionId}/${dimension}`)
    }
    return appendEntry(frozenLedger, nextSeq, headHash, 'spend', dimension, actionId, amount)
  })
}

/** Release a reservation without spending (e.g. action cancelled). */
export async function release(
  ledger: BudgetLedger,
  actionId: string,
  dimension: BudgetDimension,
  amount: number,
): Promise<BudgetEntry> {
  const frozenLedger = validatedLedgerSnapshot(ledger)
  assertValidMutationInput(frozenLedger, 'release', actionId, dimension, amount)
  return withMutationLock(frozenLedger, async () => {
    const { headHash, nextSeq, entries } = await computeTotals(frozenLedger)
    const existing = existingMutation(entries, 'release', actionId, dimension, amount)
    if (existing !== null) return existing
    if (amountToUnits(amount, dimension) > actionReservationUnits(entries, actionId, dimension)) {
      throw new Error(`budget: release exceeds reservation for ${actionId}/${dimension}`)
    }
    return appendEntry(frozenLedger, nextSeq, headHash, 'release', dimension, actionId, amount)
  })
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
  assertValidMutationInput(ledger, kind, actionId, dimension, amount)
  if (!Number.isSafeInteger(seq) || seq <= 0 || seq >= Number.MAX_SAFE_INTEGER) {
    throw new Error('budget: append sequence is invalid')
  }
  if (previousHash !== null && !HASH_PATTERN.test(previousHash)) {
    throw new Error('budget: append previous hash is invalid')
  }
  await mkdir(dirname(ledger.ledgerPath), { recursive: true })
  const canonicalAmount = amountFromUnits(amountToUnits(amount, dimension), dimension)
  const withoutHash: Omit<BudgetEntry, 'entryHash'> = {
    seq,
    kind,
    dimension,
    actionId,
    amount: canonicalAmount,
    at: new Date().toISOString(),
    previousHash,
  }
  const entryHash =
    'sha256:' + createHash('sha256').update(canonicalEntry(withoutHash)).digest('hex')
  const entry: BudgetEntry = { ...withoutHash, entryHash }
  const ledgerFile = await open(ledger.ledgerPath, 'a', 0o600)
  try {
    await ledgerFile.writeFile(JSON.stringify(entry) + '\n', { encoding: 'utf8' })
    await ledgerFile.sync()
  } finally {
    await ledgerFile.close()
  }
  return entry
}
