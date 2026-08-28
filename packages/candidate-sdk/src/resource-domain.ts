import { createHash, randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { lstat, mkdir, readFile, realpath, rmdir, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { Readable, Writable } from 'node:stream'

export interface ResourcePolicyV1 {
  schemaVersion: 1
  policyId: string
  memoryMaxBytes: number
  memorySwapMaxBytes: number
  pidsMax: number
  cpuQuotaMicros: number
  cpuPeriodMicros: number
  cpuTimeSoftSeconds: number
  cpuTimeHardSeconds: number
  fileSizeMaxBytes: number
  openFilesMax: number
  ioReadBytesPerSecond: number
  ioWriteBytesPerSecond: number
  ioReadIops: number
  ioWriteIops: number
  writableStorageMaxBytes: number
  writableStorageMaxFiles: number
}

export type ResourceTerminationCause =
  | 'COMPLETED'
  | 'EXIT_NONZERO'
  | 'SIGNAL'
  | 'MEMORY_LIMIT'
  | 'PIDS_LIMIT'
  | 'CPU_TIME_LIMIT'
  | 'FILE_SIZE_LIMIT'
  | 'WRITABLE_STORAGE_LIMIT'
  | 'WALL_TIME_LIMIT'
  | 'OUTPUT_LIMIT'
  | 'CONTROL_PROTOCOL_FAILURE'
  | 'LAUNCH_FAILURE'

export interface ResourceUsage {
  memoryPeakBytes: number
  pidsPeak: number
  cpuUsageUsec: number
  cpuUserUsec: number
  cpuSystemUsec: number
  cpuThrottledUsec: number
  cpuThrottledPeriods: number
  ioReadBytes: number
  ioWriteBytes: number
  ioReadOps: number
  ioWriteOps: number
  writableStoragePeakBytes: number | null
  writableStoragePeakFiles: number | null
}

export interface ResourceEvents {
  memoryMaxEvents: number
  memoryOomEvents: number
  memoryOomKills: number
  pidsMaxEvents: number
}

export interface ResourceDomainReceipt {
  schemaVersion: 1
  policyDigest: `sha256:${string}`
  policy: ResourcePolicyV1
  enforcement: {
    cgroup: 'v2-delegated'
    rlimits: true
    ioDevices: string[]
    writableStorage: 'tmpfs-size-inode-hard-limit'
    writableStoragePeakSamplingMs: 10
    writableMounts: Array<{ path: string; maxBytes: number; maxFiles: number }>
    sandbox?: {
      filesystemRoot: 'read-only'
      writablePaths: 'bounded-tmpfs-only'
      nestedUserNamespaces: 'disabled'
      targetCapabilities: 'none'
      noNewPrivileges: true
    }
  }
  usage: ResourceUsage
  events: ResourceEvents
  terminationCause: ResourceTerminationCause
  exitCode: number | null
  signal: NodeJS.Signals | null
}

export interface ResourceBoundChild {
  child: ChildProcess & {
    stdin: Writable
    stdout: Readable
    stderr: Readable
  }
  control: Readable
  kill(cause: ResourceTerminationCause): Promise<void>
  finish(input?: {
    exitCode?: number | null
    signal?: NodeJS.Signals | null
    writableStoragePeakBytes?: number | null
    writableStoragePeakFiles?: number | null
    writableStorageLimitHit?: boolean
    writableMounts?: Array<{ path: string; maxBytes: number; maxFiles: number }>
  }): Promise<ResourceDomainReceipt>
}

interface CgroupMetrics {
  usage: Omit<ResourceUsage, 'writableStoragePeakBytes' | 'writableStoragePeakFiles'>
  events: ResourceEvents
}

const REQUIRED_CONTROLLERS = ['cpu', 'io', 'memory', 'pids'] as const
const CGROUP_PREFIX = 'domain-'
const MiB = 1024 * 1024

export const CANDIDATE_BUILD_RESOURCE_POLICY_V1: ResourcePolicyV1 = Object.freeze({
  schemaVersion: 1,
  policyId: 'candidate-build-v1',
  memoryMaxBytes: 1024 * MiB,
  memorySwapMaxBytes: 0,
  pidsMax: 64,
  cpuQuotaMicros: 100_000,
  cpuPeriodMicros: 100_000,
  cpuTimeSoftSeconds: 120,
  cpuTimeHardSeconds: 121,
  fileSizeMaxBytes: 16 * MiB,
  openFilesMax: 256,
  ioReadBytesPerSecond: 128 * MiB,
  ioWriteBytesPerSecond: 128 * MiB,
  ioReadIops: 8192,
  ioWriteIops: 8192,
  writableStorageMaxBytes: 128 * MiB,
  writableStorageMaxFiles: 512,
})

export const CANDIDATE_TEST_RESOURCE_POLICY_V1: ResourcePolicyV1 = Object.freeze({
  schemaVersion: 1,
  policyId: 'candidate-tests-v1',
  memoryMaxBytes: 1024 * MiB,
  memorySwapMaxBytes: 0,
  pidsMax: 128,
  cpuQuotaMicros: 100_000,
  cpuPeriodMicros: 100_000,
  cpuTimeSoftSeconds: 120,
  cpuTimeHardSeconds: 121,
  fileSizeMaxBytes: 16 * MiB,
  openFilesMax: 512,
  ioReadBytesPerSecond: 128 * MiB,
  ioWriteBytesPerSecond: 64 * MiB,
  ioReadIops: 8192,
  ioWriteIops: 4096,
  writableStorageMaxBytes: 128 * MiB,
  writableStorageMaxFiles: 4096,
})

export const CANDIDATE_RUNTIME_RESOURCE_POLICY_V1: ResourcePolicyV1 = Object.freeze({
  schemaVersion: 1,
  policyId: 'candidate-runtime-v1',
  memoryMaxBytes: 1024 * MiB,
  memorySwapMaxBytes: 0,
  pidsMax: 128,
  cpuQuotaMicros: 100_000,
  cpuPeriodMicros: 100_000,
  cpuTimeSoftSeconds: 60,
  cpuTimeHardSeconds: 61,
  fileSizeMaxBytes: 16 * MiB,
  openFilesMax: 512,
  ioReadBytesPerSecond: 128 * MiB,
  ioWriteBytesPerSecond: 64 * MiB,
  ioReadIops: 8192,
  ioWriteIops: 4096,
  writableStorageMaxBytes: 256 * MiB,
  writableStorageMaxFiles: 8192,
})

function integer(value: number, label: string, options: { allowZero?: boolean } = {}): void {
  if (!Number.isSafeInteger(value) || (options.allowZero === true ? value < 0 : value <= 0)) {
    throw new Error(
      `resource policy: ${label} must be a safe ${options.allowZero === true ? 'non-negative' : 'positive'} integer`,
    )
  }
}

export function validateResourcePolicy(policy: ResourcePolicyV1): ResourcePolicyV1 {
  if (policy.schemaVersion !== 1) throw new Error('resource policy: unsupported schemaVersion')
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(policy.policyId)) {
    throw new Error('resource policy: unsafe policyId')
  }
  integer(policy.memoryMaxBytes, 'memoryMaxBytes')
  integer(policy.memorySwapMaxBytes, 'memorySwapMaxBytes', { allowZero: true })
  integer(policy.pidsMax, 'pidsMax')
  integer(policy.cpuQuotaMicros, 'cpuQuotaMicros')
  integer(policy.cpuPeriodMicros, 'cpuPeriodMicros')
  integer(policy.cpuTimeSoftSeconds, 'cpuTimeSoftSeconds')
  integer(policy.cpuTimeHardSeconds, 'cpuTimeHardSeconds')
  integer(policy.fileSizeMaxBytes, 'fileSizeMaxBytes')
  integer(policy.openFilesMax, 'openFilesMax')
  integer(policy.ioReadBytesPerSecond, 'ioReadBytesPerSecond')
  integer(policy.ioWriteBytesPerSecond, 'ioWriteBytesPerSecond')
  integer(policy.ioReadIops, 'ioReadIops')
  integer(policy.ioWriteIops, 'ioWriteIops')
  integer(policy.writableStorageMaxBytes, 'writableStorageMaxBytes')
  integer(policy.writableStorageMaxFiles, 'writableStorageMaxFiles')
  if (policy.memorySwapMaxBytes !== 0) {
    throw new Error('resource policy: memorySwapMaxBytes must remain zero')
  }
  if (policy.cpuTimeHardSeconds < policy.cpuTimeSoftSeconds) {
    throw new Error('resource policy: cpuTimeHardSeconds must not be below cpuTimeSoftSeconds')
  }
  if (policy.cpuQuotaMicros > policy.cpuPeriodMicros) {
    throw new Error('resource policy: cpuQuotaMicros must not exceed one frozen CPU core')
  }
  return {
    schemaVersion: 1,
    policyId: policy.policyId,
    memoryMaxBytes: policy.memoryMaxBytes,
    memorySwapMaxBytes: policy.memorySwapMaxBytes,
    pidsMax: policy.pidsMax,
    cpuQuotaMicros: policy.cpuQuotaMicros,
    cpuPeriodMicros: policy.cpuPeriodMicros,
    cpuTimeSoftSeconds: policy.cpuTimeSoftSeconds,
    cpuTimeHardSeconds: policy.cpuTimeHardSeconds,
    fileSizeMaxBytes: policy.fileSizeMaxBytes,
    openFilesMax: policy.openFilesMax,
    ioReadBytesPerSecond: policy.ioReadBytesPerSecond,
    ioWriteBytesPerSecond: policy.ioWriteBytesPerSecond,
    ioReadIops: policy.ioReadIops,
    ioWriteIops: policy.ioWriteIops,
    writableStorageMaxBytes: policy.writableStorageMaxBytes,
    writableStorageMaxFiles: policy.writableStorageMaxFiles,
  }
}

export function resourcePolicyDigest(policy: ResourcePolicyV1): `sha256:${string}` {
  const validated = validateResourcePolicy(policy)
  return `sha256:${createHash('sha256').update(JSON.stringify(validated)).digest('hex')}`
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

async function writeControl(path: string, value: string): Promise<void> {
  await writeFile(path, value.endsWith('\n') ? value : `${value}\n`)
}

async function prepareCgroupRoot(): Promise<string> {
  if (process.platform !== 'linux') {
    throw new Error('resource domain: cgroup v2 requires Linux')
  }
  const configured = process.env['DSH_SELF_EVOLVING_CGROUP_ROOT']
  let root: string
  if (configured === undefined || configured.length === 0) {
    if (typeof process.geteuid !== 'function' || process.geteuid() !== 0) {
      throw new Error(
        'resource domain: DSH_SELF_EVOLVING_CGROUP_ROOT must name a delegated cgroup v2 directory',
      )
    }
    root = '/sys/fs/cgroup/dsh-self-evolving'
  } else {
    root = resolve(configured)
    if (root !== '/sys/fs/cgroup' && !root.startsWith(`/sys/fs/cgroup${sep}`)) {
      throw new Error('resource domain: configured cgroup root must be beneath /sys/fs/cgroup')
    }
  }
  try {
    await mkdir(root, { mode: 0o700 })
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error
  }
  const info = await lstat(root)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('resource domain: cgroup root must be a real directory')
  }
  if ((await realpath(root)) !== root) {
    throw new Error('resource domain: cgroup root path must be canonical')
  }
  const available = new Set(
    (await readFile(join(root, 'cgroup.controllers'), 'utf8')).trim().split(/\s+/),
  )
  for (const controller of REQUIRED_CONTROLLERS) {
    if (!available.has(controller)) {
      throw new Error(`resource domain: ${controller} controller is not delegated`)
    }
  }
  await writeControl(
    join(root, 'cgroup.subtree_control'),
    REQUIRED_CONTROLLERS.map((controller) => `+${controller}`).join(' '),
  )
  const enabled = new Set(
    (await readFile(join(root, 'cgroup.subtree_control'), 'utf8')).trim().split(/\s+/),
  )
  for (const controller of REQUIRED_CONTROLLERS) {
    if (!enabled.has(controller)) {
      throw new Error(`resource domain: ${controller} controller could not be enabled`)
    }
  }
  return root
}

async function ioDevices(): Promise<string[]> {
  const raw = await readFile('/sys/fs/cgroup/io.stat', 'utf8')
  const devices = raw
    .trim()
    .split('\n')
    .map((line) => /^(\d+:\d+)\b/.exec(line)?.[1])
    .filter((device): device is string => device !== undefined)
  if (devices.length === 0) {
    throw new Error('resource domain: no cgroup I/O device accounting is available')
  }
  return [...new Set(devices)].sort()
}

async function createDomain(policy: ResourcePolicyV1): Promise<{
  path: string
  ioDevices: string[]
}> {
  const root = await prepareCgroupRoot()
  const path = join(
    root,
    `${CGROUP_PREFIX}${process.pid}-${Date.now()}-${randomBytes(8).toString('hex')}`,
  )
  await mkdir(path, { mode: 0o700 })
  try {
    const devices = await ioDevices()
    await writeControl(join(path, 'memory.max'), String(policy.memoryMaxBytes))
    await writeControl(join(path, 'memory.swap.max'), String(policy.memorySwapMaxBytes))
    await writeControl(join(path, 'memory.oom.group'), '1')
    await writeControl(join(path, 'pids.max'), String(policy.pidsMax))
    await writeControl(join(path, 'cpu.max'), `${policy.cpuQuotaMicros} ${policy.cpuPeriodMicros}`)
    for (const device of devices) {
      await writeControl(
        join(path, 'io.max'),
        `${device} rbps=${policy.ioReadBytesPerSecond} wbps=${policy.ioWriteBytesPerSecond} riops=${policy.ioReadIops} wiops=${policy.ioWriteIops}`,
      )
    }
    return { path, ioDevices: devices }
  } catch (cause) {
    await rmdir(path).catch(() => undefined)
    throw new Error('resource domain: failed to configure cgroup limits', { cause })
  }
}

function parseKeyValues(raw: string): Map<string, number> {
  const values = new Map<string, number>()
  for (const line of raw.trim().split('\n')) {
    const [key, value] = line.trim().split(/\s+/, 2)
    if (key === undefined || value === undefined || !/^\d+$/.test(value)) continue
    values.set(key, Number(value))
  }
  return values
}

async function readNumber(path: string): Promise<number> {
  const raw = (await readFile(path, 'utf8')).trim()
  if (!/^\d+$/.test(raw)) throw new Error(`resource domain: invalid numeric metric at ${path}`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new Error(`resource domain: unsafe metric at ${path}`)
  return value
}

async function readMetrics(path: string): Promise<CgroupMetrics> {
  const [memoryPeakBytes, pidsPeak, cpuRaw, memoryRaw, pidsRaw, ioRaw] = await Promise.all([
    readNumber(join(path, 'memory.peak')),
    readNumber(join(path, 'pids.peak')),
    readFile(join(path, 'cpu.stat'), 'utf8'),
    readFile(join(path, 'memory.events'), 'utf8'),
    readFile(join(path, 'pids.events'), 'utf8'),
    readFile(join(path, 'io.stat'), 'utf8'),
  ])
  const cpu = parseKeyValues(cpuRaw)
  const memory = parseKeyValues(memoryRaw)
  const pids = parseKeyValues(pidsRaw)
  let ioReadBytes = 0
  let ioWriteBytes = 0
  let ioReadOps = 0
  let ioWriteOps = 0
  for (const line of ioRaw.trim().split('\n')) {
    const fields = new Map(
      line
        .trim()
        .split(/\s+/)
        .slice(1)
        .map((entry) => entry.split('=', 2) as [string, string]),
    )
    ioReadBytes += Number(fields.get('rbytes') ?? 0)
    ioWriteBytes += Number(fields.get('wbytes') ?? 0)
    ioReadOps += Number(fields.get('rios') ?? 0)
    ioWriteOps += Number(fields.get('wios') ?? 0)
  }
  return {
    usage: {
      memoryPeakBytes,
      pidsPeak,
      cpuUsageUsec: cpu.get('usage_usec') ?? 0,
      cpuUserUsec: cpu.get('user_usec') ?? 0,
      cpuSystemUsec: cpu.get('system_usec') ?? 0,
      cpuThrottledUsec: cpu.get('throttled_usec') ?? 0,
      cpuThrottledPeriods: cpu.get('nr_throttled') ?? 0,
      ioReadBytes,
      ioWriteBytes,
      ioReadOps,
      ioWriteOps,
    },
    events: {
      memoryMaxEvents: memory.get('max') ?? 0,
      memoryOomEvents: memory.get('oom') ?? 0,
      memoryOomKills: memory.get('oom_kill') ?? 0,
      pidsMaxEvents: pids.get('max') ?? 0,
    },
  }
}

async function processState(pid: number): Promise<string | null> {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8')
    const end = raw.lastIndexOf(') ')
    return end === -1 ? null : raw.slice(end + 2, end + 3)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

async function waitStopped(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const state = await processState(pid)
    if (state === 'T' || state === 't') return
    if (state === null || state === 'Z' || state === 'X') {
      throw new Error('resource domain: launcher exited before cgroup attachment')
    }
    await new Promise<void>((done) => setTimeout(done, 5))
  }
  throw new Error('resource domain: launcher did not stop for cgroup attachment')
}

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') throw error
  }
}

async function killDomain(path: string, pid: number): Promise<void> {
  try {
    await writeControl(join(path, 'cgroup.kill'), '1')
  } catch (error) {
    if (!['ENOENT', 'ESRCH'].includes(errorCode(error) ?? '')) throw error
    // The cgroup disappeared unexpectedly while its launcher may still be
    // alive. Fall back only on this error path; after normal child exit an
    // unconditional PGID signal could hit a recycled process id.
    killProcessGroup(pid)
  }
}

async function waitEmpty(path: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const events = parseKeyValues(await readFile(join(path, 'cgroup.events'), 'utf8'))
    if ((events.get('populated') ?? 0) === 0) return
    await new Promise<void>((done) => setTimeout(done, 10))
  }
  throw new Error('resource domain: cgroup remained populated after teardown')
}

function classifyTermination(input: {
  requested: ResourceTerminationCause | undefined
  events: ResourceEvents
  exitCode: number | null
  signal: NodeJS.Signals | null
  writableStorageLimitHit: boolean
  cpuUsageUsec: number
  cpuTimeHardSeconds: number
}): ResourceTerminationCause {
  if (input.requested !== undefined) return input.requested
  if (input.events.memoryOomKills > 0 || input.events.memoryOomEvents > 0) return 'MEMORY_LIMIT'
  if (input.events.pidsMaxEvents > 0) return 'PIDS_LIMIT'
  if (input.writableStorageLimitHit) return 'WRITABLE_STORAGE_LIMIT'
  if (
    input.signal === 'SIGXCPU' ||
    (input.signal === 'SIGKILL' &&
      input.cpuUsageUsec >= Math.max(0, input.cpuTimeHardSeconds * 1_000_000 - 100_000))
  ) {
    return 'CPU_TIME_LIMIT'
  }
  if (input.signal === 'SIGXFSZ') return 'FILE_SIZE_LIMIT'
  if (input.signal !== null) return 'SIGNAL'
  if (input.exitCode !== 0) return 'EXIT_NONZERO'
  return 'COMPLETED'
}

export async function spawnResourceBoundProcess(input: {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  policy: ResourcePolicyV1
}): Promise<ResourceBoundChild> {
  const policy = validateResourcePolicy(input.policy)
  const domain = await createDomain(policy)
  const launcherArgs = [
    '-c',
    'kill -STOP "$$"; exec "$@"',
    'dsh-resource-launcher',
    '/usr/bin/prlimit',
    `--fsize=${policy.fileSizeMaxBytes}:${policy.fileSizeMaxBytes}`,
    `--nofile=${policy.openFilesMax}:${policy.openFilesMax}`,
    `--cpu=${policy.cpuTimeSoftSeconds}:${policy.cpuTimeHardSeconds}`,
    '--core=0:0',
    '--',
    input.command,
    ...input.args,
  ]
  const spawned = spawn('/bin/sh', launcherArgs, {
    detached: true,
    env: input.env,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  })
  const child = spawned as ResourceBoundChild['child']
  const control = spawned.stdio[3]
  if (
    child.pid === undefined ||
    child.stdin === null ||
    child.stdout === null ||
    child.stderr === null
  ) {
    await rmdir(domain.path).catch(() => undefined)
    throw new Error('resource domain: launcher stdio/pid unavailable')
  }
  if (control === undefined || control === null || !('on' in control)) {
    killProcessGroup(child.pid)
    await rmdir(domain.path).catch(() => undefined)
    throw new Error('resource domain: control pipe unavailable')
  }
  const controlReadable = control as Readable
  let spawnError: Error | undefined
  child.once('error', (error) => {
    spawnError = error
  })
  const close = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.once('close', (exitCode, signal) => done({ exitCode, signal }))
  })
  try {
    await waitStopped(child.pid)
    await writeControl(join(domain.path, 'cgroup.procs'), String(child.pid))
    process.kill(child.pid, 'SIGCONT')
  } catch (cause) {
    // Attachment may have failed before the process entered the domain, so
    // terminate the stopped launcher explicitly as well as the empty domain.
    killProcessGroup(child.pid)
    await killDomain(domain.path, child.pid).catch(() => undefined)
    await close
    await waitEmpty(domain.path).catch(() => undefined)
    await rmdir(domain.path).catch(() => undefined)
    throw new Error('resource domain: failed to attach stopped launcher', { cause })
  }

  let requestedCause: ResourceTerminationCause | undefined
  let finishPromise: Promise<ResourceDomainReceipt> | undefined
  let killPromise: Promise<void> | undefined
  const kill = async (cause: ResourceTerminationCause): Promise<void> => {
    requestedCause ??= cause
    killPromise ??= killDomain(domain.path, child.pid!)
    await killPromise
  }
  const finish = (extra: Parameters<ResourceBoundChild['finish']>[0] = {}) => {
    finishPromise ??= (async () => {
      const launcher = await close
      if (spawnError !== undefined) requestedCause ??= 'LAUNCH_FAILURE'
      await killDomain(domain.path, child.pid!).catch((error) => {
        if (spawnError === undefined) throw error
      })
      await waitEmpty(domain.path)
      const metrics = await readMetrics(domain.path)
      await rmdir(domain.path)
      const exitCode = extra.exitCode === undefined ? launcher.exitCode : extra.exitCode
      const signal = extra.signal === undefined ? launcher.signal : extra.signal
      const writableStorageLimitHit = extra.writableStorageLimitHit ?? false
      return {
        schemaVersion: 1,
        policyDigest: resourcePolicyDigest(policy),
        policy,
        enforcement: {
          cgroup: 'v2-delegated',
          rlimits: true,
          ioDevices: domain.ioDevices,
          writableStorage: 'tmpfs-size-inode-hard-limit',
          writableStoragePeakSamplingMs: 10,
          writableMounts: extra.writableMounts ?? [],
        },
        usage: {
          ...metrics.usage,
          writableStoragePeakBytes: extra.writableStoragePeakBytes ?? null,
          writableStoragePeakFiles: extra.writableStoragePeakFiles ?? null,
        },
        events: metrics.events,
        terminationCause: classifyTermination({
          requested: requestedCause,
          events: metrics.events,
          exitCode,
          signal,
          writableStorageLimitHit,
          cpuUsageUsec: metrics.usage.cpuUsageUsec,
          cpuTimeHardSeconds: policy.cpuTimeHardSeconds,
        }),
        exitCode,
        signal,
      }
    })()
    return finishPromise
  }
  return { child, control: controlReadable, kill, finish }
}

export async function runResourceBoundCommand(input: {
  command: string
  args: string[]
  timeoutMs: number
  maxOutputBytes: number
  policy: ResourcePolicyV1
}): Promise<{
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  resource: ResourceDomainReceipt
}> {
  integer(input.timeoutMs, 'timeoutMs')
  integer(input.maxOutputBytes, 'maxOutputBytes')
  const domain = await spawnResourceBoundProcess({
    command: input.command,
    args: input.args,
    env: { PATH: '/usr/bin:/bin' },
    policy: input.policy,
  })
  domain.child.stdin.destroy()
  domain.control.resume()
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let outputBytes = 0
  const collect = (target: Buffer[]) => (chunk: Buffer) => {
    outputBytes += chunk.byteLength
    if (outputBytes > input.maxOutputBytes) {
      void domain.kill('OUTPUT_LIMIT')
      return
    }
    target.push(chunk)
  }
  domain.child.stdout.on('data', collect(stdout))
  domain.child.stderr.on('data', collect(stderr))
  const timer = setTimeout(() => void domain.kill('WALL_TIME_LIMIT'), input.timeoutMs)
  const completion = await new Promise<{
    exitCode: number | null
    signal: NodeJS.Signals | null
  }>((done) => {
    domain.child.once('close', (exitCode, signal) => done({ exitCode, signal }))
  })
  clearTimeout(timer)
  const resource = await domain.finish(completion)
  return {
    ...completion,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
    resource,
  }
}
