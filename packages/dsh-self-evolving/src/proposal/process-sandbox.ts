/** Bubblewrap-backed one-shot proposal process sandbox (spec 05 §§5.2, 9). */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  spawnResourceBoundSandbox,
  type ResourceDomainReceipt,
  type ResourcePolicyV1,
  type ResourceSandboxFile,
} from '@dsh-self-evolving/candidate-sdk'

export interface ProposalSandboxMounts {
  parent: string
  archive: string
  evidence: string
  contracts: string
  childrenRoot: string
}

export interface ProposalSandboxInput {
  mounts: ProposalSandboxMounts
  /** Trusted immutable runtime closure, mounted read-only at /runtime. */
  runtimeRoot?: string
  /** Absolute path as seen inside the sandbox. */
  command: string
  args: string[]
  timeoutMs: number
  maxOutputBytes?: number
  /** Optional fixed trusted gateway Unix socket; the sandbox still has no network. */
  gatewaySocket?: string
}

export interface ProposalSandboxResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  resource: ResourceDomainReceipt
}

const MiB = 1024 * 1024

export const PROPOSAL_RESOURCE_POLICY_V1: ResourcePolicyV1 = Object.freeze({
  schemaVersion: 1,
  policyId: 'proposal-sandbox-v1',
  memoryMaxBytes: 1536 * MiB,
  memorySwapMaxBytes: 0,
  pidsMax: 128,
  cpuQuotaMicros: 100_000,
  cpuPeriodMicros: 100_000,
  cpuTimeSoftSeconds: 600,
  cpuTimeHardSeconds: 601,
  fileSizeMaxBytes: 16 * MiB,
  openFilesMax: 512,
  ioReadBytesPerSecond: 128 * MiB,
  ioWriteBytesPerSecond: 64 * MiB,
  ioReadIops: 8192,
  ioWriteIops: 4096,
  writableStorageMaxBytes: 64 * MiB,
  writableStorageMaxFiles: 2048,
})

async function assertTreeHasNoSymlink(root: string, label: string): Promise<string> {
  const rootStat = await lstat(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`proposal sandbox: ${label} root must be a real directory without symlink`)
  }
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) {
        throw new Error(`proposal sandbox: symlink rejected in ${label}: ${path}`)
      }
      if (info.isDirectory()) await walk(path)
      else if (!info.isFile()) {
        throw new Error(`proposal sandbox: special file rejected in ${label}: ${path}`)
      }
    }
  }
  await walk(root)
  return realpath(root)
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(right + sep) || right.startsWith(left + sep)
}

/**
 * Lexically canonicalize a sandbox-namespace absolute path and reject any
 * relative, empty, `.` or `..` component. The kernel resolves these components
 * at execve time, so an unnormalized prefix match would authorize executables
 * outside the allowed subtrees.
 */
export function normalizeSandboxPath(path: string): string {
  if (!isAbsolute(path)) throw new Error('proposal sandbox: path must be absolute')
  if (path.includes('\0')) throw new Error('proposal sandbox: path must not contain NUL')
  const components = path.split(sep)
  const normalized: string[] = []
  // split('/') on '/a/b' yields ['', 'a', 'b']; the leading empty component is
  // the root and a trailing separator would produce a trailing empty component.
  for (let index = 1; index < components.length; index += 1) {
    const component = components[index]!
    if (component === '' || component === '.') {
      throw new Error(`proposal sandbox: non-canonical path component in ${path}`)
    }
    if (component === '..') {
      throw new Error(`proposal sandbox: parent traversal rejected in ${path}`)
    }
    normalized.push(component)
  }
  if (normalized.length === 0) {
    throw new Error('proposal sandbox: path must not be the root')
  }
  return sep + normalized.join('/')
}

function validateCommand(command: string): void {
  const canonical = normalizeSandboxPath(command)
  const allowed = new Set(['/usr/bin/node', '/bin/sh', '/usr/bin/env'])
  if (
    !allowed.has(canonical) &&
    !canonical.startsWith('/input/contracts/') &&
    !canonical.startsWith('/runtime/')
  ) {
    throw new Error(`proposal sandbox: command is outside the executable allowlist: ${command}`)
  }
}

async function materializeExport(root: string, files: ResourceSandboxFile[]): Promise<void> {
  const stage = join(dirname(root), `.${basename(root)}-resource-export-${randomUUID()}`)
  const backup = join(dirname(root), `.${basename(root)}-resource-backup-${randomUUID()}`)
  await mkdir(stage, { mode: 0o700 })
  let movedOriginal = false
  let installed = false
  try {
    for (const file of files) {
      if (file.mountPath !== '/work/children') {
        throw new Error(`proposal sandbox: unexpected exported mount ${file.mountPath}`)
      }
      const destination = resolve(stage, file.path)
      const rel = relative(stage, destination)
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`proposal sandbox: exported path escapes childrenRoot: ${file.path}`)
      }
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      await writeFile(destination, file.bytes, { flag: 'wx', mode: 0o600 })
    }
    await rename(root, backup)
    movedOriginal = true
    await rename(stage, root)
    installed = true
    await rm(backup, { recursive: true, force: true })
  } catch (error) {
    if (movedOriginal && !installed) await rename(backup, root).catch(() => undefined)
    throw error
  } finally {
    if (!installed) await rm(stage, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function runProposalSandbox(
  input: ProposalSandboxInput,
): Promise<ProposalSandboxResult> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error('proposal sandbox: timeoutMs must be a positive integer')
  }
  validateCommand(input.command)
  const resolved: ProposalSandboxMounts = {
    parent: await assertTreeHasNoSymlink(resolve(input.mounts.parent), 'parent'),
    archive: await assertTreeHasNoSymlink(resolve(input.mounts.archive), 'archive'),
    evidence: await assertTreeHasNoSymlink(resolve(input.mounts.evidence), 'evidence'),
    contracts: await assertTreeHasNoSymlink(resolve(input.mounts.contracts), 'contracts'),
    childrenRoot: await assertTreeHasNoSymlink(resolve(input.mounts.childrenRoot), 'childrenRoot'),
  }
  const allRoots = Object.entries(resolved)
  const runtimeRoot =
    input.runtimeRoot === undefined
      ? undefined
      : await assertTreeHasNoEscapingSymlink(resolve(input.runtimeRoot), 'runtime')
  if (runtimeRoot !== undefined) {
    for (const [label, root] of allRoots) {
      if (overlaps(runtimeRoot, root)) {
        throw new Error(`proposal sandbox: runtime overlaps ${label}`)
      }
    }
  }
  for (let left = 0; left < allRoots.length; left += 1) {
    for (let right = left + 1; right < allRoots.length; right += 1) {
      if (overlaps(allRoots[left]![1], allRoots[right]![1])) {
        throw new Error(
          `proposal sandbox: mount roots overlap: ${allRoots[left]![0]} and ${allRoots[right]![0]}`,
        )
      }
    }
  }

  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-all',
    '--hostname',
    'dsh-self-evolving-proposer',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind',
    '/bin',
    '/bin',
    '--ro-bind',
    '/lib',
    '/lib',
    '--ro-bind',
    '/lib64',
    '/lib64',
    '--ro-bind',
    '/etc/hosts',
    '/etc/hosts',
    '--ro-bind',
    '/etc/nsswitch.conf',
    '/etc/nsswitch.conf',
    '--dir',
    '/input',
    '--ro-bind',
    resolved.parent,
    '/input/parent',
    '--ro-bind',
    resolved.archive,
    '/input/archive',
    '--ro-bind',
    resolved.evidence,
    '/input/evidence',
    '--ro-bind',
    resolved.contracts,
    '/input/contracts',
    '--ro-bind',
    resolved.childrenRoot,
    '/input/children-seed',
    '--dir',
    '/work',
    '--dir',
    '/work/children',
    '--dir',
    '/tmp',
    '--dir',
    '/run',
    '--clearenv',
    '--setenv',
    'PATH',
    '/usr/bin:/bin',
    '--setenv',
    'DSH_SELF_EVOLVING_SANDBOX',
    'proposal',
    '--chdir',
    '/work/children',
  ]
  let sandboxCommand = input.command
  const hostNode = await realpath(process.execPath)
  const needsHostNode = runtimeRoot === undefined || input.command === '/usr/bin/node'
  if (needsHostNode && hostNode !== '/usr/bin/node') {
    args.push('--dir', '/sandbox-bin', '--ro-bind', hostNode, '/sandbox-bin/node')
    if (input.command === '/usr/bin/node') sandboxCommand = '/sandbox-bin/node'
  }
  if (input.gatewaySocket !== undefined) {
    const socket = await realpath(input.gatewaySocket)
    const socketStat = await lstat(socket)
    if (!socketStat.isSocket()) throw new Error('proposal sandbox: gateway must be a Unix socket')
    args.push('--ro-bind', socket, '/run/proposer-gateway.sock')
  }
  if (runtimeRoot !== undefined) {
    args.push('--ro-bind', runtimeRoot, '/runtime')
    const runtimeModules = join(runtimeRoot, 'node_modules')
    if ((await stat(runtimeModules).catch(() => null))?.isDirectory() === true) {
      args.push('--ro-bind', runtimeModules, '/node_modules')
    }
  }
  const supervisorNode =
    runtimeRoot === undefined
      ? hostNode === '/usr/bin/node'
        ? '/usr/bin/node'
        : '/sandbox-bin/node'
      : '/runtime/node'

  const maxOutputBytes = input.maxOutputBytes ?? 1024 * 1024
  const sandbox = await spawnResourceBoundSandbox({
    bwrapArgs: args,
    sandboxNode: supervisorNode,
    targetCommand: sandboxCommand,
    targetArgs: input.args,
    mounts: [
      { path: '/tmp', maxBytes: 16 * MiB, maxFiles: 512, exportFiles: false },
      { path: '/dev/shm', maxBytes: 8 * MiB, maxFiles: 256, exportFiles: false },
      {
        path: '/work/children',
        maxBytes: 40 * MiB,
        maxFiles: 1280,
        exportFiles: true,
        seedPath: '/input/children-seed',
      },
    ],
    policy: PROPOSAL_RESOURCE_POLICY_V1,
  })
  sandbox.child.stdin.destroy()
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let outputBytes = 0
  const collect = (target: Buffer[]) => (chunk: Buffer) => {
    outputBytes += chunk.byteLength
    if (outputBytes > maxOutputBytes) void sandbox.kill('OUTPUT_LIMIT')
    else target.push(chunk)
  }
  sandbox.child.stdout.on('data', collect(stdout))
  sandbox.child.stderr.on('data', collect(stderr))
  const timer = setTimeout(() => void sandbox.kill('WALL_TIME_LIMIT'), input.timeoutMs)
  let sandboxResult
  try {
    sandboxResult = await sandbox.finish()
  } finally {
    clearTimeout(timer)
  }
  const completed = sandboxResult.resource.terminationCause === 'COMPLETED'
  if (completed) await materializeExport(resolved.childrenRoot, sandboxResult.files)
  const result: ProposalSandboxResult = {
    exitCode: completed ? sandboxResult.exitCode : null,
    signal: sandboxResult.signal,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
    timedOut: ['WALL_TIME_LIMIT', 'OUTPUT_LIMIT'].includes(sandboxResult.resource.terminationCause),
    resource: sandboxResult.resource,
  }
  if (
    ['CONTROL_PROTOCOL_FAILURE', 'LAUNCH_FAILURE'].includes(sandboxResult.resource.terminationCause)
  ) {
    throw new Error(
      `proposal sandbox: trusted export failed: ${result.stderr}\nresource=${JSON.stringify(result.resource)}`,
    )
  }

  // Re-canonicalize outside the sandbox and reject link/special-file output.
  await assertTreeHasNoSymlink(resolved.childrenRoot, 'childrenRoot output')
  return result
}

async function assertTreeHasNoEscapingSymlink(root: string, label: string): Promise<string> {
  const canonicalRoot = await realpath(root)
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) {
        const target = await realpath(path)
        if (target !== canonicalRoot && !target.startsWith(canonicalRoot + sep)) {
          throw new Error(`proposal sandbox: escaping symlink rejected in ${label}: ${path}`)
        }
      } else if (info.isDirectory()) await walk(path)
      else if (!info.isFile()) {
        throw new Error(`proposal sandbox: special file rejected in ${label}: ${path}`)
      }
    }
  }
  await walk(canonicalRoot)
  return canonicalRoot
}
