import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { append, readAll, readHead, type Journal } from '../src/index.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-journal-head-recovery-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function journal(): Journal {
  return {
    journalDir: join(root!, 'journal'),
    runId: 'head-recovery',
    segmentMaxBytes: 1_000_000,
  }
}

async function appendEvent(j: Journal, eventId: string) {
  return append(j, {
    eventId,
    occurredAt: '2026-08-23T00:00:00.000Z',
    type: 'test.event',
    causationId: null,
    correlationId: null,
    actor: 'test',
    payload: { eventId },
  })
}

describe('journal HEAD recovery', () => {
  it('recovers a fully fsynced event after a crash before the HEAD update', async () => {
    const j = journal()
    const first = await appendEvent(j, 'first')
    const headAfterFirst = await readFile(join(j.journalDir, 'HEAD'), 'utf8')
    const second = await appendEvent(j, 'second')

    // Simulate the crash window: durable segment contains event 2, while HEAD
    // still points to the previously committed prefix.
    await writeFile(join(j.journalDir, 'HEAD'), headAfterFirst)

    const recovered = await readAll(j)
    expect(recovered.map((event) => event.eventId)).toEqual(['first', 'second'])
    expect(await readHead(j)).toEqual({
      seq: 2,
      eventHash: second.eventHash,
      segment: 'events-000001.jsonl',
    })

    const third = await appendEvent(j, 'third')
    expect(third.seq).toBe(3)
    expect(third.previousHash).toBe(second.eventHash)
    expect((await readAll(j)).map((event) => event.seq)).toEqual([1, 2, 3])
    expect(JSON.parse(await readFile(join(j.journalDir, 'HEAD'), 'utf8'))).toEqual({
      seq: 3,
      eventHash: third.eventHash,
      segment: 'events-000001.jsonl',
    })
    expect(first.seq).toBe(1)
  })

  it('reconstructs the durable tail when HEAD was never created', async () => {
    const j = journal()
    const first = await appendEvent(j, 'first')
    await rm(join(j.journalDir, 'HEAD'))

    expect((await readAll(j)).map((event) => event.eventHash)).toEqual([first.eventHash])
    expect((await readHead(j))?.eventHash).toBe(first.eventHash)

    const second = await appendEvent(j, 'second')
    expect(second.seq).toBe(2)
    expect(second.previousHash).toBe(first.eventHash)
  })

  it('still rejects a HEAD that does not match a verified durable prefix', async () => {
    const j = journal()
    await appendEvent(j, 'first')
    await appendEvent(j, 'second')
    await writeFile(
      join(j.journalDir, 'HEAD'),
      JSON.stringify({
        seq: 1,
        eventHash: `sha256:${'0'.repeat(64)}`,
        segment: 'events-000001.jsonl',
      }) + '\n',
    )

    await expect(readAll(j)).rejects.toThrow(/EVIDENCE_CORRUPT.*HEAD/)
  })
})
