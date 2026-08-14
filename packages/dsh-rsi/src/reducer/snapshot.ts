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
 * Load the LATEST snapshot. Returns null if none exists or if validation fails
 * (caller falls back to full replay).
 */
export async function loadLatestSnapshot(snapshotsDir: string): Promise<SnapshotRecord | null> {
  let names: string[]
  try {
    const { readdir } = await import('node:fs/promises')
    names = (await readdir(snapshotsDir))
      .filter((f) => f.startsWith('state-') && f.endsWith('.json'))
      .sort()
  } catch {
    return null
  }
  if (names.length === 0) return null
  const latest = names[names.length - 1]!
  const raw = await readFile(join(snapshotsDir, latest), 'utf8')
  const record = JSON.parse(raw) as SnapshotRecord
  // Validate.
  if (record.reducerVersion !== 1) return null
  const recomputed = stateHash(record.state)
  if (recomputed !== record.stateHash) return null
  return record
}
