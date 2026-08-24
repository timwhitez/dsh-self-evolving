import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  type FileHandle,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { canonicalJson } from '@dsh-self-evolving/core'

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

export type InitializationCheckpoint =
  | 'claim-published'
  | 'directory-created'
  | 'staging-created'
  | 'staging-partial-write'
  | 'staging-full-write'
  | 'staging-synced'
  | 'config-published'
  | 'config-directory-synced'
  | 'staging-cleaned'
  | 'directory-synced'
  | 'parent-synced'

export interface InitializeStateOptions {
  /** Fault-injection boundary used by process-crash tests. */
  onCheckpoint?: (checkpoint: InitializationCheckpoint) => void | Promise<void>
}

interface InitializationClaim {
  version: 1
  stateDir: string
  configSha256: string
  claimId: string
}

const CLAIM_KEYS = ['claimId', 'configSha256', 'stateDir', 'version'] as const
const CLAIM_ID = /^[0-9a-f]{32}$/

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

function currentUid(): bigint {
  if (typeof process.geteuid !== 'function') {
    throw new Error('config: secure initialization requires an effective user id')
  }
  return BigInt(process.geteuid())
}

function assertPrivateOwner(
  info: { uid: bigint; mode: bigint },
  expectedMode: bigint,
  label: string,
): void {
  if (info.uid !== currentUid() || (info.mode & 0o777n) !== expectedMode) {
    throw new Error(
      `config: ${label} must be owned by the current user with mode 0${expectedMode.toString(8)}`,
    )
  }
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path, { bigint: true })
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

async function checkpoint(
  options: InitializeStateOptions,
  value: InitializationCheckpoint,
): Promise<void> {
  await options.onCheckpoint?.(value)
}

async function writeRange(
  handle: FileHandle,
  bytes: Buffer,
  start: number,
  end: number,
): Promise<void> {
  let offset = start
  while (offset < end) {
    const { bytesWritten } = await handle.write(bytes, offset, end - offset, offset)
    if (bytesWritten <= 0) throw new Error('config: staging write made no progress')
    offset += bytesWritten
  }
}

function validateProjectConfig(value: unknown): ProjectConfig {
  const profile = (value as { profile?: unknown } | null)?.profile
  return profile === V011_STABLE_DEMO_PROFILE
    ? validateV011DemoConfig(value)
    : validateStableDemoConfig(value)
}

function configIdentity(config: ProjectConfig): string {
  return canonicalJson(validateProjectConfig(config))
}

async function readPrivateRegularFile(
  path: string,
  label: string,
  maxBytes = 1_048_576,
): Promise<string | null> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw new Error(`config: cannot safely open ${label}`, { cause: error })
  }
  try {
    const info = await handle.stat({ bigint: true })
    if (!info.isFile()) throw new Error(`config: ${label} is not a regular file`)
    assertPrivateOwner(info, 0o600n, label)
    if (info.size > BigInt(maxBytes)) throw new Error(`config: ${label} exceeds ${maxBytes} bytes`)
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

function parseClaim(
  raw: string,
  expectedStateDir: string,
  expectedDigest: string,
): InitializationClaim {
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error('config: initialization claim is malformed', { cause: error })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('config: initialization claim is not an object')
  }
  const object = value as Record<string, unknown>
  if (canonicalJson(Object.keys(object).sort()) !== canonicalJson([...CLAIM_KEYS])) {
    throw new Error('config: initialization claim has an unknown schema')
  }
  if (
    object.version !== 1 ||
    object.stateDir !== expectedStateDir ||
    object.configSha256 !== expectedDigest ||
    typeof object.claimId !== 'string' ||
    !CLAIM_ID.test(object.claimId)
  ) {
    throw new Error('config: initialization claim conflicts with the requested configuration')
  }
  return object as unknown as InitializationClaim
}

async function readClaim(
  path: string,
  stateDir: string,
  digest: string,
): Promise<InitializationClaim | null> {
  const raw = await readPrivateRegularFile(path, 'initialization claim', 4096)
  return raw === null ? null : parseClaim(raw, stateDir, digest)
}

async function acquireClaim(
  claimPath: string,
  stateDir: string,
  digest: string,
  parentDirectory: { sync(): Promise<void> },
  options: InitializeStateOptions,
): Promise<InitializationClaim> {
  const existing = await readClaim(claimPath, stateDir, digest)
  if (existing !== null) {
    await checkpoint(options, 'claim-published')
    return existing
  }

  const claim: InitializationClaim = {
    version: 1,
    stateDir,
    configSha256: digest,
    claimId: randomBytes(16).toString('hex'),
  }
  const stagingPath = `${claimPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  const handle = await open(stagingPath, 'wx', 0o600)
  try {
    await handle.chmod(0o600)
    await handle.writeFile(JSON.stringify(claim) + '\n')
    await handle.sync()
  } finally {
    await handle.close()
  }

  let selected: InitializationClaim = claim
  try {
    await link(stagingPath, claimPath)
    await parentDirectory.sync()
  } catch (error) {
    if (errorCode(error) !== 'EEXIST' && errorCode(error) !== 'ENOENT') throw error
    const winner = await readClaim(claimPath, stateDir, digest)
    if (winner === null) {
      throw new Error('config: initialization claim disappeared', { cause: error })
    }
    selected = winner
  } finally {
    await rm(stagingPath, { force: true })
    await parentDirectory.sync()
  }
  await checkpoint(options, 'claim-published')
  return selected
}

async function openOrCreateParentDirectory(parent: string) {
  let directory = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    for (const component of resolve(parent).split('/').filter(Boolean)) {
      const entryPath = join(`/proc/self/fd/${directory.fd}`, component)
      let created = false
      try {
        await mkdir(entryPath, { mode: 0o700 })
        created = true
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error
      }
      if (created) await directory.sync()
      const next = await open(
        entryPath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      )
      const previous = directory
      directory = next
      await previous.close()
    }

    const claimed = await directory.stat({ bigint: true })
    const published = await lstat(parent, { bigint: true })
    if (
      !claimed.isDirectory() ||
      !published.isDirectory() ||
      published.isSymbolicLink() ||
      published.dev !== claimed.dev ||
      published.ino !== claimed.ino
    ) {
      throw new Error('config: stateDir parent identity is not stable')
    }
    return directory
  } catch (error) {
    await directory.close()
    throw error
  }
}

async function openVerifiedStateDirectory(entryPath: string, publishedStateDir = entryPath) {
  const directory = await open(
    entryPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    const claimed = await directory.stat({ bigint: true })
    const published = await lstat(publishedStateDir, { bigint: true })
    if (
      !claimed.isDirectory() ||
      !published.isDirectory() ||
      published.isSymbolicLink() ||
      published.dev !== claimed.dev ||
      published.ino !== claimed.ino
    ) {
      throw new Error('config: stateDir identity is not stable')
    }
    assertPrivateOwner(claimed, 0o700n, 'stateDir')
    return { directory, claimed }
  } catch (error) {
    await directory.close()
    throw error
  }
}

async function hasCompatibleConfig(
  descriptorDir: string,
  expectedIdentity: string,
): Promise<boolean> {
  const raw = await readPrivateRegularFile(join(descriptorDir, 'config.json'), 'config.json')
  if (raw === null) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error('config: authoritative config.json is malformed', { cause: error })
  }
  let actualIdentity: string
  try {
    actualIdentity = canonicalJson(validateProjectConfig(parsed))
  } catch (error) {
    throw new Error('config: authoritative config.json is invalid', { cause: error })
  }
  if (actualIdentity !== expectedIdentity) {
    throw new Error('config: authoritative config.json conflicts with requested initialization')
  }
  return true
}

function configStagingPrefix(claim: InitializationClaim): string {
  return `.config.json.${claim.claimId}.`
}

async function assertRecoverableDirectory(
  descriptorDir: string,
  claim: InitializationClaim,
): Promise<void> {
  const prefix = configStagingPrefix(claim)
  for (const name of await readdir(descriptorDir)) {
    if (name === 'config.json') continue
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) {
      throw new Error(`config: refusing to recover stateDir containing foreign entry ${name}`)
    }
    const info = await lstat(join(descriptorDir, name), { bigint: true }).catch((error) => {
      if (errorCode(error) === 'ENOENT') return null
      throw error
    })
    if (info === null) continue
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`config: refusing unsafe initialization staging entry ${name}`)
    }
    assertPrivateOwner(info, 0o600n, `initialization staging entry ${name}`)
  }
}

async function cleanupConfigStaging(
  descriptorDir: string,
  claim: InitializationClaim,
): Promise<void> {
  const prefix = configStagingPrefix(claim)
  for (const name of await readdir(descriptorDir)) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue
    const path = join(descriptorDir, name)
    const info = await lstat(path, { bigint: true }).catch((error) => {
      if (errorCode(error) === 'ENOENT') return null
      throw error
    })
    if (info === null) continue
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`config: refusing unsafe initialization staging entry ${name}`)
    }
    assertPrivateOwner(info, 0o600n, `initialization staging entry ${name}`)
    await rm(path).catch((error) => {
      if (errorCode(error) !== 'ENOENT') throw error
    })
  }
}

async function finalizeClaim(
  claimPath: string,
  claim: InitializationClaim,
  parentDirectory: { sync(): Promise<void> },
  options: InitializeStateOptions,
): Promise<void> {
  const existing = await readClaim(claimPath, claim.stateDir, claim.configSha256)
  if (existing === null) {
    throw new Error('config: initialization claim disappeared before finalization')
  }
  if (existing.claimId !== claim.claimId) {
    throw new Error('config: initialization claim identity changed before finalization')
  }

  const parent = dirname(claimPath)
  const stagingPrefix = `${basename(claimPath)}.`
  for (const name of await readdir(parent)) {
    if (!name.startsWith(stagingPrefix) || !name.endsWith('.tmp')) continue
    const path = join(parent, name)
    const info = await lstat(path, { bigint: true }).catch((error) => {
      if (errorCode(error) === 'ENOENT') return null
      throw error
    })
    if (info === null) continue
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`config: refusing unsafe claim staging entry ${name}`)
    }
    assertPrivateOwner(info, 0o600n, `claim staging entry ${name}`)
    await rm(path).catch((error) => {
      if (errorCode(error) !== 'ENOENT') throw error
    })
  }
  await parentDirectory.sync()
  await checkpoint(options, 'parent-synced')
}

export async function initializeState(
  config: ProjectConfig,
  options: InitializeStateOptions = {},
): Promise<string> {
  if (process.platform !== 'linux') {
    throw new Error('config: secure initialization requires Linux directory descriptors')
  }

  const validated = validateProjectConfig(config)
  const stateDir = resolve(validated.stateDir)
  const path = configPath(stateDir)
  const parent = dirname(stateDir)
  const expectedIdentity = configIdentity(validated)
  const configSha256 = createHash('sha256').update(expectedIdentity).digest('hex')
  const claimName = `.dsh-init-${createHash('sha256').update(stateDir).digest('hex').slice(0, 32)}.claim`
  const configBytes = Buffer.from(JSON.stringify(validated, null, 2) + '\n')

  const parentDirectory = await openOrCreateParentDirectory(parent)
  const descriptorParent = `/proc/self/fd/${parentDirectory.fd}`
  const stateEntryPath = join(descriptorParent, basename(stateDir))
  const claimPath = join(descriptorParent, claimName)

  try {
    const existingState = await lstatOrNull(stateDir)
    if (existingState !== null) {
      if (!existingState.isDirectory() || existingState.isSymbolicLink()) {
        throw new Error('config: refusing an existing non-directory or symlink stateDir')
      }
      const { directory } = await openVerifiedStateDirectory(stateEntryPath, stateDir)
      try {
        const descriptorDir = `/proc/self/fd/${directory.fd}`
        if (await hasCompatibleConfig(descriptorDir, expectedIdentity)) {
          const existingClaim = await readClaim(claimPath, stateDir, configSha256)
          if (existingClaim !== null) {
            await cleanupConfigStaging(descriptorDir, existingClaim)
            await directory.sync()
            await finalizeClaim(claimPath, existingClaim, parentDirectory, options)
          }
          return path
        }
      } finally {
        await directory.close()
      }
      if ((await readClaim(claimPath, stateDir, configSha256)) === null) {
        throw new Error('config: refusing to initialize an existing unowned state directory')
      }
    }

    const claim = await acquireClaim(claimPath, stateDir, configSha256, parentDirectory, options)

    try {
      await mkdir(stateEntryPath, { mode: 0o700 })
      await parentDirectory.sync()
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
    }
    await checkpoint(options, 'directory-created')

    const { directory, claimed } = await openVerifiedStateDirectory(stateEntryPath, stateDir)
    const descriptorDir = `/proc/self/fd/${directory.fd}`
    try {
      if (await hasCompatibleConfig(descriptorDir, expectedIdentity)) {
        await cleanupConfigStaging(descriptorDir, claim)
        await directory.sync()
        await finalizeClaim(claimPath, claim, parentDirectory, options)
        return path
      }
      await assertRecoverableDirectory(descriptorDir, claim)

      const stagingName = `${configStagingPrefix(claim)}${process.pid}.${randomBytes(8).toString('hex')}.tmp`
      const stagingPath = join(descriptorDir, stagingName)
      const handle = await open(stagingPath, 'wx', 0o600)
      try {
        await handle.chmod(0o600)
        await checkpoint(options, 'staging-created')
        const split = Math.max(1, Math.floor(configBytes.byteLength / 2))
        await writeRange(handle, configBytes, 0, split)
        await checkpoint(options, 'staging-partial-write')
        await writeRange(handle, configBytes, split, configBytes.byteLength)
        await checkpoint(options, 'staging-full-write')
        await handle.sync()
        await checkpoint(options, 'staging-synced')
      } finally {
        await handle.close()
      }

      const finalPath = join(descriptorDir, 'config.json')
      try {
        await link(stagingPath, finalPath)
      } catch (error) {
        if (
          (errorCode(error) !== 'EEXIST' && errorCode(error) !== 'ENOENT') ||
          !(await hasCompatibleConfig(descriptorDir, expectedIdentity))
        ) {
          throw error
        }
      }
      await checkpoint(options, 'config-published')
      await directory.sync()
      await checkpoint(options, 'config-directory-synced')

      await cleanupConfigStaging(descriptorDir, claim)
      await checkpoint(options, 'staging-cleaned')
      await directory.sync()
      await checkpoint(options, 'directory-synced')

      if (!(await hasCompatibleConfig(descriptorDir, expectedIdentity))) {
        throw new Error('config: atomic publication did not produce the expected config')
      }
      const published = await lstat(stateDir, { bigint: true })
      if (
        !published.isDirectory() ||
        published.isSymbolicLink() ||
        published.dev !== claimed.dev ||
        published.ino !== claimed.ino
      ) {
        throw new Error('config: stateDir identity changed during initialization')
      }
      await finalizeClaim(claimPath, claim, parentDirectory, options)
    } finally {
      await directory.close()
    }
    return path
  } finally {
    await parentDirectory.close()
  }
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
