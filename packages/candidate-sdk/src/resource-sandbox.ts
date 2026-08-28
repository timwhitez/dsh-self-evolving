import { lstat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  spawnResourceBoundProcess,
  type ResourceBoundChild,
  type ResourceDomainReceipt,
  type ResourcePolicyV1,
  type ResourceTerminationCause,
} from './resource-domain.js'

export interface WritableSandboxMount {
  path: '/tmp' | '/dev/shm' | '/output' | '/workspace' | '/logs' | '/work/children'
  maxBytes: number
  maxFiles: number
  exportFiles: boolean
  /** Optional read-only sandbox path copied into the bounded tmpfs before launch. */
  seedPath?: string
}

export interface ResourceSandboxFile {
  mountPath: WritableSandboxMount['path']
  path: string
  bytes: Uint8Array
}

export interface ResourceSandboxResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  files: ResourceSandboxFile[]
  resource: ResourceDomainReceipt
}

export interface ResourceSandboxProcess {
  child: ResourceBoundChild['child']
  kill(cause: ResourceTerminationCause): Promise<void>
  finish(): Promise<ResourceSandboxResult>
}

interface SupervisorControl {
  schemaVersion: 1
  exitCode: number | null
  signal: NodeJS.Signals | null
  mountPeaks: Array<{
    path: string
    maxBytes: number
    maxFiles: number
    peakBytes: number
    peakFiles: number
    limitHit: boolean
  }>
  files: Array<{ mountPath: string; path: string; bytesBase64: string }>
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`resource sandbox: ${label} must be a positive safe integer`)
  }
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

async function supervisorPath(): Promise<string> {
  const directory = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(directory, 'resource-sandbox-supervisor.js'),
    join(directory, '..', 'lib', 'resource-sandbox-supervisor.js'),
  ]
  for (const candidate of candidates) {
    const info = await lstat(candidate).catch(() => null)
    if (info?.isFile() === true && !info.isSymbolicLink()) return candidate
  }
  throw new Error('resource sandbox: trusted supervisor module is not built')
}

function validateMounts(
  mounts: WritableSandboxMount[],
  policy: ResourcePolicyV1,
): WritableSandboxMount[] {
  if (mounts.length === 0)
    throw new Error('resource sandbox: at least one writable mount is required')
  const seen = new Set<string>()
  let totalBytes = 0
  let totalFiles = 0
  const validated = mounts.map((mount) => {
    if (!isAbsolute(mount.path) || seen.has(mount.path)) {
      throw new Error('resource sandbox: duplicate/non-absolute writable mount')
    }
    seen.add(mount.path)
    positiveInteger(mount.maxBytes, 'mount maxBytes')
    positiveInteger(mount.maxFiles, 'mount maxFiles')
    if (
      mount.seedPath !== undefined &&
      (!mount.seedPath.startsWith('/input/') ||
        mount.seedPath.includes('\\') ||
        mount.seedPath.includes('\0') ||
        mount.seedPath
          .split('/')
          .some(
            (segment, index) =>
              index > 0 && (segment === '' || segment === '.' || segment === '..'),
          ))
    ) {
      throw new Error('resource sandbox: seedPath must be a canonical path below /input')
    }
    totalBytes += mount.maxBytes
    totalFiles += mount.maxFiles
    if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(totalFiles)) {
      throw new Error('resource sandbox: aggregate writable mount policy is unsafe')
    }
    return { ...mount }
  })
  if (totalBytes > policy.writableStorageMaxBytes) {
    throw new Error('resource sandbox: writable mount bytes exceed frozen policy')
  }
  if (totalFiles > policy.writableStorageMaxFiles) {
    throw new Error('resource sandbox: writable mount files exceed frozen policy')
  }
  return validated
}

function parseSignal(value: unknown): NodeJS.Signals | null {
  if (value === null) return null
  if (typeof value !== 'string' || !/^SIG[A-Z0-9]+$/.test(value)) {
    throw new Error('resource sandbox: invalid target signal')
  }
  return value as NodeJS.Signals
}

function parseControl(bytes: Uint8Array, mounts: WritableSandboxMount[]): SupervisorControl {
  if (bytes.byteLength === 0 || bytes[bytes.byteLength - 1] !== 0x0a) {
    throw new Error('resource sandbox: supervisor control is missing or unterminated')
  }
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, -1)))
  } catch (cause) {
    throw new Error('resource sandbox: invalid supervisor control JSON/UTF-8', { cause })
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value as Record<string, unknown>, [
      'schemaVersion',
      'exitCode',
      'signal',
      'mountPeaks',
      'files',
    ])
  ) {
    throw new Error('resource sandbox: invalid supervisor control envelope')
  }
  const record = value as Record<string, unknown>
  if (
    record['schemaVersion'] !== 1 ||
    (record['exitCode'] !== null &&
      (typeof record['exitCode'] !== 'number' ||
        !Number.isSafeInteger(record['exitCode']) ||
        record['exitCode'] < 0 ||
        record['exitCode'] > 255)) ||
    !Array.isArray(record['mountPeaks']) ||
    !Array.isArray(record['files'])
  ) {
    throw new Error('resource sandbox: invalid supervisor control fields')
  }
  const signal = parseSignal(record['signal'])
  const peaks = record['mountPeaks'].map((entry, index) => {
    const expected = mounts[index]
    if (
      expected === undefined ||
      entry === null ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      !exactKeys(entry as Record<string, unknown>, [
        'path',
        'maxBytes',
        'maxFiles',
        'peakBytes',
        'peakFiles',
        'limitHit',
      ])
    ) {
      throw new Error('resource sandbox: invalid mount peak entry')
    }
    const peak = entry as Record<string, unknown>
    if (
      peak['path'] !== expected.path ||
      peak['maxBytes'] !== expected.maxBytes ||
      peak['maxFiles'] !== expected.maxFiles ||
      typeof peak['peakBytes'] !== 'number' ||
      !Number.isSafeInteger(peak['peakBytes']) ||
      peak['peakBytes'] < 0 ||
      peak['peakBytes'] > expected.maxBytes ||
      typeof peak['peakFiles'] !== 'number' ||
      !Number.isSafeInteger(peak['peakFiles']) ||
      peak['peakFiles'] < 0 ||
      peak['peakFiles'] > expected.maxFiles ||
      typeof peak['limitHit'] !== 'boolean'
    ) {
      throw new Error('resource sandbox: mount peak does not match frozen policy')
    }
    return {
      path: expected.path,
      maxBytes: expected.maxBytes,
      maxFiles: expected.maxFiles,
      peakBytes: peak['peakBytes'],
      peakFiles: peak['peakFiles'],
      limitHit: peak['limitHit'],
    }
  })
  if (peaks.length !== mounts.length) {
    throw new Error('resource sandbox: mount peak inventory is incomplete')
  }
  return {
    schemaVersion: 1,
    exitCode: record['exitCode'] as number | null,
    signal,
    mountPeaks: peaks,
    files: record['files'] as SupervisorControl['files'],
  }
}

function decodeFiles(
  control: SupervisorControl,
  mounts: WritableSandboxMount[],
): ResourceSandboxFile[] {
  const counts = new Map<string, number>()
  const bytesByMount = new Map<string, number>()
  const seen = new Set<string>()
  return control.files.map((entry) => {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      !exactKeys(entry as unknown as Record<string, unknown>, ['mountPath', 'path', 'bytesBase64'])
    ) {
      throw new Error('resource sandbox: invalid exported file entry')
    }
    const mount = mounts.find((candidate) => candidate.path === entry.mountPath)
    if (
      mount === undefined ||
      !mount.exportFiles ||
      typeof entry.path !== 'string' ||
      entry.path.length === 0 ||
      entry.path.startsWith('/') ||
      entry.path.includes('\\') ||
      entry.path
        .split('/')
        .some((segment) => segment === '' || segment === '.' || segment === '..') ||
      typeof entry.bytesBase64 !== 'string'
    ) {
      throw new Error('resource sandbox: exported file violates mount/path policy')
    }
    const collision = `${mount.path}:${entry.path.normalize('NFC').toLowerCase()}`
    if (seen.has(collision)) throw new Error('resource sandbox: duplicate/colliding exported file')
    seen.add(collision)
    const bytes = Buffer.from(entry.bytesBase64, 'base64')
    if (bytes.toString('base64') !== entry.bytesBase64) {
      throw new Error('resource sandbox: exported file has non-canonical base64')
    }
    const count = (counts.get(mount.path) ?? 0) + 1
    const totalBytes = (bytesByMount.get(mount.path) ?? 0) + bytes.byteLength
    if (count > mount.maxFiles || totalBytes > mount.maxBytes) {
      throw new Error('resource sandbox: exported files exceed frozen mount policy')
    }
    counts.set(mount.path, count)
    bytesByMount.set(mount.path, totalBytes)
    return { mountPath: mount.path, path: entry.path, bytes: new Uint8Array(bytes) }
  })
}

export async function spawnResourceBoundSandbox(input: {
  bwrapArgs: string[]
  sandboxNode: string
  targetCommand: string
  targetArgs: string[]
  mounts: WritableSandboxMount[]
  policy: ResourcePolicyV1
}): Promise<ResourceSandboxProcess> {
  const forbiddenWritableOptions = new Set([
    '--bind',
    '--bind-try',
    '--dev-bind',
    '--dev-bind-try',
    '--tmpfs',
    '--file',
    '--bind-data',
    '--overlay',
    '--tmp-overlay',
  ])
  if (
    input.bwrapArgs.includes('--') ||
    !input.bwrapArgs.includes('--unshare-all') ||
    !input.bwrapArgs.includes('--clearenv') ||
    input.bwrapArgs.includes('--cap-drop') ||
    input.bwrapArgs.some((argument) => forbiddenWritableOptions.has(argument))
  ) {
    throw new Error('resource sandbox: bwrap base args violate supervisor contract')
  }
  if (!isAbsolute(input.sandboxNode) || !isAbsolute(input.targetCommand)) {
    throw new Error('resource sandbox: node/target command must be absolute in sandbox')
  }
  const mounts = validateMounts(input.mounts, input.policy)
  const supervisor = await supervisorPath()
  const encodedConfig = Buffer.from(JSON.stringify({ schemaVersion: 1, mounts })).toString(
    'base64url',
  )
  const bwrapArgs = [
    ...input.bwrapArgs,
    '--ro-bind',
    supervisor,
    '/resource-sandbox-supervisor.mjs',
    '--unshare-user',
    '--remount-ro',
    '/',
    '--remount-ro',
    '/dev',
    '--',
    input.sandboxNode,
    '/resource-sandbox-supervisor.mjs',
    encodedConfig,
    input.targetCommand,
    ...input.targetArgs,
  ]
  const domain = await spawnResourceBoundProcess({
    command: '/usr/bin/bwrap',
    args: bwrapArgs,
    env: { PATH: '/usr/bin:/bin' },
    policy: input.policy,
  })
  const controlChunks: Buffer[] = []
  let controlBytes = 0
  const exportedBytes = mounts
    .filter((mount) => mount.exportFiles)
    .reduce((total, mount) => total + mount.maxBytes, 0)
  const maxControlBytes = Math.max(1024 * 1024, exportedBytes * 2 + 1024 * 1024)
  domain.control.on('data', (chunk: Buffer) => {
    controlBytes += chunk.byteLength
    if (controlBytes > maxControlBytes) {
      void domain.kill('CONTROL_PROTOCOL_FAILURE')
      return
    }
    controlChunks.push(chunk)
  })
  const controlEnded = new Promise<void>((done) => {
    domain.control.once('end', done)
    domain.control.once('close', done)
  })
  let finishPromise: Promise<ResourceSandboxResult> | undefined
  const finish = (): Promise<ResourceSandboxResult> => {
    finishPromise ??= (async () => {
      await controlEnded
      let control: SupervisorControl | undefined
      let controlError: Error | undefined
      try {
        control = parseControl(Buffer.concat(controlChunks), mounts)
      } catch (error) {
        controlError = error as Error
      }
      const peakBytes =
        control?.mountPeaks.reduce((total, peak) => total + peak.peakBytes, 0) ?? null
      const peakFiles =
        control?.mountPeaks.reduce((total, peak) => total + peak.peakFiles, 0) ?? null
      const resource = await domain.finish({
        ...(control === undefined ? {} : { exitCode: control.exitCode, signal: control.signal }),
        writableStoragePeakBytes: peakBytes,
        writableStoragePeakFiles: peakFiles,
        writableStorageLimitHit: control?.mountPeaks.some((peak) => peak.limitHit) ?? false,
        writableMounts: mounts.map(({ path, maxBytes, maxFiles }) => ({
          path,
          maxBytes,
          maxFiles,
        })),
      })
      resource.enforcement.sandbox = {
        filesystemRoot: 'read-only',
        writablePaths: 'bounded-tmpfs-only',
        nestedUserNamespaces: 'disabled',
        targetCapabilities: 'none',
        noNewPrivileges: true,
      }
      if (control === undefined) {
        if (
          ![
            'MEMORY_LIMIT',
            'PIDS_LIMIT',
            'CPU_TIME_LIMIT',
            'WALL_TIME_LIMIT',
            'OUTPUT_LIMIT',
            'FILE_SIZE_LIMIT',
          ].includes(resource.terminationCause)
        ) {
          resource.terminationCause = 'CONTROL_PROTOCOL_FAILURE'
        }
        return {
          exitCode: resource.exitCode,
          signal: resource.signal,
          files: [],
          resource,
        }
      }
      if (controlError !== undefined) throw controlError
      return {
        exitCode: control.exitCode,
        signal: control.signal,
        files: decodeFiles(control, mounts),
        resource,
      }
    })()
    return finishPromise
  }
  return { child: domain.child, kill: domain.kill, finish }
}
