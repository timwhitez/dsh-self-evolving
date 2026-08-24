import { lstat, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { append, readAll, readHead, type Journal } from '../src/index.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-journal-segmentation-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function journal(segmentMaxBytes: number, name = 'journal'): Journal {
  return {
    journalDir: join(root!, name),
    runId: 'segmentation',
    segmentMaxBytes,
  }
}

async function appendFixture(j: Journal, index: number) {
  return append(j, {
    eventId: `event-${index}`,
    occurredAt: '2026-08-23T00:00:00.000Z',
    type: 'test.event',
    causationId: null,
    correlationId: null,
    actor: 'test',
    payload: { index, padding: 'é😀'.repeat(16) },
  })
}

async function segmentFiles(j: Journal): Promise<string[]> {
  return (await readdir(j.journalDir)).filter((name) => /^events-[0-9]+\.jsonl$/.test(name)).sort()
}

describe('journal byte-size segmentation', () => {
  it('rotates before every subsequent append when a single record exceeds the limit', async () => {
    const j = journal(1)
    const committed = []
    for (let index = 1; index <= 3; index += 1) {
      committed.push(await appendFixture(j, index))
    }

    expect(await segmentFiles(j)).toEqual([
      'events-000001.jsonl',
      'events-000002.jsonl',
      'events-000003.jsonl',
    ])
    for (const segment of await segmentFiles(j)) {
      const lines = (await readFile(join(j.journalDir, segment), 'utf8'))
        .split('\n')
        .filter(Boolean)
      expect(lines).toHaveLength(1)
      expect((await stat(join(j.journalDir, segment))).size).toBeGreaterThan(1)
    }
    expect((await readAll(j)).map((event) => event.seq)).toEqual([1, 2, 3])
    expect(await readHead(j)).toEqual({
      schemaVersion: 1,
      runId: j.runId,
      seq: 3,
      eventHash: committed[2]!.eventHash,
      segment: 'events-000003.jsonl',
    })
  })

  it('uses UTF-8 bytes and rotates only when the next record would exceed the exact limit', async () => {
    const probe = journal(1_000_000, 'probe')
    await appendFixture(probe, 1)
    const segmentPath = join(probe.journalDir, 'events-000001.jsonl')
    const firstBytes = (await stat(segmentPath)).size
    await appendFixture(probe, 2)
    const secondBytes = (await stat(segmentPath)).size - firstBytes
    const exactLimit = firstBytes + secondBytes

    const exact = journal(exactLimit, 'exact')
    await appendFixture(exact, 1)
    await appendFixture(exact, 2)
    expect(await segmentFiles(exact)).toEqual(['events-000001.jsonl'])
    expect((await stat(join(exact.journalDir, 'events-000001.jsonl'))).size).toBe(exactLimit)

    const oneByteOver = journal(exactLimit - 1, 'one-byte-over')
    await appendFixture(oneByteOver, 1)
    await appendFixture(oneByteOver, 2)
    expect(await segmentFiles(oneByteOver)).toEqual(['events-000001.jsonl', 'events-000002.jsonl'])
    expect((await readAll(oneByteOver)).map((event) => event.eventId)).toEqual([
      'event-1',
      'event-2',
    ])
  })

  it('continues the active segment identity deterministically after restart', async () => {
    const original = journal(1, 'restart')
    await appendFixture(original, 1)
    await appendFixture(original, 2)

    const reopened: Journal = { ...original }
    const third = await appendFixture(reopened, 3)

    expect(await segmentFiles(reopened)).toEqual([
      'events-000001.jsonl',
      'events-000002.jsonl',
      'events-000003.jsonl',
    ])
    expect((await readAll(reopened)).map((event) => event.eventId)).toEqual([
      'event-1',
      'event-2',
      'event-3',
    ])
    expect(await readHead(reopened)).toMatchObject({
      seq: 3,
      eventHash: third.eventHash,
      segment: 'events-000003.jsonl',
    })
  })

  it('rejects every invalid byte limit before touching the journal directory', async () => {
    for (const [index, limit] of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ].entries()) {
      const j = journal(limit, `invalid-${index}`)
      await expect(appendFixture(j, 1), String(limit)).rejects.toThrow(
        /segmentMaxBytes must be a positive safe integer/,
      )
      expect(await lstat(j.journalDir).catch(() => null)).toBeNull()
    }
  })

  it('fails closed instead of appending over a pre-existing rotation target', async () => {
    const j = journal(1, 'orphan-target')
    const first = await appendFixture(j, 1)
    const target = join(j.journalDir, 'events-000002.jsonl')
    await writeFile(target, 'orphan crash residue\n')

    await expect(appendFixture(j, 2)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(target, 'utf8')).toBe('orphan crash residue\n')
    expect(await readHead(j)).toMatchObject({
      seq: 1,
      eventHash: first.eventHash,
      segment: 'events-000001.jsonl',
    })
  })

  it('rejects empty or symlinked active segments before append', async () => {
    const empty = journal(1_000_000, 'empty-active')
    await appendFixture(empty, 1)
    await writeFile(join(empty.journalDir, 'events-000001.jsonl'), '')
    await expect(appendFixture(empty, 2)).rejects.toThrow(/HEAD segment is empty/)

    const linked = journal(1_000_000, 'linked-active')
    await appendFixture(linked, 1)
    const linkedSegment = join(linked.journalDir, 'events-000001.jsonl')
    const outside = join(root!, 'outside-evidence')
    await writeFile(outside, 'outside bytes\n')
    await rm(linkedSegment)
    await symlink(outside, linkedSegment)

    await expect(appendFixture(linked, 2)).rejects.toThrow(/not a regular file/)
    expect(await readFile(outside, 'utf8')).toBe('outside bytes\n')
  })
})
