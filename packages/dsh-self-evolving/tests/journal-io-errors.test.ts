import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { append, readAll, readHead, type Journal } from '../src/index.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-journal-io-errors-'))
})

afterEach(async () => {
  if (root !== undefined) {
    await chmod(root, 0o700).catch(() => {})
    await chmod(join(root, 'journal'), 0o700).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
  root = undefined
})

function journal(journalDir = join(root!, 'journal')): Journal {
  return { journalDir, runId: 'io-errors', segmentMaxBytes: 1_000_000 }
}

async function appendFixture(j: Journal) {
  return append(j, {
    eventId: 'event-1',
    occurredAt: '2026-08-23T00:00:00.000Z',
    type: 'test.event',
    causationId: null,
    correlationId: null,
    actor: 'test',
    payload: {},
  })
}

describe('journal I/O error propagation', () => {
  it('still treats a genuinely absent journal as empty', async () => {
    expect(await readHead(journal())).toBeNull()
    expect(await readAll(journal())).toEqual([])
  })

  it('allows an initialized but event-free directory containing only lock evidence', async () => {
    const j = journal()
    await mkdir(j.journalDir)
    await writeFile(join(j.journalDir, 'lock.json'), '{}\n')

    expect(await readHead(j)).toBeNull()
    expect(await readAll(j)).toEqual([])
  })

  it('does not convert ENOTDIR while reading HEAD into an empty journal', async () => {
    const notDirectory = join(root!, 'not-a-directory')
    await writeFile(notDirectory, 'file\n')

    await expect(readHead(journal(notDirectory))).rejects.toMatchObject({ code: 'ENOTDIR' })
    await expect(readAll(journal(notDirectory))).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('propagates EIO while reading an existing HEAD path', async () => {
    const j = journal()
    await mkdir(j.journalDir)
    await symlink('/proc/self/mem', join(j.journalDir, 'HEAD'))

    await expect(readHead(j)).rejects.toMatchObject({ code: 'EIO' })
    await expect(readAll(j)).rejects.toMatchObject({ code: 'EIO' })
  })

  it('rejects durable segments and interrupted HEAD publication when HEAD is absent', async () => {
    for (const orphanName of ['events-000001.jsonl', 'HEAD.tmp', 'HEAD']) {
      const j = journal(join(root!, orphanName.replace('.', '-')))
      await mkdir(j.journalDir)
      if (orphanName === 'HEAD') {
        await symlink('missing-head-target', join(j.journalDir, orphanName))
      } else {
        await writeFile(join(j.journalDir, orphanName), 'durable bytes\n')
      }

      await expect(readHead(j), orphanName).rejects.toThrow(/EVIDENCE_CORRUPT.*HEAD is missing/)
      await expect(readAll(j), orphanName).rejects.toThrow(/EVIDENCE_CORRUPT.*HEAD is missing/)
    }
  })

  it('does not treat a dangling journal-directory symlink as an absent journal', async () => {
    const dangling = join(root!, 'dangling-journal')
    await symlink('missing-journal-target', dangling)

    await expect(readHead(journal(dangling))).rejects.toThrow(
      /journal directory exists but cannot be enumerated/,
    )
    await expect(readAll(journal(dangling))).rejects.toThrow(
      /journal directory exists but cannot be enumerated/,
    )
  })

  it('does not append a new genesis event over an orphan durable segment', async () => {
    const j = journal()
    await mkdir(j.journalDir)
    const segmentPath = join(j.journalDir, 'events-000001.jsonl')
    await writeFile(segmentPath, 'orphan durable event\n')

    await expect(appendFixture(j)).rejects.toThrow(/EVIDENCE_CORRUPT.*HEAD is missing/)
    expect(await readFile(segmentPath, 'utf8')).toBe('orphan durable event\n')
  })

  it('propagates ENOENT when the journal directory disappears after HEAD is read', async () => {
    const live = journal()
    await appendFixture(live)
    let pathReads = 0
    const disappearing = {
      ...live,
      get journalDir() {
        pathReads += 1
        return pathReads === 1 ? live.journalDir : join(root!, 'disappeared')
      },
    }

    await expect(readAll(disappearing)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('propagates an injected EIO while enumerating segments', async () => {
    const live = journal()
    await appendFixture(live)
    let pathReads = 0
    const injected = {
      ...live,
      get journalDir() {
        pathReads += 1
        if (pathReads === 2) {
          throw Object.assign(new Error('injected directory I/O failure'), { code: 'EIO' })
        }
        return live.journalDir
      },
    }

    await expect(readAll(injected)).rejects.toMatchObject({ code: 'EIO' })
  })

  it('classifies malformed HEAD JSON as corruption rather than empty state', async () => {
    const j = journal()
    await mkdir(j.journalDir)
    await writeFile(join(j.journalDir, 'HEAD'), '{not-json\n')

    await expect(readHead(j)).rejects.toThrow(/EVIDENCE_CORRUPT.*HEAD.*JSON/)
    await expect(readAll(j)).rejects.toThrow(/EVIDENCE_CORRUPT.*HEAD.*JSON/)
  })

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'propagates a directory enumeration permission failure after reading HEAD',
    async () => {
      const j = journal()
      await appendFixture(j)
      // Execute-only permits opening the known HEAD path but denies readdir.
      await chmod(j.journalDir, 0o100)
      try {
        await expect(readAll(j)).rejects.toMatchObject({ code: 'EACCES' })
      } finally {
        await chmod(j.journalDir, 0o700)
      }
    },
  )
})
