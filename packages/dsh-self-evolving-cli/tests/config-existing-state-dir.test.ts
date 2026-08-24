import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { configPath, createStableDemoConfig, initializeState } from '../src/index.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function configFor(stateDir: string) {
  return createStableDemoConfig({
    runId: 'state-ownership-test',
    stateDir,
    repoRoot: '/root/dsh-self-evolving',
    codeCommit: 'a'.repeat(40),
  })
}

describe('state directory ownership', () => {
  it('refuses an existing uninitialized directory without changing or populating it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-existing-state-'))
    roots.push(root)
    const stateDir = join(root, 'shared')
    await mkdir(stateDir, { mode: 0o755 })
    await chmod(stateDir, 0o755)

    await expect(initializeState(configFor(stateDir))).rejects.toMatchObject({ code: 'EEXIST' })
    expect((await stat(stateDir)).mode & 0o777).toBe(0o755)
    await expect(readFile(configPath(stateDir))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a final-component symlink without modifying its target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-state-symlink-'))
    roots.push(root)
    const target = join(root, 'target')
    const stateDir = join(root, 'state')
    await mkdir(target, { mode: 0o755 })
    await chmod(target, 0o755)
    await symlink(target, stateDir, 'dir')

    await expect(initializeState(configFor(stateDir))).rejects.toMatchObject({ code: 'EEXIST' })
    expect((await stat(target)).mode & 0o777).toBe(0o755)
    await expect(readFile(join(target, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('allows exactly one concurrent initializer to claim the final directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-state-race-'))
    roots.push(root)
    const stateDir = join(root, 'state')
    const config = configFor(stateDir)

    const results = await Promise.allSettled([initializeState(config), initializeState(config)])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'EEXIST' } })
    expect(JSON.parse(await readFile(configPath(stateDir), 'utf8'))).toEqual(config)
  })
})
