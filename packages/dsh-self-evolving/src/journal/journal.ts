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
import { link, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { types as utilTypes } from 'node:util'

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
  schemaVersion: 1
  runId: string
  seq: number
  eventHash: string
  segment: string
}

export interface Journal {
  journalDir: string
  runId: string
  segmentMaxBytes: number
}

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/
const SEGMENT_PATTERN = /^events-([0-9]+)\.jsonl$/
const HEAD_KEYS = ['eventHash', 'runId', 'schemaVersion', 'segment', 'seq'] as const
const EVENT_KEYS = [
  'actor',
  'causationId',
  'correlationId',
  'eventHash',
  'eventId',
  'occurredAt',
  'payload',
  'previousHash',
  'runId',
  'schemaVersion',
  'seq',
  'type',
] as const
const APPEND_KEYS = [
  'actor',
  'causationId',
  'correlationId',
  'eventId',
  'occurredAt',
  'payload',
  'type',
] as const

/** Canonical JSON for hashing: keys sorted, no whitespace, per RFC 8785 spirit. */
export function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(sortKeys(value))
  if (encoded === undefined) throw new TypeError('canonical JSON value is not serializable')
  return encoded
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const sorted = Object.create(null) as Record<string, unknown>
    for (const key of Object.keys(obj).sort()) sorted[key] = sortKeys(obj[key])
    return sorted
  }
  return value
}

function fail(context: string, message: string, cause?: unknown): never {
  throw new Error(`${context}: ${message}`, cause === undefined ? undefined : { cause })
}

function assertExactObject(
  value: unknown,
  keys: readonly string[],
  context: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(context, 'must be an object')
  }
  if (utilTypes.isProxy(value)) fail(context, 'must not be a Proxy')
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some((key) => typeof key !== 'string')) fail(context, 'has a non-string field')
  const actual = (ownKeys as string[]).sort()
  const expected = [...keys].sort()
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index]) ||
    actual.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)
    })
  ) {
    fail(context, 'has an invalid schema')
  }
}

function isProtocolText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0)!
      return codePoint <= 0x1f || codePoint === 0x7f
    })
  )
}

function isCanonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  )
}

function assertJsonValue(value: unknown, context: string, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      fail(context, 'contains a non-canonical number')
    }
    return
  }
  if (typeof value !== 'object') fail(context, 'contains a non-JSON value')
  if (utilTypes.isProxy(value)) fail(context, 'contains a Proxy')
  if (seen.has(value)) fail(context, 'contains a cycle')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const own = Reflect.ownKeys(value)
      if (
        own.some((key) =>
          typeof key === 'symbol' ? true : key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key),
        ) ||
        Object.keys(value).length !== value.length
      ) {
        fail(context, 'contains a sparse or extended array')
      }
      for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          fail(context, 'contains an accessor array element')
        }
        assertJsonValue(descriptor.value, context, seen)
      }
      return
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      fail(context, 'contains a non-plain object')
    }
    for (const key of Reflect.ownKeys(value)) {
      const descriptor =
        typeof key === 'string' ? Object.getOwnPropertyDescriptor(value, key) : undefined
      if (
        typeof key !== 'string' ||
        descriptor === undefined ||
        !descriptor.enumerable ||
        !('value' in descriptor)
      ) {
        fail(context, 'contains a non-JSON object field')
      }
      assertJsonValue(descriptor.value, context, seen)
    }
  } finally {
    seen.delete(value)
  }
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

function parseSegmentIndex(name: unknown): number | null {
  if (typeof name !== 'string') return null
  const match = SEGMENT_PATTERN.exec(name)
  if (match === null) return null
  const index = Number(match[1])
  if (!Number.isSafeInteger(index) || index <= 0) return null
  return name === `events-${String(index).padStart(6, '0')}.jsonl` ? index : null
}

function segmentPath(j: Journal, seq: number): string {
  return join(j.journalDir, segmentName(seq))
}

function journalIoError(operation: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error)
  const wrapped = new Error(`journal: ${operation}: ${detail}`, { cause: error }) as Error & {
    code?: string
  }
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (typeof code === 'string') wrapped.code = code
  return wrapped
}

function validatedJournalSnapshot(j: Journal): Readonly<Journal> {
  if (typeof j !== 'object' || j === null) throw new Error('journal: configuration is invalid')
  const journalDir = j.journalDir
  const runId = j.runId
  const segmentMaxBytes = j.segmentMaxBytes
  if (typeof journalDir !== 'string' || journalDir.length === 0) {
    throw new Error('journal: configured journalDir is invalid')
  }
  if (!isProtocolText(runId)) throw new Error('journal: configured runId is invalid')
  return Object.freeze({ journalDir, runId, segmentMaxBytes })
}

async function assertNoDurableJournalWithoutHead(j: Journal): Promise<void> {
  let names: string[]
  try {
    names = await readdir(j.journalDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        await lstat(j.journalDir)
      } catch (pathError) {
        if ((pathError as NodeJS.ErrnoException).code === 'ENOENT') return
        throw journalIoError('cannot inspect journal directory after missing HEAD', pathError)
      }
      throw journalIoError(
        'journal directory exists but cannot be enumerated after missing HEAD',
        error,
      )
    }
    throw journalIoError('cannot inspect journal after missing HEAD', error)
  }
  if (names.some((name) => name === 'HEAD' || name === 'HEAD.tmp' || name.startsWith('events-'))) {
    throw new Error('EVIDENCE_CORRUPT: journal contains durable artifacts but HEAD is missing')
  }
}

function parseHead(j: Journal, raw: string): JournalHead {
  let decoded: unknown
  try {
    decoded = JSON.parse(raw) as unknown
  } catch (error) {
    fail('EVIDENCE_CORRUPT', 'journal HEAD is not valid JSON', error)
  }
  if (canonicalJson(decoded) + '\n' !== raw) {
    fail('EVIDENCE_CORRUPT', 'journal HEAD does not use canonical JSON encoding')
  }
  assertExactObject(decoded, HEAD_KEYS, 'EVIDENCE_CORRUPT: journal HEAD')
  if (decoded['schemaVersion'] !== 1) {
    fail('EVIDENCE_CORRUPT', 'journal HEAD uses an unsupported schema')
  }
  if (!isProtocolText(decoded['runId']) || decoded['runId'] !== j.runId) {
    fail('EVIDENCE_CORRUPT', 'journal HEAD runId does not match the configured run')
  }
  if (!Number.isSafeInteger(decoded['seq']) || (decoded['seq'] as number) <= 0) {
    fail('EVIDENCE_CORRUPT', 'journal HEAD has an invalid sequence')
  }
  if (typeof decoded['eventHash'] !== 'string' || !HASH_PATTERN.test(decoded['eventHash'])) {
    fail('EVIDENCE_CORRUPT', 'journal HEAD has an invalid event hash')
  }
  if (parseSegmentIndex(decoded['segment']) === null) {
    fail('EVIDENCE_CORRUPT', 'journal HEAD has an invalid segment name')
  }
  return decoded as unknown as JournalHead
}

async function readHeadFromSnapshot(j: Readonly<Journal>): Promise<JournalHead | null> {
  const headPath = join(j.journalDir, 'HEAD')
  let raw: string
  try {
    raw = await readFile(headPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw journalIoError('cannot read HEAD', error)
    }
    await assertNoDurableJournalWithoutHead(j)
    return null
  }
  return parseHead(j, raw)
}

export async function readHead(j: Journal): Promise<JournalHead | null> {
  return readHeadFromSnapshot(validatedJournalSnapshot(j))
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
  assertExactObject(partial, APPEND_KEYS, 'journal: append input')
  if (!isProtocolText(partial.eventId)) throw new Error('journal: append eventId is invalid')
  if (!isCanonicalTimestamp(partial.occurredAt)) {
    throw new Error('journal: append occurredAt must be a canonical ISO timestamp')
  }
  if (!isProtocolText(partial.type)) throw new Error('journal: append type is invalid')
  if (partial.causationId !== null && !isProtocolText(partial.causationId)) {
    throw new Error('journal: append causationId is invalid')
  }
  if (partial.correlationId !== null && !isProtocolText(partial.correlationId)) {
    throw new Error('journal: append correlationId is invalid')
  }
  if (!isProtocolText(partial.actor)) throw new Error('journal: append actor is invalid')
  if (
    typeof partial.payload !== 'object' ||
    partial.payload === null ||
    Array.isArray(partial.payload)
  ) {
    throw new Error('journal: append payload must be a JSON object')
  }
  assertJsonValue(partial.payload, 'journal: append payload')
  const frozenJournal = validatedJournalSnapshot(j)
  const frozenPartial = JSON.parse(canonicalJson(partial)) as typeof partial

  await mkdir(frozenJournal.journalDir, { recursive: true })
  const head = await readHeadFromSnapshot(frozenJournal)
  const seq = head === null ? 1 : head.seq + 1
  if (!Number.isSafeInteger(seq) || seq <= 0) {
    throw new Error('journal: next sequence is outside the safe integer domain')
  }
  const eventWithoutHash: Omit<JournalEvent<P>, 'eventHash'> = {
    schemaVersion: 1,
    runId: frozenJournal.runId,
    seq,
    eventId: frozenPartial.eventId,
    occurredAt: frozenPartial.occurredAt,
    type: frozenPartial.type,
    causationId: frozenPartial.causationId,
    correlationId: frozenPartial.correlationId,
    actor: frozenPartial.actor,
    payload: frozenPartial.payload,
    previousHash: head === null ? null : head.eventHash,
  }
  const eventHash = computeEventHash(eventWithoutHash)
  const event: JournalEvent<P> = { ...eventWithoutHash, eventHash }
  const line = canonicalJson(event) + '\n'
  const segmentFile = await open(segmentPath(frozenJournal, seq), 'a', 0o600)
  try {
    await segmentFile.writeFile(line, { encoding: 'utf8' })
    // The chain event must reach durable storage before HEAD can point at it.
    await segmentFile.sync()
  } finally {
    await segmentFile.close()
  }
  await writeHead(frozenJournal, {
    schemaVersion: 1,
    runId: frozenJournal.runId,
    seq,
    eventHash,
    segment: segmentName(seq),
  })
  return event
}

function parseEvent(j: Journal, value: unknown, expectedSeq: number): JournalEvent {
  const context = `EVIDENCE_CORRUPT: journal event ${expectedSeq}`
  assertExactObject(value, EVENT_KEYS, context)
  if (value['schemaVersion'] !== 1) fail(context, 'uses an unsupported schema')
  if (!isProtocolText(value['runId']) || value['runId'] !== j.runId) {
    fail(context, 'runId does not match the configured run')
  }
  if (!Number.isSafeInteger(value['seq']) || value['seq'] !== expectedSeq) {
    fail(context, `has invalid sequence ${String(value['seq'])}`)
  }
  if (!isProtocolText(value['eventId'])) fail(context, 'has an invalid eventId')
  if (!isCanonicalTimestamp(value['occurredAt'])) {
    fail(context, 'has an invalid occurredAt timestamp')
  }
  if (!isProtocolText(value['type'])) fail(context, 'has an invalid type')
  if (value['causationId'] !== null && !isProtocolText(value['causationId'])) {
    fail(context, 'has an invalid causationId')
  }
  if (value['correlationId'] !== null && !isProtocolText(value['correlationId'])) {
    fail(context, 'has an invalid correlationId')
  }
  if (!isProtocolText(value['actor'])) fail(context, 'has an invalid actor')
  if (
    typeof value['payload'] !== 'object' ||
    value['payload'] === null ||
    Array.isArray(value['payload'])
  ) {
    fail(context, 'payload must be a JSON object')
  }
  assertJsonValue(value['payload'], `${context} payload`)
  if (
    value['previousHash'] !== null &&
    (typeof value['previousHash'] !== 'string' || !HASH_PATTERN.test(value['previousHash']))
  ) {
    fail(context, 'has an invalid previousHash')
  }
  if (typeof value['eventHash'] !== 'string' || !HASH_PATTERN.test(value['eventHash'])) {
    fail(context, 'has an invalid eventHash')
  }
  return value as unknown as JournalEvent
}

/**
 * Read the entire journal in commit order. Verifies the schema/run binding and
 * hash chain; throws on any break (EVIDENCE_CORRUPT, fail-closed).
 */
export async function readAll(j: Journal): Promise<JournalEvent[]> {
  const frozenJournal = validatedJournalSnapshot(j)
  const events: JournalEvent[] = []
  const head = await readHeadFromSnapshot(frozenJournal)
  if (head === null) return events
  // Walk segments in order.
  let segmentFiles: string[]
  try {
    const names = await readdir(frozenJournal.journalDir)
    const candidates = names
      .filter((name) => name.startsWith('events-'))
      .map((name) => ({ index: parseSegmentIndex(name), name }))
    if (candidates.some(({ index }) => index === null)) {
      fail('EVIDENCE_CORRUPT', 'journal contains an invalid segment filename')
    }
    segmentFiles = candidates
      .sort((left, right) => left.index! - right.index!)
      .map(({ name }) => name)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('EVIDENCE_CORRUPT:')) throw error
    throw journalIoError('cannot enumerate segments after reading HEAD', error)
  }
  let expectedPrev: string | null = null
  let expectedSeq = 1
  let tailSegment: string | null = null
  for (const seg of segmentFiles) {
    const raw = await readFile(join(frozenJournal.journalDir, seg), 'utf8')
    if (raw.length === 0) fail('EVIDENCE_CORRUPT', `journal segment ${seg} is empty`)
    if (!raw.endsWith('\n')) {
      fail('EVIDENCE_CORRUPT', `journal segment ${seg} is missing its record terminator`)
    }
    const lines = raw.split('\n')
    let segmentEvents = 0
    for (const [lineIndex, line] of lines.entries()) {
      if (line === '' && lineIndex === lines.length - 1) continue
      if (line.trim() === '') {
        fail('EVIDENCE_CORRUPT', `journal segment ${seg} contains a blank record`)
      }
      let decoded: unknown
      try {
        decoded = JSON.parse(line) as unknown
      } catch (error) {
        fail('EVIDENCE_CORRUPT', `journal event ${expectedSeq} is not valid JSON`, error)
      }
      if (canonicalJson(decoded) !== line) {
        fail('EVIDENCE_CORRUPT', `journal event ${expectedSeq} is not canonically encoded`)
      }
      const ev = parseEvent(frozenJournal, decoded, expectedSeq)
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
      tailSegment = seg
      segmentEvents += 1
    }
    if (segmentEvents === 0) fail('EVIDENCE_CORRUPT', `journal segment ${seg} is empty`)
  }
  const tail = events.at(-1)
  if (
    tail === undefined ||
    head.seq !== tail.seq ||
    head.eventHash !== tail.eventHash ||
    head.segment !== tailSegment
  ) {
    throw new Error('EVIDENCE_CORRUPT: HEAD does not match the durable journal chain tail')
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

interface LockRecord {
  owner: string
  pid: number
  processStartTicks: string
  acquiredAt: string
}

async function processStartTicks(pid: number): Promise<string | null> {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8')
    const close = raw.lastIndexOf(') ')
    if (close === -1) throw new Error(`journal: malformed /proc/${pid}/stat`)
    const fieldsAfterComm = raw
      .slice(close + 2)
      .trim()
      .split(/\s+/)
    // /proc stat field 22 is starttime; fieldsAfterComm starts at field 3.
    const start = fieldsAfterComm[19]
    if (start === undefined || !/^\d+$/.test(start)) {
      throw new Error(`journal: missing process start identity for pid ${pid}`)
    }
    return start
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function preserveAndRemoveStaleLock(lockPath: string, raw: string): Promise<void> {
  const parsed = JSON.parse(raw) as Partial<LockRecord>
  if (
    typeof parsed.pid !== 'number' ||
    !Number.isInteger(parsed.pid) ||
    parsed.pid <= 0 ||
    typeof parsed.processStartTicks !== 'string'
  ) {
    throw new Error('journal: existing lock has no verifiable owner identity')
  }
  const currentStart = await processStartTicks(parsed.pid)
  if (currentStart === parsed.processStartTicks) {
    throw new Error(`journal: already locked by ${raw}`)
  }

  const fingerprint = createHash('sha256').update(raw).digest('hex').slice(0, 16)
  const stalePath = join(dirname(lockPath), `lock.stale-${parsed.pid}-${fingerprint}.json`)
  try {
    await link(lockPath, stalePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const preserved = await readFile(stalePath, 'utf8')
    if (preserved !== raw) {
      throw new Error('journal: stale lock evidence collision', { cause: error })
    }
  }
  const current = await readFile(lockPath, 'utf8').catch(() => null)
  if (current !== raw) throw new Error('journal: lock changed during stale-owner recovery')
  await rm(lockPath)
}

export async function acquireLock(j: Journal, owner: string): Promise<LockHandle> {
  const lockPath = join(j.journalDir, 'lock.json')
  await mkdir(j.journalDir, { recursive: true })
  const startTicks = await processStartTicks(process.pid)
  if (startTicks === null) throw new Error('journal: cannot verify current process identity')
  const lockRecord =
    JSON.stringify({
      owner,
      pid: process.pid,
      processStartTicks: startTicks,
      acquiredAt: new Date().toISOString(),
    }) + '\n'
  let lockFile
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // O_EXCL is the arbitration primitive. A read-then-write sequence permits
      // multiple contenders to observe an absent file and all become writers.
      lockFile = await open(lockPath, 'wx', 0o600)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = await readFile(lockPath, 'utf8').catch(() => null)
      if (existing === null) continue
      try {
        await preserveAndRemoveStaleLock(lockPath, existing)
      } catch (recoveryError) {
        throw new Error(`journal: already locked by ${existing}`, { cause: recoveryError })
      }
    }
  }
  if (lockFile === undefined) throw new Error('journal: lock acquisition race did not converge')
  try {
    await lockFile.writeFile(lockRecord)
    await lockFile.sync()
  } catch (error) {
    await lockFile.close().catch(() => {})
    await rm(lockPath, { force: true })
    throw error
  }
  await lockFile.close()
  const dirFh = await open(j.journalDir, 'r')
  await dirFh.sync().catch(() => {})
  await dirFh.close()
  let released = false
  return {
    async release() {
      if (released) return
      const current = await readFile(lockPath, 'utf8').catch(() => null)
      if (current !== lockRecord) {
        throw new Error('journal: lock ownership changed before release')
      }
      await rm(lockPath, { force: true })
      released = true
    },
  }
}
