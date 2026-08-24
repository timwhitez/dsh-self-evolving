import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const CONFIG_SCHEMA_VERSION = 12 as const
export const STABLE_DEMO_PROFILE = 'stable-demo' as const
export const V011_CONFIG_SCHEMA_VERSION = 13 as const
export const V011_STABLE_DEMO_PROFILE = 'v011-stable-demo' as const

export interface StableDemoConfig {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION
  profile: typeof STABLE_DEMO_PROFILE
  runId: string
  stateDir: string
  repoRoot: string
  codeCommit: string
  model: {
    provider: 'deepseek'
    requested: 'deepseek-v4-flash'
    effective: 'deepseek-v4-flash'
    reasoningEffort: 'high'
    contextWindow: 1_048_576
    maxOutputTokens: 32_768
    endpoint: 'https://api.deepseek.com/v1'
    wireApi: 'responses'
    credentialEnv: 'DEEPSEEK_API_KEY'
  }
  limits: {
    admittedChildren: 3
    baselineFailureDiscoveryMax: 12
    candidateTrials: 3
    solverTrialsMax: 15
    concurrency: 1
    budgetUsd: number
  }
  splitCommitmentPath: string
  inventoryPath: string
  terminalBenchRoot: string
}

export interface V011DemoConfig extends Omit<StableDemoConfig, 'schemaVersion' | 'profile'> {
  schemaVersion: typeof V011_CONFIG_SCHEMA_VERSION
  profile: typeof V011_STABLE_DEMO_PROFILE
  protocol: 'dsh-self-evolving-candidate-tree-v2'
}

export type ProjectConfig = StableDemoConfig | V011DemoConfig

export interface InitConfigInput {
  runId: string
  stateDir: string
  repoRoot: string
  codeCommit: string
  terminalBenchRoot?: string
  budgetUsd?: number
}

const RUN_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/

export function configPath(stateDir: string): string {
  return join(resolve(stateDir), 'config.json')
}

export function createStableDemoConfig(input: InitConfigInput): StableDemoConfig {
  if (!RUN_ID.test(input.runId)) throw new Error('config: unsafe run id')
  const stateDir = resolve(input.stateDir)
  const repoRoot = resolve(input.repoRoot)
  if (!isAbsolute(stateDir) || !isAbsolute(repoRoot))
    throw new Error('config: paths must be absolute')
  const budgetUsd = input.budgetUsd ?? 5
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    throw new Error('config: budgetUsd must be a positive finite number')
  }
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    profile: STABLE_DEMO_PROFILE,
    runId: input.runId,
    stateDir,
    repoRoot,
    codeCommit: input.codeCommit,
    model: {
      provider: 'deepseek',
      requested: 'deepseek-v4-flash',
      effective: 'deepseek-v4-flash',
      reasoningEffort: 'high',
      contextWindow: 1_048_576,
      maxOutputTokens: 32_768,
      endpoint: 'https://api.deepseek.com/v1',
      wireApi: 'responses',
      credentialEnv: 'DEEPSEEK_API_KEY',
    },
    limits: {
      admittedChildren: 3,
      baselineFailureDiscoveryMax: 12,
      candidateTrials: 3,
      solverTrialsMax: 15,
      concurrency: 1,
      budgetUsd,
    },
    splitCommitmentPath: join(repoRoot, 'evidence', 'gate5', 'split-commitment.json'),
    inventoryPath: join(repoRoot, 'evidence', 'calibration', 'tb21-inventory.json'),
    terminalBenchRoot: resolve(input.terminalBenchRoot ?? '/tmp/tb21/terminal-bench-2-1'),
  }
}

export function createV011DemoConfig(input: InitConfigInput): V011DemoConfig {
  const predecessor = createStableDemoConfig(input)
  return {
    ...predecessor,
    schemaVersion: V011_CONFIG_SCHEMA_VERSION,
    profile: V011_STABLE_DEMO_PROFILE,
    protocol: 'dsh-self-evolving-candidate-tree-v2',
  }
}

export function validateStableDemoConfig(value: unknown): StableDemoConfig {
  const c = value as Partial<StableDemoConfig> | null
  if (
    c === null ||
    c.schemaVersion !== CONFIG_SCHEMA_VERSION ||
    c.profile !== STABLE_DEMO_PROFILE
  ) {
    throw new Error('config: unsupported schema/profile')
  }
  if (typeof c.runId !== 'string' || !RUN_ID.test(c.runId)) throw new Error('config: unsafe run id')
  if (typeof c.stateDir !== 'string' || !isAbsolute(c.stateDir)) {
    throw new Error('config: stateDir must be absolute')
  }
  if (typeof c.repoRoot !== 'string' || !isAbsolute(c.repoRoot)) {
    throw new Error('config: repoRoot must be absolute')
  }
  if (typeof c.codeCommit !== 'string' || !/^[0-9a-f]{40}$/.test(c.codeCommit)) {
    throw new Error('config: codeCommit must be a full Git commit')
  }
  if (
    c.model?.provider !== 'deepseek' ||
    c.model.requested !== 'deepseek-v4-flash' ||
    c.model.effective !== 'deepseek-v4-flash' ||
    c.model.reasoningEffort !== 'high' ||
    c.model.contextWindow !== 1_048_576 ||
    c.model.maxOutputTokens !== 32_768 ||
    c.model.endpoint !== 'https://api.deepseek.com/v1' ||
    c.model.wireApi !== 'responses' ||
    c.model.credentialEnv !== 'DEEPSEEK_API_KEY'
  ) {
    throw new Error('config: model identity drift')
  }
  if (
    c.limits?.admittedChildren !== 3 ||
    c.limits.baselineFailureDiscoveryMax !== 12 ||
    c.limits.candidateTrials !== 3 ||
    c.limits.solverTrialsMax !== 15 ||
    c.limits.concurrency !== 1 ||
    !Number.isFinite(c.limits.budgetUsd) ||
    c.limits.budgetUsd <= 0
  ) {
    throw new Error('config: stable-demo limits drift')
  }
  for (const path of [c.splitCommitmentPath, c.inventoryPath, c.terminalBenchRoot]) {
    if (typeof path !== 'string' || !isAbsolute(path))
      throw new Error('config: material path invalid')
  }
  return c as StableDemoConfig
}

export function validateV011DemoConfig(value: unknown): V011DemoConfig {
  const candidate = value as Partial<V011DemoConfig> | null
  if (
    candidate === null ||
    candidate.schemaVersion !== V011_CONFIG_SCHEMA_VERSION ||
    candidate.profile !== V011_STABLE_DEMO_PROFILE ||
    candidate.protocol !== 'dsh-self-evolving-candidate-tree-v2'
  ) {
    throw new Error('config: unsupported v0.1.1 schema/profile')
  }
  const predecessor = validateStableDemoConfig({
    ...candidate,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    profile: STABLE_DEMO_PROFILE,
  })
  return {
    ...predecessor,
    schemaVersion: V011_CONFIG_SCHEMA_VERSION,
    profile: V011_STABLE_DEMO_PROFILE,
    protocol: 'dsh-self-evolving-candidate-tree-v2',
  }
}

export async function initializeState(config: ProjectConfig): Promise<string> {
  if (process.platform !== 'linux') {
    throw new Error('config: secure initialization requires Linux directory descriptors')
  }

  const stateDir = resolve(config.stateDir)
  const path = configPath(stateDir)
  await mkdir(dirname(stateDir), { recursive: true, mode: 0o700 })

  // The final component is the ownership claim. A non-recursive mkdir is
  // atomic: every existing directory, file, or symlink fails with EEXIST and
  // is left untouched.
  await mkdir(stateDir, { mode: 0o700 })

  const directory = await open(
    stateDir,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    const claimed = await directory.stat({ bigint: true })
    if (!claimed.isDirectory() || (claimed.mode & 0o077n) !== 0n) {
      throw new Error('config: claimed stateDir is not a private directory')
    }

    // Address the file through the already-open directory. If the pathname is
    // renamed or replaced, initialization never follows the replacement.
    const descriptorPath = `/proc/self/fd/${directory.fd}/config.json`
    const handle = await open(descriptorPath, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(config, null, 2) + '\n')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await directory.sync()

    const published = await lstat(stateDir, { bigint: true })
    if (
      !published.isDirectory() ||
      published.isSymbolicLink() ||
      published.dev !== claimed.dev ||
      published.ino !== claimed.ino
    ) {
      throw new Error('config: stateDir identity changed during initialization')
    }
  } finally {
    await directory.close()
  }
  return path
}

export async function loadConfig(stateDir: string): Promise<StableDemoConfig> {
  const path = configPath(stateDir)
  const info = await stat(path)
  if (!info.isFile() || (info.mode & 0o077) !== 0) {
    throw new Error('config: config.json must be a private regular file')
  }
  const config = validateStableDemoConfig(JSON.parse(await readFile(path, 'utf8')))
  if ((await realpath(config.stateDir)) !== (await realpath(resolve(stateDir)))) {
    throw new Error('config: stateDir identity mismatch')
  }
  return config
}

async function loadPrivateConfigValue(stateDir: string): Promise<unknown> {
  const path = configPath(stateDir)
  const info = await stat(path)
  if (!info.isFile() || (info.mode & 0o077) !== 0) {
    throw new Error('config: config.json must be a private regular file')
  }
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

export async function loadV011Config(stateDir: string): Promise<V011DemoConfig> {
  const config = validateV011DemoConfig(await loadPrivateConfigValue(stateDir))
  if ((await realpath(config.stateDir)) !== (await realpath(resolve(stateDir)))) {
    throw new Error('config: stateDir identity mismatch')
  }
  return config
}

export async function loadProjectConfig(stateDir: string): Promise<ProjectConfig> {
  const value = await loadPrivateConfigValue(stateDir)
  const header = value as { profile?: unknown }
  const config =
    header.profile === V011_STABLE_DEMO_PROFILE
      ? validateV011DemoConfig(value)
      : validateStableDemoConfig(value)
  if ((await realpath(config.stateDir)) !== (await realpath(resolve(stateDir)))) {
    throw new Error('config: stateDir identity mismatch')
  }
  return config
}
