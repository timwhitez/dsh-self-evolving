/**
 * Trusted PID-namespace supervisor used by resource-sandbox.ts.
 *
 * It starts with private-user-namespace capabilities only long enough to
 * create size/inode-bounded tmpfs mounts and freeze the nested-namespace
 * quota, then launches the untrusted target through setpriv with an empty
 * capability bounding set and no-new-privileges. The target never inherits
 * control fd 3. After the target exits, all remaining namespace processes are
 * killed before any exported tree is read.
 */
import { spawn } from 'node:child_process'
import { writeSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, statfs, writeFile } from 'node:fs/promises'
import { isAbsolute, join, posix, sep } from 'node:path'

interface SupervisorMount {
  path: string
  maxBytes: number
  maxFiles: number
  exportFiles: boolean
  seedPath?: string
}

interface SupervisorConfig {
  schemaVersion: 1
  mounts: SupervisorMount[]
}

interface ExportedFile {
  mountPath: string
  path: string
  bytesBase64: string
}

interface MountPeak {
  path: string
  maxBytes: number
  maxFiles: number
  peakBytes: number
  peakFiles: number
  limitHit: boolean
}

const ALLOWED_MOUNTS = new Set([
  '/tmp',
  '/dev/shm',
  '/output',
  '/workspace',
  '/logs',
  '/work/children',
])

function positiveInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`resource supervisor: ${label} must be a positive safe integer`)
  }
}

function parseConfig(raw: string): SupervisorConfig {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
  } catch (cause) {
    throw new Error('resource supervisor: invalid configuration encoding', { cause })
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    !Array.isArray((value as { mounts?: unknown }).mounts)
  ) {
    throw new Error('resource supervisor: invalid configuration envelope')
  }
  const mounts = (value as { mounts: unknown[] }).mounts.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('resource supervisor: invalid mount entry')
    }
    const candidate = entry as Partial<SupervisorMount>
    if (
      typeof candidate.path !== 'string' ||
      !ALLOWED_MOUNTS.has(candidate.path) ||
      (candidate.exportFiles !== true && candidate.exportFiles !== false) ||
      (candidate.seedPath !== undefined &&
        (typeof candidate.seedPath !== 'string' ||
          !candidate.seedPath.startsWith('/input/') ||
          candidate.seedPath.includes('\\') ||
          candidate.seedPath.includes('\0') ||
          candidate.seedPath
            .split('/')
            .some(
              (segment, index) =>
                index > 0 && (segment === '' || segment === '.' || segment === '..'),
            )))
    ) {
      throw new Error('resource supervisor: invalid mount path/export/seed policy')
    }
    positiveInteger(candidate.maxBytes, 'mount maxBytes')
    positiveInteger(candidate.maxFiles, 'mount maxFiles')
    return {
      path: candidate.path,
      maxBytes: candidate.maxBytes,
      maxFiles: candidate.maxFiles,
      exportFiles: candidate.exportFiles,
      ...(candidate.seedPath === undefined ? {} : { seedPath: candidate.seedPath }),
    }
  })
  const seen = new Set<string>()
  for (const mount of mounts) {
    if (seen.has(mount.path)) throw new Error('resource supervisor: duplicate mount path')
    for (const existing of seen) {
      if (mount.path.startsWith(`${existing}/`) || existing.startsWith(`${mount.path}/`)) {
        throw new Error('resource supervisor: overlapping mount paths')
      }
    }
    seen.add(mount.path)
  }
  return { schemaVersion: 1, mounts }
}

function run(
  command: string,
  args: string[],
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code, signal) => done({ code, signal }))
  })
}

async function mountTmpfs(mount: SupervisorMount): Promise<void> {
  await mkdir(mount.path, { recursive: true, mode: 0o700 })
  const inodeLimit = mount.maxFiles
  const result = await run('/usr/bin/mount', [
    '-t',
    'tmpfs',
    '-o',
    `size=${mount.maxBytes},nr_inodes=${inodeLimit},mode=0700,nosuid,nodev,noexec`,
    'tmpfs',
    mount.path,
  ])
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(`resource supervisor: tmpfs mount failed at ${mount.path}`)
  }
}

async function seedMount(mount: SupervisorMount): Promise<void> {
  if (mount.seedPath === undefined) return
  const root = await lstat(mount.seedPath)
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new Error(`resource supervisor: seed root is not a real directory: ${mount.seedPath}`)
  }
  async function copy(source: string, destination: string): Promise<void> {
    const entries = (await readdir(source, { withFileTypes: true })).sort((left, right) =>
      Buffer.from(left.name).compare(Buffer.from(right.name)),
    )
    for (const entry of entries) {
      const sourcePath = join(source, entry.name)
      const destinationPath = join(destination, entry.name)
      const info = await lstat(sourcePath)
      if (info.isSymbolicLink()) {
        throw new Error(`resource supervisor: symlink seed rejected: ${sourcePath}`)
      }
      if (info.isDirectory()) {
        await mkdir(destinationPath, { mode: 0o700 })
        await copy(sourcePath, destinationPath)
        continue
      }
      if (!info.isFile()) {
        throw new Error(`resource supervisor: special seed rejected: ${sourcePath}`)
      }
      if (info.nlink !== 1) {
        throw new Error(`resource supervisor: hard-linked seed rejected: ${sourcePath}`)
      }
      await writeFile(destinationPath, await readFile(sourcePath), { flag: 'wx', mode: 0o600 })
    }
  }
  await copy(mount.seedPath, mount.path)
}

async function disableNestedUserNamespaces(): Promise<void> {
  const path = '/proc/sys/user/max_user_namespaces'
  await writeFile(path, '0\n')
  if ((await readFile(path, 'utf8')).trim() !== '0') {
    throw new Error('resource supervisor: nested user namespaces remain enabled')
  }
}

async function sampleMount(mount: SupervisorMount): Promise<{
  bytes: number
  files: number
  limitHit: boolean
}> {
  const info = await statfs(mount.path, { bigint: true })
  const bytes = Number((info.blocks - info.bfree) * info.bsize)
  const files = Number(info.files - info.ffree)
  if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(files)) {
    throw new Error('resource supervisor: unsafe tmpfs usage metric')
  }
  return {
    bytes,
    files,
    limitHit: info.bavail === 0n || info.ffree === 0n,
  }
}

async function killNamespaceDescendants(): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const pids = (await readdir('/proc'))
      .filter((entry) => /^\d+$/.test(entry))
      .map(Number)
      .filter((pid) => pid !== 1 && pid !== process.pid)
    if (pids.length === 0) return
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    await new Promise<void>((done) => setTimeout(done, 10))
  }
  const survivors = (await readdir('/proc')).filter(
    (entry) => /^\d+$/.test(entry) && ![1, process.pid].includes(Number(entry)),
  )
  if (survivors.length > 0) {
    throw new Error(`resource supervisor: namespace survivors: ${survivors.join(',')}`)
  }
}

function validateRelativePath(path: string): void {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') ||
    posix.normalize(path) !== path
  ) {
    throw new Error(`resource supervisor: invalid export path ${JSON.stringify(path)}`)
  }
}

async function exportMount(mount: SupervisorMount): Promise<ExportedFile[]> {
  const files: ExportedFile[] = []
  let totalBytes = 0
  const seen = new Set<string>()
  async function walk(directory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      Buffer.from(left.name).compare(Buffer.from(right.name)),
    )
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) {
        throw new Error(`resource supervisor: symlink export rejected: ${absolute}`)
      }
      if (info.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (!info.isFile()) {
        throw new Error(`resource supervisor: special export rejected: ${absolute}`)
      }
      if (info.nlink !== 1) {
        throw new Error(`resource supervisor: hard-linked export rejected: ${absolute}`)
      }
      const path = absolute
        .slice(mount.path.length + 1)
        .split(sep)
        .join('/')
      validateRelativePath(path)
      const collision = path.normalize('NFC').toLowerCase()
      if (seen.has(collision)) {
        throw new Error(`resource supervisor: Unicode/case export collision: ${path}`)
      }
      seen.add(collision)
      if (files.length >= mount.maxFiles) {
        throw new Error(`resource supervisor: export file count exceeds ${mount.maxFiles}`)
      }
      const bytes = await readFile(absolute)
      totalBytes += bytes.byteLength
      if (totalBytes > mount.maxBytes) {
        throw new Error(`resource supervisor: export bytes exceed ${mount.maxBytes}`)
      }
      files.push({ mountPath: mount.path, path, bytesBase64: bytes.toString('base64') })
    }
  }
  await walk(mount.path)
  return files
}

function writeControl(value: unknown): void {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`)
  let offset = 0
  while (offset < bytes.byteLength) {
    offset += writeSync(3, bytes, offset, bytes.byteLength - offset)
  }
}

async function main(): Promise<void> {
  const [encodedConfig, targetCommand, ...targetArgs] = process.argv.slice(2)
  if (encodedConfig === undefined || targetCommand === undefined || !isAbsolute(targetCommand)) {
    throw new Error('resource supervisor: target/config arguments missing')
  }
  const config = parseConfig(encodedConfig)
  for (const mount of config.mounts) await mountTmpfs(mount)
  for (const mount of config.mounts) await seedMount(mount)
  // The outer bwrap always creates a private user namespace. After the
  // trusted mounts are complete, freeze its namespaced userns quota at zero.
  // The target then cannot regain mount capabilities in a nested userns.
  await disableNestedUserNamespaces()
  const peaks = new Map<string, MountPeak>()
  for (const mount of config.mounts) {
    peaks.set(mount.path, {
      path: mount.path,
      maxBytes: mount.maxBytes,
      maxFiles: mount.maxFiles,
      peakBytes: 0,
      peakFiles: 0,
      limitHit: false,
    })
  }
  const sample = async (): Promise<void> => {
    for (const mount of config.mounts) {
      const observed = await sampleMount(mount)
      const peak = peaks.get(mount.path)!
      peak.peakBytes = Math.max(peak.peakBytes, observed.bytes)
      peak.peakFiles = Math.max(peak.peakFiles, observed.files)
      peak.limitHit ||= observed.limitHit
    }
  }
  await sample()
  let sampling = false
  const timer = setInterval(() => {
    if (sampling) return
    sampling = true
    void sample().finally(() => {
      sampling = false
    })
  }, 10)
  // setpriv strips the final target's capabilities and enables no_new_privs.
  // The outer root and /dev are already read-only; only the exact bounded
  // tmpfs mounts above remain writable.
  // A capability-free process with the supervisor's uid can still signal it
  // and inspect its /proc file descriptors. Put the target below a second PID
  // namespace before dropping capabilities: the target can see only itself
  // and its descendants, while this supervisor retains the sole control fd.
  // This does not require a nested user namespace (whose quota is frozen
  // above); the supervisor's private-user-namespace CAP_SYS_ADMIN is enough.
  const target = spawn(
    '/usr/bin/unshare',
    [
      '--pid',
      '--fork',
      '--mount-proc=/proc',
      '--kill-child=SIGKILL',
      '/usr/bin/setpriv',
      '--bounding-set=-all',
      '--inh-caps=-all',
      '--ambient-caps=-all',
      '--no-new-privs',
      '--',
      targetCommand,
      ...targetArgs,
    ],
    { detached: true, stdio: ['inherit', 'inherit', 'inherit'] },
  )
  const completion = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (done, reject) => {
      target.once('error', reject)
      target.once('close', (exitCode, signal) => done({ exitCode, signal }))
    },
  )
  clearInterval(timer)
  try {
    if (target.pid !== undefined) process.kill(-target.pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
  await killNamespaceDescendants()
  await sample()
  const storageLimitHit = [...peaks.values()].some((peak) => peak.limitHit)
  const files = storageLimitHit
    ? []
    : (
        await Promise.all(config.mounts.filter((mount) => mount.exportFiles).map(exportMount))
      ).flat()
  writeControl({
    schemaVersion: 1,
    exitCode: completion.exitCode,
    signal: completion.signal,
    mountPeaks: [...peaks.values()],
    files,
  })
}

await main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 125
})
