import { execFile } from 'node:child_process'
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
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

  it('rejects an existing HEAD symlink without following its target', async () => {
    const j = journal()
    await mkdir(j.journalDir)
    await symlink('/proc/self/mem', join(j.journalDir, 'HEAD'))

    await expect(readHead(j)).rejects.toMatchObject({ code: 'ELOOP' })
    await expect(readAll(j)).rejects.toMatchObject({ code: 'ELOOP' })
  })

  it('treats segments and HEAD staging without HEAD as uncommitted residue', async () => {
    for (const orphanName of ['events-000001.jsonl', 'HEAD.tmp']) {
      const j = journal(join(root!, orphanName.replace('.', '-')))
      await mkdir(j.journalDir)
      await writeFile(join(j.journalDir, orphanName), 'durable bytes\n')

      expect(await readHead(j), orphanName).toBeNull()
      expect(await readAll(j), orphanName).toEqual([])
    }

    const dangling = journal(join(root!, 'dangling-head'))
    await mkdir(dangling.journalDir)
    await symlink('missing-head-target', join(dangling.journalDir, 'HEAD'))
    await expect(readHead(dangling)).rejects.toMatchObject({ code: 'ELOOP' })
    await expect(readAll(dangling)).rejects.toMatchObject({ code: 'ELOOP' })
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

  it('quarantines an orphan segment before committing a new genesis event', async () => {
    const j = journal()
    await mkdir(j.journalDir)
    const segmentPath = join(j.journalDir, 'events-000001.jsonl')
    await writeFile(segmentPath, 'orphan durable event\n')

    const event = await appendFixture(j)
    expect(event.seq).toBe(1)
    expect(await readAll(j)).toHaveLength(1)
    const residues = await readdir(join(j.journalDir, 'crash-residue'))
    expect(residues).toHaveLength(1)
    expect(await readFile(join(j.journalDir, 'crash-residue', residues[0]!), 'utf8')).toBe(
      'orphan durable event\n',
    )
  })

  it('fails closed when HEAD is replaced by a non-regular path during read', async () => {
    const live = journal()
    await appendFixture(live)
    const headPath = join(live.journalDir, 'HEAD')
    const headBytes = await readFile(headPath)
    await rm(headPath)
    await new Promise<void>((resolve, reject) => {
      execFile('/usr/bin/mkfifo', [headPath], (error) =>
        error === null ? resolve() : reject(error),
      )
    })

    const reading = expect(readAll(live)).rejects.toThrow(/not one stable regular file/)
    const writer = await open(headPath, 'w')
    try {
      await writer.writeFile(headBytes)
    } finally {
      await writer.close()
    }

    await reading
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
