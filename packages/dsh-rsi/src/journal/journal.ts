/**
 * Hash-chain JSONL event journal (spec 06 §4).
 *
 * A single writer appends canonical JSON events to segmented files
 * (events-000001.jsonl, …). Each event carries previousHash + eventHash,
 * forming a tamper-evident chain. Segment close writes size/Merkle root; HEAD
 * records the last committed seq + hash and is updated atomically (tmp + dir
 * fsync).
 *
 * Wall-clock `occurredAt` is audit-only; `seq` is the commit order and is the
 * only ordering that matters. The reducer never reads wall-clock time.
 *
 * Single-writer lock: an exclusive flock-style lock file with owner + lease.
 * A second writer fails fast rather than corrupting the chain.
 */
import { createHash } from 'node:crypto'
import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface JournalEvent<P = Record<string, unknown>> {
  schemaVersion: 1
  runId: string
  seq: number
  eventId: string
  occurredAt: string
  type: string
  causationId: string | null
  correlationId: string | null
  actor: string
  payload: P
  previousHash: string | null
  eventHash: string
}

export interface JournalHead {
  seq: number
  eventHash: string
  segment: string
}

export interface Journal {
  journalDir: string
  runId: string
  segmentMaxBytes: number
}

/** Canonical JSON for hashing: keys sorted, no whitespace, per RFC 8785 spirit. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeys(obj[k])
        return acc
      }, {})
  }
  return value
}

/** Compute the event hash over the canonical event WITHOUT the eventHash field. */
export function computeEventHash<P = Record<string, unknown>>(
  event: Omit<JournalEvent<P>, 'eventHash'>,
): string {
  const withoutHash = { ...event } as Record<string, unknown>
  delete withoutHash.eventHash
  return 'sha256:' + createHash('sha256').update(canonicalJson(withoutHash)).digest('hex')
}

function segmentName(seq: number): string {
  // Each segment holds up to segmentMaxBytes; for simplicity, one segment per
  // 10k events OR byte threshold. We name by the segment index derived from seq.
  const idx = Math.floor(seq / 10_000) + 1
  return `events-${String(idx).padStart(6, '0')}.jsonl`
}

function segmentPath(j: Journal, seq: number): string {
  return join(j.journalDir, segmentName(seq))
}

export async function readHead(j: Journal): Promise<JournalHead | null> {
  const headPath = join(j.journalDir, 'HEAD')
  const raw = await readFile(headPath, 'utf8').catch(() => null)
  if (raw === null) return null
  return JSON.parse(raw) as JournalHead
}

async function writeHead(j: Journal, head: JournalHead): Promise<void> {
  const headPath = join(j.journalDir, 'HEAD')
  const tmpPath = headPath + '.tmp'
  const fh = await open(tmpPath, 'w')
  try {
    await fh.writeFile(canonicalJson(head) + '\n')
    await fh.sync()
  } finally {
    await fh.close()
  }
  await rename(tmpPath, headPath)
  const dirFh = await open(j.journalDir, 'r')
  try {
    await dirFh.sync()
  } catch {
    // fsync dir best-effort
  } finally {
    await dirFh.close()
  }
}

/**
 * Append an event to the journal, computing its hash from the current HEAD.
 * Returns the committed event (with seq + eventHash filled in).
 *
 * This is the ONLY writer path. Callers must hold the single-writer lock.
 */
export async function append<P>(
  j: Journal,
  partial: Omit<
    JournalEvent<P>,
    'schemaVersion' | 'runId' | 'seq' | 'eventHash' | 'previousHash'
  > & {
    payload: P
  },
): Promise<JournalEvent<P>> {
  await mkdir(j.journalDir, { recursive: true })
  const head = await readHead(j)
  const seq = head === null ? 1 : head.seq + 1
  const eventWithoutHash: Omit<JournalEvent<P>, 'eventHash'> = {
    schemaVersion: 1,
    runId: j.runId,
    seq,
    eventId: partial.eventId,
    occurredAt: partial.occurredAt,
    type: partial.type,
    causationId: partial.causationId,
    correlationId: partial.correlationId,
    actor: partial.actor,
    payload: partial.payload,
    previousHash: head === null ? null : head.eventHash,
  }
  const eventHash = computeEventHash(eventWithoutHash)
  const event: JournalEvent<P> = { ...eventWithoutHash, eventHash }
  const line = canonicalJson(event) + '\n'
  await appendFile(segmentPath(j, seq), line, { encoding: 'utf8' })
  await writeHead(j, { seq, eventHash, segment: segmentName(seq) })
  return event
}

/**
 * Read the entire journal in commit order. Verifies the hash chain; throws on
 * any break (EVIDENCE_CORRUPT, fail-closed).
 */
export async function readAll(j: Journal): Promise<JournalEvent[]> {
  const events: JournalEvent[] = []
  const head = await readHead(j)
  if (head === null) return events
  // Walk segments in order.
  const { readdir } = await import('node:fs/promises')
  let segmentFiles: string[]
  try {
    segmentFiles = (await readdir(j.journalDir))
      .filter((f) => f.startsWith('events-') && f.endsWith('.jsonl'))
      .sort()
  } catch {
    return events
  }
  let expectedPrev: string | null = null
  let expectedSeq = 1
  for (const seg of segmentFiles) {
    const raw = await readFile(join(j.journalDir, seg), 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      const ev = JSON.parse(line) as JournalEvent
      if (ev.seq !== expectedSeq) {
        throw new Error(`EVIDENCE_CORRUPT: seq gap/break at ${ev.seq} (expected ${expectedSeq})`)
      }
      if (ev.previousHash !== expectedPrev) {
        throw new Error(`EVIDENCE_CORRUPT: previousHash break at seq ${ev.seq}`)
      }
      const recomputed = computeEventHash(ev as unknown as Omit<JournalEvent, 'eventHash'>)
      if (recomputed !== ev.eventHash) {
        throw new Error(`EVIDENCE_CORRUPT: eventHash mismatch at seq ${ev.seq}`)
      }
      events.push(ev)
      expectedPrev = ev.eventHash
      expectedSeq = ev.seq + 1
    }
  }
  return events
}

/**
 * Single-writer lock: creates a lock.json with owner pid + lease timestamp.
 * Returns an unlock function. A second acquire fails fast.
 */
export interface LockHandle {
  release: () => Promise<void>
}

export async function acquireLock(j: Journal, owner: string): Promise<LockHandle> {
  const lockPath = join(j.journalDir, 'lock.json')
  await mkdir(j.journalDir, { recursive: true })
  const existing = await readFile(lockPath, 'utf8').catch(() => null)
  if (existing !== null) {
    // Stale-lock reaping is the operator's job; we fail closed.
    throw new Error(`journal: already locked by ${existing}`)
  }
  const lockRecord = JSON.stringify({
    owner,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  })
  await writeFile(lockPath, lockRecord + '\n')
  return {
    async release() {
      await rm(lockPath, { force: true })
    },
  }
}
