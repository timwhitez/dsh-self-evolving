/**
 * Journal + reducer tests (spec 06 §4-§5).
 *
 * Covers: hash-chain integrity, single-writer lock, pure reducer, the CRITICAL
 * full-replay vs snapshot-resume canonical-state-hash equality, and event-
 * completion-order permutation within a wave.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  append,
  canonicalJson,
  readAll,
  readHead,
  acquireLock,
  computeEventHash,
  type Journal,
  type JournalEvent,
} from '../src/index.js'
import {
  genesisState,
  reduce,
  replay,
  stateHash,
  logicalStateHash,
  writeSnapshot,
  loadLatestSnapshot,
} from '../src/index.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-jrnl-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function journal(): Journal {
  return { journalDir: join(root!, 'journal'), runId: 'run-test', segmentMaxBytes: 1_000_000 }
}

async function appendEvent(
  j: Journal,
  type: string,
  payload: Record<string, unknown>,
  seqOffset = 0,
): Promise<JournalEvent> {
  const ev = await append(j, {
    eventId: `evt-${Date.now()}-${seqOffset}`,
    occurredAt: '2026-08-14T00:00:00.000Z',
    type,
    causationId: null,
    correlationId: null,
    actor: 'test',
    payload,
  })
  return ev
}

describe('journal hash chain', () => {
  it('appends events with a linked previousHash and verifies on readAll', async () => {
    const j = journal()
    await appendEvent(j, 'run.preflight', {})
    await appendEvent(j, 'candidate.admitted', { candidateId: 'c_a', canonicalParent: null })
    await appendEvent(j, 'evaluation.observed', {
      candidateId: 'c_a',
      taskId: 'extract-elf',
      attemptIndex: 0,
      status: 'pass',
      reward: 1.0,
    })
    const events = await readAll(j)
    expect(events.length).toBe(3)
    expect(events[0]!.previousHash).toBeNull()
    expect(events[1]!.previousHash).toBe(events[0]!.eventHash)
    expect(events[2]!.previousHash).toBe(events[1]!.eventHash)
    const head = await readHead(j)
    expect(head!.seq).toBe(3)
    expect(head!.eventHash).toBe(events[2]!.eventHash)
  })

  it('rejects a second writer (single-writer lock)', async () => {
    const j = journal()
    const handle = await acquireLock(j, 'writer-1')
    await expect(acquireLock(j, 'writer-2')).rejects.toThrow(/already locked/)
    await handle.release()
    // after release, a new writer can acquire
    const h2 = await acquireLock(j, 'writer-3')
    await h2.release()
  })

  it('atomically grants exactly one writer under concurrent acquisition', async () => {
    const j = journal()
    const attempts = await Promise.allSettled(
      Array.from({ length: 32 }, (_, index) => acquireLock(j, `writer-${index}`)),
    )
    const acquired = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireLock>>> =>
        attempt.status === 'fulfilled',
    )
    expect(acquired).toHaveLength(1)
    await acquired[0]!.value.release()
  })

  it('readAll fails closed on a broken hash chain (EVIDENCE_CORRUPT)', async () => {
    const j = journal()
    await appendEvent(j, 'run.preflight', {})
    await appendEvent(j, 'run.searching', {})
    // Corrupt the first event's payload on disk.
    const segPath = join(j.journalDir, 'events-000001.jsonl')
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile(segPath, 'utf8')
    const lines = raw.split('\n').filter((l) => l.trim())
    const ev0 = JSON.parse(lines[0]!) as JournalEvent
    ev0.payload = { tampered: true }
    lines[0] = JSON.stringify(ev0)
    await writeFile(segPath, lines.join('\n') + '\n')
    await expect(readAll(j)).rejects.toThrow(/EVIDENCE_CORRUPT/)
  })

  it('readAll fails closed when HEAD does not match the durable chain tail', async () => {
    const j = journal()
    await appendEvent(j, 'run.preflight', {})
    await writeFile(
      join(j.journalDir, 'HEAD'),
      canonicalJson({
        schemaVersion: 1,
        runId: j.runId,
        seq: 2,
        eventHash: `sha256:${'0'.repeat(64)}`,
        segment: 'events-000001.jsonl',
      }) + '\n',
    )
    await expect(readAll(j)).rejects.toThrow(/EVIDENCE_CORRUPT.*HEAD/)
  })
})

describe('reducer + snapshot', () => {
  it('property: arbitrary generated valid event sequences replay purely and deterministically', () => {
    for (let seed = 1; seed <= 64; seed += 1) {
      let randomState = seed >>> 0
      const next = () => {
        randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0
        return randomState
      }
      const events: JournalEvent[] = []
      let previousHash: string | null = null
      const push = (type: string, payload: Record<string, unknown>) => {
        const seq = events.length + 1
        const partial: Omit<JournalEvent, 'eventHash'> = {
          schemaVersion: 1,
          runId: `property-${seed}`,
          seq,
          eventId: `property-${seed}-${seq}`,
          occurredAt: '2026-08-14T00:00:00.000Z',
          type,
          causationId: null,
          correlationId: `wave-${seed}`,
          actor: 'property-test',
          payload,
          previousHash,
        }
        const eventHash = computeEventHash(partial)
        events.push({ ...partial, eventHash })
        previousHash = eventHash
      }
      push('run.preflight', {})
      const count = (next() % 12) + 1
      for (let index = 0; index < count; index += 1) {
        const candidateId = `c_${seed}_${index}`
        push('candidate.admitted', { candidateId, canonicalParent: null })
        push('evaluation.observed', {
          candidateId,
          taskId: `task-${next() % 7}`,
          attemptIndex: next() % 3,
          status: next() % 2 === 0 ? 'pass' : 'fail',
          reward: next() % 2,
        })
      }
      const original = JSON.stringify(events)
      expect(stateHash(replay(events))).toBe(stateHash(replay(events)))
      expect(JSON.stringify(events)).toBe(original)
      expect(replay(events).lastSeq).toBe(events.length)
    }
  })

  it('full replay yields the same canonical state hash as snapshot resume', async () => {
    const j = journal()
    await appendEvent(j, 'run.preflight', {})
    await appendEvent(j, 'candidate.admitted', { candidateId: 'c_a', canonicalParent: null })
    await appendEvent(j, 'candidate.admitted', {
      candidateId: 'c_b',
      canonicalParent: 'sha256:parent',
      donorCandidates: [],
    })
    await appendEvent(j, 'evaluation.observed', {
      candidateId: 'c_a',
      taskId: 't1',
      attemptIndex: 0,
      status: 'pass',
      reward: 1.0,
    })
    await appendEvent(j, 'candidate.dev_observed', { candidateId: 'c_a' })
    const events = await readAll(j)

    // Full replay from genesis.
    const fullState = replay(events)
    const fullHash = stateHash(fullState)

    // Snapshot resume: take a snapshot at seq 3, then reduce the remaining events.
    const midState = replay(events.slice(0, 3))
    const snapPath = await writeSnapshot(join(root!, 'snapshots'), midState)
    expect(snapPath).toMatch(/state-3-/)
    const loaded = await loadLatestSnapshot(join(root!, 'snapshots'))
    expect(loaded).not.toBeNull()
    let resumed = loaded!.state
    for (const ev of events.slice(3)) resumed = reduce(resumed, ev)
    const resumeHash = stateHash(resumed)

    expect(resumeHash).toBe(fullHash)
  })

  it('a corrupt snapshot (stateHash mismatch) is rejected → null', async () => {
    const j = journal()
    await appendEvent(j, 'run.preflight', {})
    const events = await readAll(j)
    const state = replay(events)
    await writeSnapshot(join(root!, 'snapshots'), state)
    // Tamper the snapshot file.
    const { readdir, readFile: rf } = await import('node:fs/promises')
    const snaps = (await readdir(join(root!, 'snapshots'))).filter((f) => f.startsWith('state-'))
    const path = join(root!, 'snapshots', snaps[0]!)
    const raw = await rf(path, 'utf8')
    const rec = JSON.parse(raw)
    rec.state.runPhase = 'TERMINAL' // tamper; invalidates stateHash
    await writeFile(path, JSON.stringify(rec))
    const loaded = await loadLatestSnapshot(join(root!, 'snapshots'))
    expect(loaded).toBeNull() // rejected → caller falls back to full replay
  })

  it('separates exact completion order from order-independent logical facts', () => {
  const candidateEvent: JournalEvent = {
    schemaVersion: 1,
    runId: 'r',
    seq: 1,
    eventId: 'admit',
    occurredAt: '2026-08-14T00:00:00.000Z',
    type: 'candidate.admitted',
    causationId: null,
    correlationId: 'wave',
    actor: 'test',
    payload: { candidateId: 'c_a', canonicalParent: null, donorCandidates: [] },
    previousHash: null,
    eventHash: `sha256:${'1'.repeat(64)}`,
  }
  const observations: JournalEvent[] = [
    {
      ...candidateEvent,
      seq: 2,
      eventId: 'observation-a',
      type: 'evaluation.observed',
      payload: {
        candidateId: 'c_a',
        taskId: 't2',
        attemptIndex: 0,
        status: 'pass',
        reward: 1,
      },
      previousHash: candidateEvent.eventHash,
      eventHash: `sha256:${'2'.repeat(64)}`,
    },
    {
      ...candidateEvent,
      seq: 2,
      eventId: 'observation-b',
      type: 'evaluation.observed',
      payload: {
        candidateId: 'c_a',
        taskId: 't1',
        attemptIndex: 0,
        status: 'fail',
        reward: 0,
      },
      previousHash: candidateEvent.eventHash,
      eventHash: `sha256:${'3'.repeat(64)}`,
    },
  ]

  let stateA = reduce(genesisState(), candidateEvent)
  stateA = reduce(stateA, observations[0]!)
  stateA = reduce(stateA, { ...observations[1]!, seq: 3, previousHash: stateA.lastEventHash })

  let stateB = reduce(genesisState(), candidateEvent)
  stateB = reduce(stateB, observations[1]!)
  stateB = reduce(stateB, { ...observations[0]!, seq: 3, previousHash: stateB.lastEventHash })

  expect(stateHash(stateA)).not.toBe(stateHash(stateB))
  expect(logicalStateHash(stateA)).toBe(logicalStateHash(stateB))
})
})

describe('computeEventHash canonicalization', () => {
  it('the same payload with different key insertion order yields the same event hash', () => {
    const base = {
      schemaVersion: 1 as const,
      runId: 'r',
      seq: 1,
      eventId: 'e1',
      occurredAt: '2026-08-14T00:00:00.000Z',
      type: 'test',
      causationId: null,
      correlationId: null,
      actor: 'a',
      payload: { a: 1, b: 2, c: { z: 9, y: 8 } },
      previousHash: null,
    }
    // Same payload, different insertion order.
    const reordered = {
      ...base,
      payload: { c: { y: 8, z: 9 }, b: 2, a: 1 },
    }
    expect(computeEventHash(base)).toBe(computeEventHash(reordered))
  })
})
