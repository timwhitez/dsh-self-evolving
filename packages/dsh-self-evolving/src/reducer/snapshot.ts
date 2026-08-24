/**
 * Snapshot persistence (spec 06 §5).
 *
 * A snapshot is a disposable acceleration of replay, never the source of truth.
 * Loading validates: state schema, reducerVersion, last seq/hash, and recomputes
 * the state hash. On ANY mismatch, the loader falls back to full replay from
 * genesis (fail-open to the trusted path, never trust a stale snapshot).
 */
import { canonicalJson } from '../journal/index.js'
import { mkdir, readFile, rename, open } from 'node:fs/promises'
import { join } from 'node:path'
import { stateHash, type ControllerState } from './reducer.js'

export interface SnapshotRecord {
  reducerVersion: 1
  state: ControllerState
  stateHash: string
  createdAt: string
}

interface SnapshotCandidate {
  name: string
  seq: number
  hashPrefix: string
}

function parseSnapshotCandidate(name: string): SnapshotCandidate | null {
  const match = /^state-(0|[1-9][0-9]*)-([0-9a-f]{16})\.json$/.exec(name)
  if (match === null) return null
  const seq = Number(match[1])
  if (!Number.isSafeInteger(seq)) return null
  return { name, seq, hashPrefix: match[2]! }
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function parseSnapshotRecord(raw: string): SnapshotRecord | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<SnapshotRecord>
  if (
    record.reducerVersion !== 1 ||
    record.state === null ||
    typeof record.state !== 'object' ||
    typeof record.stateHash !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(record.stateHash) ||
    typeof record.createdAt !== 'string'
  ) {
    return null
  }
  return record as SnapshotRecord
}

/**
 * Write a snapshot atomically (tmp + dir fsync). Path encodes seq + hash so
 * multiple snapshots never collide.
 */
export async function writeSnapshot(snapshotsDir: string, state: ControllerState): Promise<string> {
  await mkdir(snapshotsDir, { recursive: true })
  const hash = stateHash(state)
  const short = hash.replace('sha256:', '').slice(0, 16)
  const filename = `state-${state.lastSeq}-${short}.json`
  const finalPath = join(snapshotsDir, filename)
  const tmpPath = finalPath + '.tmp'
  const record: SnapshotRecord = {
    reducerVersion: 1,
    state,
    stateHash: hash,
    createdAt: new Date().toISOString(),
  }
  const fh = await open(tmpPath, 'w')
  try {
    await fh.writeFile(canonicalJson(record) + '\n')
    await fh.sync()
  } finally {
    await fh.close()
  }
  await rename(tmpPath, finalPath)
  return finalPath
}

/**
 * Load the latest snapshot by numeric journal sequence. A malformed record,
 * renamed hash suffix, or conflicting same-sequence candidate returns null so
 * the caller replays the authoritative journal from genesis.
 */
export async function loadLatestSnapshot(snapshotsDir: string): Promise<SnapshotRecord | null> {
  let candidates: SnapshotCandidate[]
  try {
    const { readdir } = await import('node:fs/promises')
    candidates = (await readdir(snapshotsDir))
      .map(parseSnapshotCandidate)
      .filter((candidate): candidate is SnapshotCandidate => candidate !== null)
  } catch {
    return null
  }
  if (candidates.length === 0) return null

  const seenSequences = new Set<number>()
  for (const candidate of candidates) {
    if (seenSequences.has(candidate.seq)) return null
    seenSequences.add(candidate.seq)
  }
  candidates.sort(
    (left, right) => left.seq - right.seq || compareCanonicalText(left.name, right.name),
  )
  const latest = candidates[candidates.length - 1]!

  let raw: string
  try {
    raw = await readFile(join(snapshotsDir, latest.name), 'utf8')
  } catch {
    return null
  }
  const record = parseSnapshotRecord(raw)
  if (record === null || record.state.lastSeq !== latest.seq) return null

  const recomputed = stateHash(record.state)
  if (recomputed !== record.stateHash) return null
  if (recomputed.slice('sha256:'.length, 'sha256:'.length + 16) !== latest.hashPrefix) return null
  return record
}
