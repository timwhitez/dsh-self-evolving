import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  configPath,
  createStableDemoConfig,
  initializeState,
  type InitializationCheckpoint,
} from '../src/index.js'

const roots: string[] = []
const worker = fileURLToPath(new URL('./fixtures/config-init-worker.mjs', import.meta.url))
const crashCheckpoints: InitializationCheckpoint[] = [
  'claim-published',
  'directory-created',
  'staging-created',
  'staging-partial-write',
  'staging-full-write',
  'staging-synced',
  'config-published',
  'config-directory-synced',
  'staging-cleaned',
  'directory-synced',
  'parent-synced',
]

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function configFor(stateDir: string, budgetUsd = 5) {
  return createStableDemoConfig({
    runId: 'atomic-init-test',
    stateDir,
    repoRoot: '/root/dsh-self-evolving',
    codeCommit: 'a'.repeat(40),
    budgetUsd,
  })
}

async function crashInitialization(
  config: ReturnType<typeof configFor>,
  checkpoint: InitializationCheckpoint,
): Promise<void> {
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [worker], {
        env: {
          ...process.env,
          DSH_INIT_CONFIG: JSON.stringify(config),
          DSH_INIT_KILL_AT: checkpoint,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })
      child.once('error', reject)
      child.once('close', (code, signal) => {
        if (code !== null || signal !== 'SIGKILL') {
          reject(
            new Error(
              `worker did not stop at ${checkpoint}: code=${code} signal=${signal}\n${stderr}`,
            ),
          )
          return
        }
        resolve({ code, signal })
      })
    },
  )
  expect(result).toEqual({ code: null, signal: 'SIGKILL' })
}

describe('atomic config initialization and crash recovery', () => {
  it.each(crashCheckpoints)('converges after SIGKILL at %s', async (checkpoint) => {
    const root = await mkdtemp(join(tmpdir(), `dsh-self-evolving-init-${checkpoint}-`))
    roots.push(root)
    const stateDir = join(root, 'state')
    const config = configFor(stateDir)

    await crashInitialization(config, checkpoint)
    await expect(initializeState(config)).resolves.toBe(configPath(stateDir))
    expect(JSON.parse(await readFile(configPath(stateDir), 'utf8'))).toEqual(config)
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700)
    expect((await stat(configPath(stateDir))).mode & 0o777).toBe(0o600)
    expect(await readdir(stateDir)).toEqual(['config.json'])
    const parentEntries = await readdir(root)
    expect(parentEntries).toContain('state')
    expect(
      parentEntries.filter((name) => /^\.dsh-init-[0-9a-f]{32}\.claim$/.test(name)),
    ).toHaveLength(1)
  })

  it('rejects a foreign existing directory without changing or populating it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-init-foreign-'))
    roots.push(root)
    const stateDir = join(root, 'state')
    const foreign = join(stateDir, 'foreign.txt')
    await mkdir(stateDir, { mode: 0o700 })
    await chmod(stateDir, 0o700)
    await writeFile(foreign, 'untouched\n')

    await expect(initializeState(configFor(stateDir))).rejects.toThrow(/unowned state directory/)
    expect(await readFile(foreign, 'utf8')).toBe('untouched\n')
    expect(await readdir(stateDir)).toEqual(['foreign.txt'])
    expect(await readdir(root)).toEqual(['state'])
  })

  it('does not follow or populate a symlinked state-directory parent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-init-parent-link-'))
    roots.push(root)
    const target = join(root, 'target')
    const linkedParent = join(root, 'linked-parent')
    await mkdir(target)
    await symlink(target, linkedParent, 'dir')

    await expect(initializeState(configFor(join(linkedParent, 'state')))).rejects.toThrow()
    expect(await readdir(target)).toEqual([])
  })

  it('does not adopt a claim for a conflicting initialization identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-init-conflict-'))
    roots.push(root)
    const stateDir = join(root, 'state')
    await crashInitialization(configFor(stateDir, 5), 'claim-published')

    await expect(initializeState(configFor(stateDir, 6))).rejects.toThrow(/claim conflicts/)
    await expect(readFile(configPath(stateDir))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the completed configuration authoritative for later conflicting initialization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-init-complete-conflict-'))
    roots.push(root)
    const stateDir = join(root, 'state')
    const winner = configFor(stateDir, 5)
    const conflicting = configFor(stateDir, 6)

    await initializeState(winner)
    const original = await readFile(configPath(stateDir), 'utf8')

    await expect(initializeState(conflicting)).rejects.toThrow(
      /authoritative config.json conflicts/,
    )
    expect(await readFile(configPath(stateDir), 'utf8')).toBe(original)
    expect(JSON.parse(original)).toEqual(winner)
  })

  it('serializes concurrent conflicting identities behind one durable claim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-init-identity-race-'))
    roots.push(root)
    const stateDir = join(root, 'state')
    const candidates = [configFor(stateDir, 5), configFor(stateDir, 6)]

    const results = await Promise.allSettled(candidates.map((config) => initializeState(config)))
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)

    const published = JSON.parse(await readFile(configPath(stateDir), 'utf8'))
    const winnerIndex = candidates.findIndex(
      (candidate) => candidate.limits.budgetUsd === published.limits.budgetUsd,
    )
    expect(winnerIndex).not.toBe(-1)
    const loserIndex = winnerIndex === 0 ? 1 : 0
    await expect(initializeState(candidates[winnerIndex]!)).resolves.toBe(configPath(stateDir))
    await expect(initializeState(candidates[loserIndex]!)).rejects.toThrow(
      /authoritative config.json conflicts/,
    )

    const claims = (await readdir(root)).filter((name) =>
      /^\.dsh-init-[0-9a-f]{32}\.claim$/.test(name),
    )
    expect(claims).toHaveLength(1)
  })

  it('fails closed on a legacy partial authoritative config without an ownership claim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-init-partial-'))
    roots.push(root)
    const stateDir = join(root, 'state')
    await mkdir(stateDir, { mode: 0o700 })
    await chmod(stateDir, 0o700)
    const partial = configPath(stateDir)
    await writeFile(partial, '{', { mode: 0o600 })
    await chmod(partial, 0o600)

    await expect(initializeState(configFor(stateDir))).rejects.toThrow(/config.json is malformed/)
    expect(await readFile(partial, 'utf8')).toBe('{')
    expect(await readdir(dirname(partial))).toEqual(['config.json'])
  })
})
