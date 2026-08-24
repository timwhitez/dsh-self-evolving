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
export async function computeTotals(ledger: BudgetLedger): Promise<{
  totals: BudgetTotals
  headHash: string | null
  nextSeq: number
  entries: BudgetEntry[]
}> {
  const totals = zeroTotals()
  const entries: BudgetEntry[] = []
  let headHash: string | null = null
  let nextSeq = 1
  try {
    const raw = await readFile(ledger.ledgerPath, 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      const e = JSON.parse(line) as BudgetEntry
      if (e.seq !== nextSeq) {
        throw new Error(`EVIDENCE_CORRUPT: budget seq ${e.seq} != expected ${nextSeq}`)
      }
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
      entries.push(e)
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      // no ledger yet
    } else {
      throw e
    }
  }
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
  if (existing.amount !== amount) {
    throw new Error(
      `budget: conflicting ${kind} replay for ${actionId}/${dimension}: ${amount} != ${existing.amount}`,
    )
  }
  return existing
}

function actionReservationBalance(
  entries: BudgetEntry[],
  actionId: string,
  dimension: BudgetDimension,
): number {
  return entries
    .filter((entry) => entry.actionId === actionId && entry.dimension === dimension)
    .reduce((balance, entry) => {
      if (entry.kind === 'reserve' || entry.kind === 'refund') return balance + entry.amount
      return balance - entry.amount
    }, 0)
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
  return withMutationLock(ledger, async () => {
    const { totals, headHash, nextSeq, entries } = await computeTotals(ledger)
    const existing = existingMutation(entries, 'reserve', actionId, dimension, amount)
    if (existing !== null) return existing
    const worst = worstCaseCommitted(totals)
    if (worst[dimension] + amount > ledger.limits[dimension]) {
      throw new Error(
        `budget: hard limit exceeded for ${dimension}: ${worst[dimension] + amount} > ${ledger.limits[dimension]}`,
      )
    }
    return appendEntry(ledger, nextSeq, headHash, 'reserve', dimension, actionId, amount)
  })
}

/** Settle a reservation with actual spend (trusted receipt). */
export async function spend(
  ledger: BudgetLedger,
  actionId: string,
  dimension: BudgetDimension,
  amount: number,
): Promise<BudgetEntry> {
  return withMutationLock(ledger, async () => {
    const { headHash, nextSeq, entries } = await computeTotals(ledger)
    const existing = existingMutation(entries, 'spend', actionId, dimension, amount)
    if (existing !== null) return existing
    if (amount > actionReservationBalance(entries, actionId, dimension)) {
      throw new Error(`budget: spend exceeds reservation for ${actionId}/${dimension}`)
    }
    return appendEntry(ledger, nextSeq, headHash, 'spend', dimension, actionId, amount)
  })
}

/** Release a reservation without spending (e.g. action cancelled). */
export async function release(
  ledger: BudgetLedger,
  actionId: string,
  dimension: BudgetDimension,
  amount: number,
): Promise<BudgetEntry> {
  return withMutationLock(ledger, async () => {
    const { headHash, nextSeq, entries } = await computeTotals(ledger)
    const existing = existingMutation(entries, 'release', actionId, dimension, amount)
    if (existing !== null) return existing
    if (amount > actionReservationBalance(entries, actionId, dimension)) {
      throw new Error(`budget: release exceeds reservation for ${actionId}/${dimension}`)
    }
    return appendEntry(ledger, nextSeq, headHash, 'release', dimension, actionId, amount)
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
  await mkdir(dirname(ledger.ledgerPath), { recursive: true })
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
  const ledgerFile = await open(ledger.ledgerPath, 'a', 0o600)
  try {
    await ledgerFile.writeFile(JSON.stringify(entry) + '\n', { encoding: 'utf8' })
    await ledgerFile.sync()
  } finally {
    await ledgerFile.close()
  }
  return entry
}
