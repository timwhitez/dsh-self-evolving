import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { freezeDeclaredSource, freezeSourceTree } from '../src/source-snapshot.js'

const execFileAsync = promisify(execFile)
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-source-snapshot-fifo-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function expectPromptFifoRejection(operation: () => Promise<unknown>): Promise<void> {
  const fifo = join(root, 'blocked.fifo')
  await execFileAsync('/usr/bin/mkfifo', [fifo])
  let unblock: Promise<void> | undefined
  const fallback = setTimeout(() => {
    unblock = open(fifo, constants.O_WRONLY | constants.O_NONBLOCK)
      .then(async (handle) => handle.close())
      .catch(() => undefined)
  }, 750)
  const started = performance.now()
  try {
    await expect(operation()).rejects.toThrow(/not a regular file|special entry/)
  } finally {
    clearTimeout(fallback)
    await unblock
  }
  expect(performance.now() - started).toBeLessThan(500)
}

describe('descriptor source snapshot special-file handling', () => {
  it('rejects a declared FIFO without waiting for a writer', { timeout: 5_000 }, async () => {
    await expectPromptFifoRejection(() => freezeDeclaredSource(root, ['blocked.fifo']))
  })

  it('rejects an enumerated FIFO without waiting for a writer', { timeout: 5_000 }, async () => {
    await expectPromptFifoRejection(() => freezeSourceTree(root))
  })
})
