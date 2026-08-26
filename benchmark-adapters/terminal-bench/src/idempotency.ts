/**
 * Idempotency key store (spec 07 \u00a74 Accept).
 *
 * "adapter 重复 submit 同 idempotency key 不产生第二个付费 trial".
 *
 * The controller assigns one idempotency key per (candidate, task, attempt)
 * planned trial BEFORE any submit. Reservation is one atomic durable state
 * transition: an exclusively-created per-key marker file under `keys/`. Exactly
 * one concurrent caller can create it, so a duplicate submission cannot race
 * past a check-then-append window, and the marker survives process restarts.
 *
 * The append-only `idempotency.jsonl` ledger is a derived human-audit trail;
 * corruption or unreadability of any store file fails closed instead of being
 * interpreted as "no reservations".
 */
import { appendFile, mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export interface IdempotencyRecord {
  key: string
  candidateId: string
  taskId: string
  attemptIndex: number
  submittedAt: string
}

export interface IdempotencyStore {
  ledgerDir: string
}

const LEDGER = 'idempotency.jsonl'
const KEYS_DIR = 'keys'

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function readLedger(dir: string): Promise<IdempotencyRecord[]> {
  const raw = await readOptional(join(dir, LEDGER))
  if (raw === null) return []
  const records: IdempotencyRecord[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    // A malformed ledger line must never authorize a duplicate paid trial.
    let parsed: IdempotencyRecord
    try {
      parsed = JSON.parse(line) as IdempotencyRecord
    } catch (error) {
      throw new Error(`idempotency ledger is corrupt at ${dir}: ${LEDGER}`, { cause: error })
    }
    if (
      typeof parsed.key !== 'string' ||
      typeof parsed.candidateId !== 'string' ||
      typeof parsed.taskId !== 'string' ||
      typeof parsed.attemptIndex !== 'number'
    ) {
      throw new Error(`idempotency ledger record is malformed at ${dir}: ${parsed.key}`)
    }
    records.push(parsed)
  }
  return records
}

function assertCanonicalRecord(record: IdempotencyRecord): void {
  if (record.key !== idempotencyKey(record.candidateId, record.taskId, record.attemptIndex)) {
    throw new Error(`idempotency record key does not bind its trial identity: ${record.key}`)
  }
}

function assertSameTrial(left: IdempotencyRecord, right: IdempotencyRecord): void {
  if (
    left.candidateId !== right.candidateId ||
    left.taskId !== right.taskId ||
    left.attemptIndex !== right.attemptIndex
  ) {
    throw new Error(`idempotency key collision with conflicting trial identity: ${left.key}`)
  }
}

async function readMarker(store: IdempotencyStore, key: string): Promise<IdempotencyRecord | null> {
  const raw = await readOptional(join(store.ledgerDir, KEYS_DIR, `${key}.json`))
  if (raw === null) return null
  let parsed: IdempotencyRecord
  try {
    parsed = JSON.parse(raw) as IdempotencyRecord
  } catch (error) {
    throw new Error(`idempotency marker is corrupt: ${key}`, { cause: error })
  }
  assertCanonicalRecord(parsed)
  return parsed
}

/**
 * Build the canonical idempotency key for a planned trial. The key is
 * content-addressed over (candidateId, taskId, attemptIndex) so two submits of
 * the same logical trial collide.
 */
export function idempotencyKey(candidateId: string, taskId: string, attemptIndex: number): string {
  const body = `${candidateId}|${taskId}|${attemptIndex}`
  const hash = createHash('sha256').update(body).digest('hex')
  return `dsh-self-evolving-${hash.slice(0, 32)}`
}

/**
 * Reserve an idempotency key atomically. Returns true if this caller won the
 * exclusive per-key marker (caller may launch the job), false if the key was
 * already reserved (caller MUST NOT launch a second paid trial). A conflicting
 * trial identity behind the same key fails closed.
 */
export async function reserveKey(
  store: IdempotencyStore,
  record: IdempotencyRecord,
): Promise<boolean> {
  assertCanonicalRecord(record)
  await mkdir(join(store.ledgerDir, KEYS_DIR), { recursive: true })
  const markerPath = join(store.ledgerDir, KEYS_DIR, `${record.key}.json`)
  const handle = await open(markerPath, 'wx', 0o600).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
    return null
  })
  if (handle === null) {
    const existing = await readMarker(store, record.key)
    if (existing === null) throw new Error(`idempotency marker vanished: ${record.key}`)
    assertSameTrial(existing, record)
    return false
  }
  // A corrupt audit ledger must block new paid reservations until it is
  // reconciled; duplicates of already-reserved keys are still refused by the
  // durable marker without reading the ledger.
  await readLedger(store.ledgerDir)
  try {
    await handle.writeFile(JSON.stringify(record) + '\n')
    await handle.sync()
  } finally {
    await handle.close()
  }
  // Derived audit trail: an append failure after the durable reservation must
  // not un-reserve the key, so append only after the marker is durable.
  await appendFile(join(store.ledgerDir, LEDGER), JSON.stringify(record) + '\n')
  return true
}

/** Check whether a key has been submitted without reserving it. */
export async function isReserved(store: IdempotencyStore, key: string): Promise<boolean> {
  if ((await readMarker(store, key)) !== null) return true
  // Legacy stores (pre-marker) fall back to the ledger, read fail-closed.
  const existing = await readLedger(store.ledgerDir)
  return existing.some((r) => r.key === key)
}
