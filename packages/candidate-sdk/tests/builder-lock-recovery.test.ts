/**
 * Builder lock crash-recovery contract (issue #38).
 *
 * A crash between the exclusive create and the owner write used to leave an
 * empty lock file that no later build could reclaim. Locks are now published
 * atomically (staging + hard link), so the final path only ever holds a
 * complete owner record, and legacy empty locks are safely reclaimable.
 */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acquireBuildLock } from '../src/builder-sandbox.js'

const lockDir = join(tmpdir(), 'dsh-self-evolving-candidate-build-locks')

function lockPathFor(sourceRoot: string): string {
  const key = createHash('sha256').update(sourceRoot).digest('hex')
  return join(lockDir, `${key}.lock`)
}

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'builder-lock-recovery-'))
  return join(root, 'candidate')
}

describe('builder lock recovery', () => {
  it('reclaims an empty lock left by a crash between create and owner write', async () => {
    const sourceRoot = await freshRoot()
    const lockPath = lockPathFor(sourceRoot)
    await rm(lockPath, { force: true })
    await writeFile(lockPath, '', { mode: 0o600 })

    const release = await acquireBuildLock(sourceRoot)
    const record = await readFile(lockPath, 'utf8')
    expect(record).toContain('"pid"')
    expect(record).toContain('"processStartTicks"')
    await release()
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('waits behind a live owner instead of stealing the lock', async () => {
    const sourceRoot = await freshRoot()
    const lockPath = lockPathFor(sourceRoot)
    await rm(lockPath, { force: true })

    const first = await acquireBuildLock(sourceRoot)
    // A second acquisition must not observe success while the live owner
    // holds the lock; assert it stays pending rather than stealing by racing
    // it against an immediate release.
    let second: Awaited<ReturnType<typeof acquireBuildLock>> | undefined
    const pending = acquireBuildLock(sourceRoot).then((release) => {
      second = release
      return release
    })
    await new Promise((done) => setTimeout(done, 250))
    expect(second).toBeUndefined()
    await first()
    await pending
    expect(second).toBeDefined()
    await second!()
  }, 10_000)

  it('publishes only complete owner records at the final lock path', async () => {
    const sourceRoot = await freshRoot()
    const lockPath = lockPathFor(sourceRoot)
    await rm(lockPath, { force: true })
    const release = await acquireBuildLock(sourceRoot)
    const record = JSON.parse(await readFile(lockPath, 'utf8')) as {
      pid: number
      processStartTicks: string
    }
    expect(record.pid).toBe(process.pid)
    expect(typeof record.processStartTicks).toBe('string')
    await release()
  })
})
