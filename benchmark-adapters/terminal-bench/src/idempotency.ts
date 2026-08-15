/**
 * Idempotency key store (spec 07 §4 Accept).
 *
 * "adapter 重复 submit 同 idempotency key 不产生第二个付费 trial".
 *
 * The controller assigns one idempotency key per (candidate, task, attempt)
 * planned trial BEFORE any submit. This module records submitted keys in an
 * append-only, content-addressed ledger on disk. A second submit with the same
 * key is refused without launching a paid job.
 *
 * The ledger is the source of truth; a derived index can be rebuilt. It records
 * only the key, candidate id, task id and submit timestamp — never a score,
 * sealed label, or credential.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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

async function readLedger(dir: string): Promise<IdempotencyRecord[]> {
  try {
    const raw = await readFile(join(dir, LEDGER), 'utf8')
    return raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as IdempotencyRecord)
  } catch {
    return []
  }
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
 * Reserve an idempotency key. Returns true if this is a new submission (caller
 * may launch the job), false if the key was already submitted (caller MUST NOT
 * launch a second paid trial).
 */
export async function reserveKey(
  store: IdempotencyStore,
  record: IdempotencyRecord,
): Promise<boolean> {
  await mkdir(store.ledgerDir, { recursive: true })
  const existing = await readLedger(store.ledgerDir)
  const seen = existing.some((r) => r.key === record.key)
  if (seen) return false
  await appendFile(join(store.ledgerDir, LEDGER), JSON.stringify(record) + '\n')
  return true
}

/** Check whether a key has been submitted without reserving it. */
export async function isReserved(store: IdempotencyStore, key: string): Promise<boolean> {
  const existing = await readLedger(store.ledgerDir)
  return existing.some((r) => r.key === key)
}

export { LEDGER, dirname }
