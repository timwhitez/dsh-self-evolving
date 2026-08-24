/**
 * Hash-chain JSONL event journal (spec 06 §4).
 *
 * A single writer appends canonical JSON events to segmented files
 * (events-000001.jsonl, …). Each event carries previousHash + eventHash,
 * forming a tamper-evident chain. A new segment is opened before an append that
 * would exceed `segmentMaxBytes`; an individual oversized event occupies one
 * segment because journal records are never split.
 *
 * Wall-clock `occurredAt` is audit-only; `seq` is the commit order and is the
 * only ordering that matters. The reducer never reads wall-clock time.
 *
 * Single-writer lock: an exclusive flock-style lock file with owner + lease.
 * A second writer fails fast rather than corrupting the chain.
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
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

export type JournalAppendInput<P = Record<string, unknown>> = Omit<
  JournalEvent<P>,
  'schemaVersion' | 'runId' | 'seq' | 'eventHash' | 'previousHash'
> & { payload: P }

export interface AppendOnceResult<P = Record<string, unknown>> {
  status: 'CREATED' | 'REUSED'
  event: JournalEvent<P>
}

export type JournalCommitBoundary =
  | 'segment-write'
  | 'segment-fsync'
  | 'segment-directory-fsync'
  | 'head-staging-write'
  | 'head-staging-fsync'
  | 'head-rename'
  | 'head-directory-fsync'

export interface JournalAppendHooks {
  /** Internal fault-injection boundary used by process-crash acceptance tests. */
  afterBoundary?: (boundary: JournalCommitBoundary) => void | Promise<void>
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

function formatSegment(index: number): string {
  if (!Number.isSafeInteger(index) || index <= 0) {
    throw new Error(`journal: invalid segment index ${index}`)
  }
  return `events-${String(index).padStart(6, '0')}.jsonl`
}

function parseSegmentIndex(name: unknown): number | null {
  if (typeof name !== 'string') return null
  const match = SEGMENT_PATTERN.exec(name)
  if (match === null) return null
  const index = Number(match[1])
  if (!Number.isSafeInteger(index) || index <= 0) return null
  return name === `events-${String(index).padStart(6, '0')}.jsonl` ? index : null
}

function segmentPath(j: Journal, segment: string): string {
  if (parseSegmentIndex(segment) === null) {
    fail('EVIDENCE_CORRUPT', `invalid segment name ${segment}`)
  }
  return join(j.journalDir, segment)
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
  if (!Number.isSafeInteger(segmentMaxBytes) || segmentMaxBytes <= 0) {
    throw new Error('journal: segmentMaxBytes must be a positive safe integer')
  }
  return Object.freeze({ journalDir, runId, segmentMaxBytes })
}

async function inspectJournalDirectoryAfterMissingHead(j: Journal): Promise<void> {
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
  // A directory entry named HEAD that readFile reported as ENOENT is a dangling
  // symlink or a concurrent path race, not an empty journal. Segment bytes and
  // HEAD.tmp, however, are uncommitted crash residue because HEAD is the v1
  // commit point; readAll classifies them as outside the committed prefix.
  if (names.includes('HEAD')) {
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
  let raw: Buffer
  try {
    raw = (await readStableRegularFile(headPath, 'cannot read HEAD')).bytes
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
    await inspectJournalDirectoryAfterMissingHead(j)
    return null
  }
  return parseHead(j, raw.toString('utf8'))
}

export async function readHead(j: Journal): Promise<JournalHead | null> {
  return readHeadFromSnapshot(validatedJournalSnapshot(j))
}

async function writeHead(
  j: Journal,
  head: JournalHead,
  hooks: JournalAppendHooks | undefined,
): Promise<void> {
  const headPath = join(j.journalDir, 'HEAD')
  const tmpPath = headPath + '.tmp'
  const fh = await open(tmpPath, 'wx', 0o600)
  try {
    await fh.writeFile(canonicalJson(head) + '\n')
    await hooks?.afterBoundary?.('head-staging-write')
    await fh.sync()
    await hooks?.afterBoundary?.('head-staging-fsync')
  } finally {
    await fh.close()
  }
  await rename(tmpPath, headPath)
  await hooks?.afterBoundary?.('head-rename')
  const dirFh = await open(j.journalDir, 'r')
  try {
    await dirFh.sync()
    await hooks?.afterBoundary?.('head-directory-fsync')
  } finally {
    await dirFh.close()
  }
}

interface SegmentEntry {
  name: string
  index: number
}

interface StableFileSnapshot {
  bytes: Buffer
  dev: number
  ino: number
}

interface CommittedJournalState {
  head: JournalHead | null
  events: JournalEvent[]
  segments: SegmentEntry[]
  headSegmentBytes: Buffer | null
  headEndOffset: number
}

async function listJournalSegments(
  j: Readonly<Journal>,
  allowMissingDirectory: boolean,
): Promise<SegmentEntry[]> {
  let names: string[]
  try {
    names = await readdir(j.journalDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissingDirectory) return []
    throw journalIoError('cannot enumerate segments', error)
  }
  const candidates = names
    .filter((name) => name.startsWith('events-'))
    .map((name) => ({ index: parseSegmentIndex(name), name }))
  if (candidates.some(({ index }) => index === null)) {
    fail('EVIDENCE_CORRUPT', 'journal contains an invalid segment filename')
  }
  return candidates
    .map(({ index, name }) => ({ index: index!, name }))
    .sort((left, right) => left.index - right.index)
}

async function readStableRegularFile(path: string, context: string): Promise<StableFileSnapshot> {
  let file
  try {
    file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (error) {
    throw journalIoError(context, error)
  }
  try {
    const [held, canonical] = await Promise.all([file.stat(), lstat(path)])
    if (
      !held.isFile() ||
      !canonical.isFile() ||
      held.dev !== canonical.dev ||
      held.ino !== canonical.ino
    ) {
      throw new Error(`EVIDENCE_CORRUPT: ${context} is not one stable regular file`)
    }
    return { bytes: await file.readFile(), dev: held.dev, ino: held.ino }
  } finally {
    await file.close()
  }
}

async function readCommittedJournalState(j: Readonly<Journal>): Promise<CommittedJournalState> {
  const head = await readHeadFromSnapshot(j)
  const segments = await listJournalSegments(j, head === null)
  if (head === null) {
    return { head, events: [], segments, headSegmentBytes: null, headEndOffset: 0 }
  }

  const headIndex = parseSegmentIndex(head.segment)!
  const events: JournalEvent[] = []
  let expectedPreviousHash: string | null = null
  let expectedSeq = 1
  let headSegmentBytes: Buffer | null = null
  let headEndOffset = 0
  let foundHead = false

  for (const segment of segments) {
    if (segment.index > headIndex) break
    const snapshot = await readStableRegularFile(
      segmentPath(j, segment.name),
      `cannot read segment ${segment.name}`,
    )
    const raw = snapshot.bytes
    if (raw.length === 0) fail('EVIDENCE_CORRUPT', `journal segment ${segment.name} is empty`)
    let offset = 0
    let segmentEvents = 0
    while (offset < raw.length) {
      const terminator = raw.indexOf(0x0a, offset)
      if (terminator === -1) {
        fail(
          'EVIDENCE_CORRUPT',
          `journal segment ${segment.name} is missing a committed record terminator`,
        )
      }
      const line = raw.subarray(offset, terminator).toString('utf8')
      offset = terminator + 1
      if (line.trim() === '') {
        fail('EVIDENCE_CORRUPT', `journal segment ${segment.name} contains a blank record`)
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
      const event = parseEvent(j, decoded, expectedSeq)
      if (event.previousHash !== expectedPreviousHash) {
        throw new Error(`EVIDENCE_CORRUPT: previousHash break at seq ${event.seq}`)
      }
      const recomputed = computeEventHash(event as unknown as Omit<JournalEvent, 'eventHash'>)
      if (recomputed !== event.eventHash) {
        throw new Error(`EVIDENCE_CORRUPT: eventHash mismatch at seq ${event.seq}`)
      }
      events.push(event)
      expectedPreviousHash = event.eventHash
      expectedSeq = event.seq + 1
      segmentEvents += 1

      if (segment.name === head.segment && event.seq === head.seq) {
        if (event.eventHash !== head.eventHash) {
          fail('EVIDENCE_CORRUPT', 'journal HEAD does not identify the exact committed event')
        }
        foundHead = true
        headSegmentBytes = raw
        headEndOffset = offset
        break
      }
    }
    if (segmentEvents === 0) fail('EVIDENCE_CORRUPT', `journal segment ${segment.name} is empty`)
    if (segment.name === head.segment) break
  }

  if (!foundHead || headSegmentBytes === null || events.length !== head.seq) {
    fail('EVIDENCE_CORRUPT', 'journal HEAD does not identify an exact verified event')
  }
  return { head, events, segments, headSegmentBytes, headEndOffset }
}

async function syncDirectoryStrict(path: string): Promise<void> {
  const directory = await open(path, 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

async function persistCrashResidue(
  j: Readonly<Journal>,
  label: string,
  bytes: Uint8Array,
): Promise<void> {
  const residueDir = join(j.journalDir, 'crash-residue')
  await mkdir(residueDir, { recursive: true, mode: 0o700 })
  const residueInfo = await lstat(residueDir)
  if (!residueInfo.isDirectory() || residueInfo.isSymbolicLink()) {
    fail('EVIDENCE_CORRUPT', 'journal crash-residue path is not a real directory')
  }
  // Make the evidence directory identity durable before any source bytes can
  // be truncated or unlinked.
  await syncDirectoryStrict(j.journalDir)
  const fingerprint = createHash('sha256').update(bytes).digest('hex')
  const destination = join(residueDir, `${label}.uncommitted-${fingerprint}`)
  const staging = `${destination}.staging-${process.pid}-${randomUUID()}`
  const file = await open(staging, 'wx', 0o600)
  try {
    await file.writeFile(bytes)
    await file.sync()
  } finally {
    await file.close()
  }
  try {
    try {
      await link(staging, destination)
      await syncDirectoryStrict(residueDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = await readStableRegularFile(destination, 'cannot verify crash residue')
      if (!existing.bytes.equals(Buffer.from(bytes))) {
        fail('EVIDENCE_CORRUPT', `journal crash-residue collision for ${label}`)
      }
      await syncDirectoryStrict(residueDir)
    }
  } finally {
    await rm(staging, { force: true })
  }
}

async function quarantineWholeFile(j: Readonly<Journal>, name: string): Promise<void> {
  const source = join(j.journalDir, name)
  const snapshot = await readStableRegularFile(source, `cannot quarantine ${name}`)
  await persistCrashResidue(j, name, snapshot.bytes)
  const current = await lstat(source)
  if (current.dev !== snapshot.dev || current.ino !== snapshot.ino || !current.isFile()) {
    fail('EVIDENCE_CORRUPT', `journal residue ${name} changed during quarantine`)
  }
  await rm(source)
  await syncDirectoryStrict(j.journalDir)
}

async function truncateHeadSegmentResidue(
  j: Readonly<Journal>,
  committed: CommittedJournalState,
): Promise<void> {
  const head = committed.head!
  const expected = committed.headSegmentBytes!
  const path = segmentPath(j, head.segment)
  let file
  try {
    file = await open(path, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW)
  } catch (error) {
    throw journalIoError(`cannot repair segment ${head.segment}`, error)
  }
  try {
    const [held, canonical] = await Promise.all([file.stat(), lstat(path)])
    if (
      !held.isFile() ||
      !canonical.isFile() ||
      held.dev !== canonical.dev ||
      held.ino !== canonical.ino
    ) {
      fail('EVIDENCE_CORRUPT', `journal segment ${head.segment} changed during repair`)
    }
    const current = await file.readFile()
    if (
      current.length < committed.headEndOffset ||
      !current
        .subarray(0, committed.headEndOffset)
        .equals(expected.subarray(0, committed.headEndOffset))
    ) {
      fail('EVIDENCE_CORRUPT', `journal committed prefix changed during repair`)
    }
    if (current.length === committed.headEndOffset) return
    await persistCrashResidue(
      j,
      `${head.segment}.after-seq-${head.seq}`,
      current.subarray(committed.headEndOffset),
    )
    await file.truncate(committed.headEndOffset)
    await file.sync()
  } finally {
    await file.close()
  }
}

async function activeSegmentEndsAtHead(j: Readonly<Journal>, head: JournalHead): Promise<boolean> {
  const path = segmentPath(j, head.segment)
  let file
  try {
    file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (error) {
    throw journalIoError(`cannot inspect active segment ${head.segment}`, error)
  }
  try {
    const [held, canonical] = await Promise.all([file.stat(), lstat(path)])
    if (
      !held.isFile() ||
      !canonical.isFile() ||
      held.dev !== canonical.dev ||
      held.ino !== canonical.ino ||
      held.size <= 0
    ) {
      return false
    }
    const finalByte = Buffer.alloc(1)
    const finalRead = await file.read(finalByte, 0, 1, held.size - 1)
    if (finalRead.bytesRead !== 1 || finalByte[0] !== 0x0a) return false

    const pieces: Buffer[] = []
    let cursor = held.size - 1
    while (cursor > 0) {
      const length = Math.min(64 * 1024, cursor)
      const start = cursor - length
      const chunk = Buffer.alloc(length)
      const read = await file.read(chunk, 0, length, start)
      if (read.bytesRead !== length) return false
      const separator = chunk.lastIndexOf(0x0a)
      if (separator !== -1) {
        pieces.unshift(chunk.subarray(separator + 1))
        break
      }
      pieces.unshift(chunk)
      cursor = start
    }
    const line = Buffer.concat(pieces).toString('utf8')
    try {
      const decoded = JSON.parse(line) as unknown
      if (canonicalJson(decoded) !== line) return false
      const event = parseEvent(j, decoded, head.seq)
      return (
        event.eventHash === head.eventHash &&
        computeEventHash(event as unknown as Omit<JournalEvent, 'eventHash'>) === event.eventHash
      )
    } catch {
      return false
    }
  } finally {
    await file.close()
  }
}

async function journalMayContainUncommittedResidue(j: Readonly<Journal>): Promise<boolean> {
  const head = await readHeadFromSnapshot(j)
  const segments = await listJournalSegments(j, head === null)
  const stagingExists = await lstat(join(j.journalDir, 'HEAD.tmp')).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    },
  )
  if (head === null) return stagingExists || segments.length > 0
  if (stagingExists) return true
  const headIndex = parseSegmentIndex(head.segment)!
  if (segments.some((segment) => segment.index > headIndex)) return true
  return !(await activeSegmentEndsAtHead(j, head))
}

async function recoverUncommittedJournalResidue(j: Readonly<Journal>): Promise<void> {
  if (!(await journalMayContainUncommittedResidue(j))) return
  const committed = await readCommittedJournalState(j)
  if (committed.head === null) {
    for (const segment of committed.segments) await quarantineWholeFile(j, segment.name)
  } else {
    await truncateHeadSegmentResidue(j, committed)
    const headIndex = parseSegmentIndex(committed.head.segment)!
    for (const segment of committed.segments) {
      if (segment.index > headIndex) await quarantineWholeFile(j, segment.name)
    }
  }
  const staging = await lstat(join(j.journalDir, 'HEAD.tmp')).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    },
  )
  if (staging !== null) await quarantineWholeFile(j, 'HEAD.tmp')
}

async function selectAppendSegment(
  j: Readonly<Journal>,
  head: JournalHead | null,
  lineBytes: number,
): Promise<string> {
  if (head === null) return formatSegment(1)
  const currentIndex = parseSegmentIndex(head.segment)
  if (currentIndex === null) fail('EVIDENCE_CORRUPT', 'HEAD has an invalid segment name')
  let current: Awaited<ReturnType<typeof lstat>>
  try {
    current = await lstat(segmentPath(j, head.segment), { bigint: true })
  } catch (error) {
    throw journalIoError(`cannot inspect active segment ${head.segment}`, error)
  }
  if (!current.isFile()) {
    throw new Error(`EVIDENCE_CORRUPT: HEAD segment is not a regular file: ${head.segment}`)
  }
  if (current.size === 0n) {
    throw new Error(`EVIDENCE_CORRUPT: HEAD segment is empty: ${head.segment}`)
  }
  if (current.size + BigInt(lineBytes) > BigInt(j.segmentMaxBytes)) {
    return formatSegment(currentIndex + 1)
  }
  return head.segment
}

export function snapshotAppendInput<P>(partial: JournalAppendInput<P>): JournalAppendInput<P> {
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
  return JSON.parse(canonicalJson(partial)) as JournalAppendInput<P>
}

/**
 * Append an event to the journal, computing its hash from the current HEAD.
 * Returns the committed event (with seq + eventHash filled in).
 *
 * This is the ONLY writer path. Callers must hold the single-writer lock.
 */
export async function append<P>(
  j: Journal,
  partial: JournalAppendInput<P>,
  hooks?: JournalAppendHooks,
): Promise<JournalEvent<P>> {
  const frozenJournal = validatedJournalSnapshot(j)
  const frozenPartial = snapshotAppendInput(partial)

  await mkdir(frozenJournal.journalDir, { recursive: true })
  await recoverUncommittedJournalResidue(frozenJournal)
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
  const segment = await selectAppendSegment(frozenJournal, head, Buffer.byteLength(line, 'utf8'))
  const createsSegment = head === null || segment !== head.segment
  let segmentFile: Awaited<ReturnType<typeof open>>
  try {
    // New segments are evidence identities. Exclusive creation prevents a
    // restart or lock failure from appending over an orphan/crash residue.
    const flags =
      fsConstants.O_WRONLY |
      fsConstants.O_APPEND |
      fsConstants.O_NOFOLLOW |
      (createsSegment ? fsConstants.O_CREAT | fsConstants.O_EXCL : 0)
    segmentFile = await open(segmentPath(frozenJournal, segment), flags, 0o600)
  } catch (error) {
    throw journalIoError(
      `${createsSegment ? 'cannot create' : 'cannot open'} segment ${segment}`,
      error,
    )
  }
  try {
    const [held, canonical] = await Promise.all([
      segmentFile.stat(),
      lstat(segmentPath(frozenJournal, segment)),
    ])
    if (
      !held.isFile() ||
      !canonical.isFile() ||
      held.dev !== canonical.dev ||
      held.ino !== canonical.ino
    ) {
      fail('EVIDENCE_CORRUPT', `journal append segment ${segment} is not one stable regular file`)
    }
    await segmentFile.writeFile(line, { encoding: 'utf8' })
    await hooks?.afterBoundary?.('segment-write')
    // The chain event must reach durable storage before HEAD can point at it.
    await segmentFile.sync()
    await hooks?.afterBoundary?.('segment-fsync')
    if (createsSegment) {
      // A new HEAD must never become durable while its segment directory entry
      // can still disappear after host failure.
      await syncDirectoryStrict(frozenJournal.journalDir)
      await hooks?.afterBoundary?.('segment-directory-fsync')
    }
  } finally {
    await segmentFile.close()
  }
  await writeHead(
    frozenJournal,
    {
      schemaVersion: 1,
      runId: frozenJournal.runId,
      seq,
      eventHash,
      segment,
    },
    hooks,
  )
  return event
}

function appendInputFromEvent<P>(event: JournalEvent<P>): JournalAppendInput<P> {
  return {
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    type: event.type,
    causationId: event.causationId,
    correlationId: event.correlationId,
    actor: event.actor,
    payload: event.payload,
  }
}

/**
 * Append one immutable semantic event, or return the byte-equivalent event
 * already committed under the same eventId. Callers must hold the journal's
 * single-writer lock and serialize this read/append transaction.
 */
export async function appendOnce<P>(
  j: Journal,
  partial: JournalAppendInput<P>,
  hooks?: JournalAppendHooks,
): Promise<AppendOnceResult<P>> {
  const frozenJournal = validatedJournalSnapshot(j)
  const frozenPartial = snapshotAppendInput(partial)
  const matches = (await readAll(frozenJournal)).filter(
    (event) => event.eventId === frozenPartial.eventId,
  )
  if (matches.length > 1) {
    throw new Error(`EVIDENCE_CORRUPT: duplicate journal eventId ${frozenPartial.eventId}`)
  }
  const existing = matches[0]
  if (existing !== undefined) {
    if (canonicalJson(appendInputFromEvent(existing)) !== canonicalJson(frozenPartial)) {
      throw new Error(`journal: conflicting event reuse for eventId ${frozenPartial.eventId}`)
    }
    return { status: 'REUSED', event: existing as JournalEvent<P> }
  }
  return { status: 'CREATED', event: await append(frozenJournal, frozenPartial, hooks) }
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
  return (await readCommittedJournalState(frozenJournal)).events
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
