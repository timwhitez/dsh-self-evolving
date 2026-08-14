import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createStableDemoConfig,
  createV011DemoConfig,
  initializeState,
  loadConfig,
  loadProjectConfig,
  validateV011DemoConfig,
  validateStableDemoConfig,
} from '../src/index.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('stable-demo versioned config', () => {
  it('freezes the v0.1.1 successor protocol in a separate schema and profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rsi-cli-v011-config-'))
    roots.push(root)
    const stateDir = join(root, 'state')
    const config = createV011DemoConfig({
      runId: 'v011-stable-demo-test',
      stateDir,
      repoRoot: '/root/dsh-RSI',
      codeCommit: 'b'.repeat(40),
    })
    expect(config).toMatchObject({
      schemaVersion: 11,
      profile: 'v011-stable-demo',
      protocol: 'dsh-rsi-candidate-tree-v2',
      limits: { admittedChildren: 3, solverTrialsMax: 15 },
    })
    await initializeState(config)
    expect(await loadProjectConfig(stateDir)).toEqual(config)
    expect(() => validateV011DemoConfig({ ...config, protocol: 'v1' })).toThrow(
      /unsupported v0.1.1/,
    )
  })

  it('freezes K3, 15 solver trials, Zen/high/1M and writes a private no-replace config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rsi-cli-config-'))
    roots.push(root)
    const stateDir = join(root, 'state')
    const config = createStableDemoConfig({
      runId: 'stable-demo-test',
      stateDir,
      repoRoot: '/root/dsh-RSI',
      codeCommit: 'a'.repeat(40),
    })
    expect(config.limits).toMatchObject({
      admittedChildren: 3,
      solverTrialsMax: 15,
      baselineFailureDiscoveryMax: 12,
    })
    expect(config.model).toMatchObject({
      requested: 'deepseek-v4-flash-zen',
      reasoningEffort: 'high',
      contextWindow: 1_048_576,
    })
    const path = await initializeState(config)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await expect(initializeState(config)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await loadConfig(stateDir)).toEqual(config)
    expect(JSON.parse(await readFile(path, 'utf8'))).not.toHaveProperty('credential')
  })

  it('rejects model or stable-demo envelope drift', () => {
    const config = createStableDemoConfig({
      runId: 'stable-demo-test',
      stateDir: '/tmp/stable-demo-test',
      repoRoot: '/root/dsh-RSI',
      codeCommit: 'a'.repeat(40),
    })
    expect(() =>
      validateStableDemoConfig({ ...config, limits: { ...config.limits, solverTrialsMax: 16 } }),
    ).toThrow('limits drift')
    expect(() =>
      validateStableDemoConfig({
        ...config,
        model: { ...config.model, reasoningEffort: 'medium' },
      }),
    ).toThrow('model identity drift')
  })

  it('rejects a group-readable config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rsi-cli-perms-'))
    roots.push(root)
    const stateDir = join(root, 'state')
    const config = createStableDemoConfig({
      runId: 'stable-demo-test',
      stateDir,
      repoRoot: '/root/dsh-RSI',
      codeCommit: 'a'.repeat(40),
    })
    const path = await initializeState(config)
    await chmod(path, 0o640)
    await expect(loadConfig(stateDir)).rejects.toThrow('private regular file')
  })
})
