import { chmod, mkdir, open, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const CONFIG_SCHEMA_VERSION = 5 as const
export const STABLE_DEMO_PROFILE = 'stable-demo' as const

export interface StableDemoConfig {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION
  profile: typeof STABLE_DEMO_PROFILE
  runId: string
  stateDir: string
  repoRoot: string
  model: {
    provider: 'deepseek'
    requested: 'deepseek-v4-flash-zen'
    effective: 'deepseek-v4-flash'
    reasoningEffort: 'high'
    contextWindow: 1_048_576
    maxOutputTokens: 32_768
    wireApi: 'chat-completions-compatible'
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

export interface InitConfigInput {
  runId: string
  stateDir: string
  repoRoot: string
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
    model: {
      provider: 'deepseek',
      requested: 'deepseek-v4-flash-zen',
      effective: 'deepseek-v4-flash',
      reasoningEffort: 'high',
      contextWindow: 1_048_576,
      maxOutputTokens: 32_768,
      wireApi: 'chat-completions-compatible',
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

export function validateStableDemoConfig(value: unknown): StableDemoConfig {
  const c = value as Partial<StableDemoConfig> | null
  if (c === null || c.schemaVersion !== 5 || c.profile !== STABLE_DEMO_PROFILE) {
    throw new Error('config: unsupported schema/profile')
  }
  if (typeof c.runId !== 'string' || !RUN_ID.test(c.runId)) throw new Error('config: unsafe run id')
  if (typeof c.stateDir !== 'string' || !isAbsolute(c.stateDir)) {
    throw new Error('config: stateDir must be absolute')
  }
  if (typeof c.repoRoot !== 'string' || !isAbsolute(c.repoRoot)) {
    throw new Error('config: repoRoot must be absolute')
  }
  if (
    c.model?.provider !== 'deepseek' ||
    c.model.requested !== 'deepseek-v4-flash-zen' ||
    c.model.effective !== 'deepseek-v4-flash' ||
    c.model.reasoningEffort !== 'high' ||
    c.model.contextWindow !== 1_048_576 ||
    c.model.maxOutputTokens !== 32_768 ||
    c.model.wireApi !== 'chat-completions-compatible'
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

export async function initializeState(config: StableDemoConfig): Promise<string> {
  const path = configPath(config.stateDir)
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 })
  await chmod(config.stateDir, 0o700)
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(config, null, 2) + '\n')
    await handle.sync()
  } finally {
    await handle.close()
  }
  const parent = await open(dirname(path), 'r')
  try {
    await parent.sync()
  } finally {
    await parent.close()
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
