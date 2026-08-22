/**
 * Golden replay + reducer property tests (spec 07 §3 Accept):
 *
 *   - full replay state == snapshot + tail replay;
 *   - reducer deterministic under completion-order permutations (same-wave);
 *   - 100 randomized sequences preserve replay equivalence.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  append,
  readAll,
  readHead,
  type Journal,
  type JournalEvent,
} from '../src/index.js'
import {
  genesisState,
  reduce,
  replay,
  stateHash,
  type ControllerState,
} from '../src/index.js'
import { writeSnapshot, loadLatestSnapshot } from '../src/index.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-journal-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function journal(): Journal {
  return { journalDir: join(root!, 'journal'), runId: 'run-test', segmentMaxBytes: 1_000_000 }
}

function ev(
  type: string,
  payload: Record<string, unknown>,
  overrides: Partial<JournalEvent> = {},
): Omit<JournalEvent, 'schemaVersion' | 'runId' | 'seq' | 'eventHash' | 'previousHash'> & {
  payload: Record<string, unknown>
} {
  return {
    eventId: `e-${type}-${Math.random().toString(36).slice(2, 8)}`,
    occurredAt: '2026-08-14T00:00:00.000Z',
    type,
    causationId: null,
    correlationId: null,
    actor: 'test',
    payload,
    ...overrides,
  }
}

describe('hash-chain journal + pure reducer', () => {
  it('appends events with a valid hash chain and durable HEAD', async () => {
    const j = journal()
    const e1 = await append(j, ev('run.preflight', {}))
    const e2 = await append(j, ev('run.searching', {}))
    expect(e1.seq).toBe(1)
    expect(e1.previousHash).toBe(null)
    expect(e2.seq).toBe(2)
    expect(e2.previousHash).toBe(e1.eventHash)
    const all = await readAll(j)
    expect(all.map((e) => e.eventHash)).toEqual([e1.eventHash, e2.eventHash])
    const head = await readHead(j)
    expect(head).toEqual({ seq: 2, eventHash: e2.eventHash, segment: 'events-000001.jsonl' })
  })

  it('full replay state == snapshot + tail replay', async () => {
    const j = journal()
    const parentDigest = `sha256:${'a'.repeat(64)}`
    const events = [
      ev('run.preflight', {}),
      ev('candidate.admitted', {
        candidateId: 'c1',
        canonicalParent: parentDigest,
        donorCandidates: [],
      }),
      ev('candidate.admitted', {
        candidateId: 'c2',
        canonicalParent: 'c1',
        donorCandidates: ['c0'],
      }),
      ev('evaluation.observed', {
        candidateId: 'c1',
        taskId: 't1',
        attemptIndex: 0,
        status: 'pass',
        reward: 1,
      }),
      ev('candidate.dev_observed', { candidateId: 'c1' }),
    ]
    const committed: JournalEvent[] = []
    for (const e of events) committed.push(await append(j, e))
    const fullState = replay(await readAll(j))

    // Snapshot after the first 3 events.
    const prefixState = replay(committed.slice(0, 3))
    const snapDir = join(root!, 'snapshots')
    await writeSnapshot(snapDir, prefixState)
    const loaded = await loadLatestSnapshot(snapDir)
    expect(loaded).not.toBeNull()
    let resumed = loaded!.state
    for (const tailEvent of committed.slice(3)) resumed = reduce(resumed, tailEvent)

    expect(stateHash(resumed)).toBe(stateHash(fullState))
    expect(resumed).toEqual(fullState)
  })

  it('reducer is deterministic across same-wave completion-order permutations', () => {
    // Two independent candidates admitted in the same wave. Completion order
    // differs, but the canonical state (sorted by key at hash time) must match.
    const base = genesisState()
    const make = (seq: number, candidateId: string): JournalEvent => ({
      schemaVersion: 1,
      runId: 'r',
      seq,
      eventId: `e${seq}`,
      occurredAt: '2026-08-14T00:00:00Z',
      type: 'candidate.admitted',
      causationId: null,
      correlationId: 'wave-1',
      actor: 'test',
      payload: { candidateId, canonicalParent: null, donorCandidates: [] },
      previousHash: null,
      eventHash: 'sha256:x',
    })
    const aThenB = reduce(reduce(base, make(1, 'c_a')), make(2, 'c_b'))
    const bThenA = reduce(reduce(base, make(1, 'c_b')), make(2, 'c_a'))
    // Record insertion order differs; canonical JSON sorting makes hash stable.
    expect(stateHash(aThenB)).toBe(stateHash(bThenA))
  })

  it('stateHash is deterministic under 100 randomized replay sequences', () => {
    // Property: replay(events) == reduce(replay(prefix), suffix) for every split.
    let seed = 0xdeadbeef
    function next(): number {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed
    }
    for (let trial = 0; trial < 100; trial++) {
      const count = 3 + (next() % 20)
      const events: JournalEvent[] = []
      // Start with preflight.
      events.push(fakeEvent(1, 'run.preflight', {}))
      for (let i = 1; i < count; i++) {
        const kind = next() % 3
        if (kind === 0) {
          events.push(
            fakeEvent(i + 1, 'candidate.admitted', {
              candidateId: `c_${trial}_${i}`,
              canonicalParent: i === 1 ? null : `c_${trial}_${i - 1}`,
              donorCandidates: [],
            }),
          )
        } else if (kind === 1) {
          // observation only for a candidate that definitely exists: c_trial_1
          const hasC1 = events.some(
            (e) =>
              e.type === 'candidate.admitted' &&
              (e.payload as Record<string, unknown>)['candidateId'] === `c_${trial}_1`,
          )
          if (hasC1) {
            const reward = (next() % 2) as 0 | 1
            events.push(
              fakeEvent(i + 1, 'evaluation.observed', {
                candidateId: `c_${trial}_1`,
                taskId: `t${i}`,
                attemptIndex: 0,
                status: reward === 0 ? 'fail' : 'pass',
                reward,
              }),
            )
          } else {
            events.push(fakeEvent(i + 1, 'run.searching', {}))
          }
        } else {
          events.push(fakeEvent(i + 1, 'run.searching', {}))
        }
      }
      const full = replay(events)
      const split = 1 + (next() % Math.max(1, events.length - 1))
      let resumed: ControllerState = replay(events.slice(0, split))
      for (const e of events.slice(split)) resumed = reduce(resumed, e)
      expect(stateHash(resumed)).toBe(stateHash(full))
    }
  })

  it('loadLatestSnapshot returns null on a tampered snapshot', async () => {
    const state = genesisState()
    const snapDir = join(root!, 'snapshots')
    const path = await writeSnapshot(snapDir, state)
    // Tamper with the state while leaving the hash unchanged.
    const { readFile, writeFile } = await import('node:fs/promises')
    const raw = JSON.parse(await readFile(path, 'utf8'))
    raw.state.runPhase = 'TERMINAL'
    await writeFile(path, JSON.stringify(raw))
    const loaded = await loadLatestSnapshot(snapDir)
    expect(loaded).toBeNull()
  })
})

/** Build a fake, internally consistent event for pure-reducer tests. */
function fakeEvent(seq: number, type: string, payload: Record<string, unknown>): JournalEvent {
  return {
    schemaVersion: 1,
    runId: 'r',
    seq,
    eventId: `e-${seq}`,
    occurredAt: '2026-08-14T00:00:00Z',
    type,
    causationId: null,
    correlationId: null,
    actor: 'test',
    payload,
    previousHash: seq === 1 ? null : `sha256:${seq - 1}`,
    eventHash: `sha256:${seq}`,
  }
}
