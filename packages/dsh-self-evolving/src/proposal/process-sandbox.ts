/** Bubblewrap-backed one-shot proposal process sandbox (spec 05 §§5.2, 9). */
import { spawn } from 'node:child_process'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'

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
}

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
    '--cap-drop',
    'ALL',
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
    '--dir',
    '/work',
    '--bind',
    resolved.childrenRoot,
    '/work/children',
    '--tmpfs',
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
  if (input.command === '/usr/bin/node') {
    const hostNode = await realpath(process.execPath)
    if (hostNode !== '/usr/bin/node') {
      args.push('--dir', '/sandbox-bin', '--ro-bind', hostNode, '/sandbox-bin/node')
      sandboxCommand = '/sandbox-bin/node'
    }
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
  args.push('--', sandboxCommand, ...input.args)

  const maxOutputBytes = input.maxOutputBytes ?? 1024 * 1024
  const result = await new Promise<ProposalSandboxResult>((done, reject) => {
    const child = spawn('/usr/bin/bwrap', args, {
      detached: true,
      env: { PATH: '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let timedOut = false
    let settled = false
    const killGroup = () => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      killGroup()
    }, input.timeoutMs)
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.byteLength
      if (outputBytes > maxOutputBytes) {
        timedOut = true
        killGroup()
        return
      }
      target.push(chunk)
    }
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (exitCode, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
      })
    })
  })

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
