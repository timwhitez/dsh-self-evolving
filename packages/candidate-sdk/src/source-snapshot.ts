import { constants } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix, resolve } from 'node:path'
import {
  buildCanonicalArchiveFromFiles,
  DEFAULT_LIMITS,
  type CanonicalArchive,
  type CanonicalLimits,
  type FrozenCanonicalFile,
} from './identity/canonical-tar.js'

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW
const utf8 = new TextDecoder('utf-8', { fatal: true })

export interface FrozenCandidateSource {
  /** Trusted staging root containing only the captured bytes. */
  root: string
  files: FrozenCanonicalFile[]
  archive: CanonicalArchive
  cleanup(): Promise<void>
}

function validateRelativePath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') ||
    posix.normalize(path) !== path
  ) {
    throw new Error(`source snapshot: invalid path ${JSON.stringify(path)}`)
  }
}

function validateAndSortPaths(paths: string[]): string[] {
  const collisions = new Set<string>()
  for (const path of paths) {
    validateRelativePath(path)
    const collision = path.normalize('NFC').toLowerCase()
    if (collisions.has(collision)) {
      throw new Error(`source snapshot: Unicode/case collision: ${path}`)
    }
    collisions.add(collision)
  }
  return [...paths].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
}

function procEntry(directory: FileHandle, name: string): string {
  return `/proc/self/fd/${directory.fd}/${name}`
}

async function openRoot(inputRoot: string): Promise<FileHandle> {
  try {
    const handle = await open(resolve(inputRoot), DIRECTORY_FLAGS)
    const info = await handle.stat()
    if (!info.isDirectory()) {
      await handle.close()
      throw new Error('source snapshot: root must be a real directory')
    }
    return handle
  } catch (cause) {
    throw new Error('source snapshot: cannot open root without following symlinks', { cause })
  }
}

async function readHeldFile(
  handle: FileHandle,
  path: string,
  limits: CanonicalLimits,
): Promise<Uint8Array> {
  const before = await handle.stat()
  if (!before.isFile()) throw new Error(`source snapshot: not a regular file: ${path}`)
  if (before.nlink !== 1) {
    throw new Error(`source snapshot: hard-linked file rejected (nlink=${before.nlink}): ${path}`)
  }
  if (before.size > limits.maxFileBytes) {
    throw new Error(
      `source snapshot: file ${path} size ${before.size} exceeds ${limits.maxFileBytes}`,
    )
  }
  const chunks: Buffer[] = []
  let total = 0
  while (total <= limits.maxFileBytes) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, limits.maxFileBytes + 1 - total))
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null)
    if (bytesRead === 0) break
    chunks.push(buffer.subarray(0, bytesRead))
    total += bytesRead
  }
  const bytes = new Uint8Array(Buffer.concat(chunks, total))
  const after = await handle.stat()
  if (
    !after.isFile() ||
    after.nlink !== 1 ||
    before.dev !== after.dev ||
    before.ino !== after.ino
  ) {
    throw new Error(`source snapshot: file identity changed while reading: ${path}`)
  }
  if (bytes.byteLength > limits.maxFileBytes) {
    throw new Error(
      `source snapshot: file ${path} size ${bytes.byteLength} exceeds ${limits.maxFileBytes}`,
    )
  }
  return bytes
}

async function readDeclaredAtRoot(
  root: FileHandle,
  path: string,
  limits: CanonicalLimits,
): Promise<Uint8Array> {
  const segments = path.split('/')
  let directory = root
  let ownedDirectory = false
  try {
    for (const segment of segments.slice(0, -1)) {
      let next: FileHandle
      try {
        next = await open(procEntry(directory, segment), DIRECTORY_FLAGS)
      } catch (cause) {
        throw new Error(
          `source snapshot: intermediate component is not a real directory: ${path}`,
          {
            cause,
          },
        )
      }
      if (ownedDirectory) await directory.close()
      directory = next
      ownedDirectory = true
    }
    let file: FileHandle
    try {
      file = await open(procEntry(directory, segments.at(-1)!), FILE_FLAGS)
    } catch (cause) {
      throw new Error(`source snapshot: symlink, missing, or unreadable file rejected: ${path}`, {
        cause,
      })
    }
    try {
      return await readHeldFile(file, path, limits)
    } finally {
      await file.close()
    }
  } finally {
    if (ownedDirectory) await directory.close()
  }
}

async function captureDeclaredFiles(
  inputRoot: string,
  paths: string[],
  limits: CanonicalLimits,
): Promise<FrozenCanonicalFile[]> {
  if (paths.length === 0) throw new Error('source snapshot: no files declared')
  if (paths.length > limits.maxFileCount) {
    throw new Error(`source snapshot: ${paths.length} files exceeds max ${limits.maxFileCount}`)
  }
  const sorted = validateAndSortPaths(paths)
  const root = await openRoot(inputRoot)
  const files: FrozenCanonicalFile[] = []
  let totalBytes = 0
  try {
    for (const path of sorted) {
      const bytes = await readDeclaredAtRoot(root, path, limits)
      totalBytes += bytes.byteLength
      if (totalBytes > limits.maxTotalBytes) {
        throw new Error(`source snapshot: total ${totalBytes} exceeds ${limits.maxTotalBytes}`)
      }
      files.push({ path, bytes })
    }
  } finally {
    await root.close()
  }
  return files
}

function decodeEntryName(bytes: Buffer): string {
  try {
    return utf8.decode(bytes)
  } catch (cause) {
    throw new Error('source snapshot: non-UTF-8 directory entry rejected', { cause })
  }
}

async function captureTreeFiles(
  inputRoot: string,
  limits: CanonicalLimits,
): Promise<FrozenCanonicalFile[]> {
  const root = await openRoot(inputRoot)
  const files: FrozenCanonicalFile[] = []
  const collisions = new Set<string>()
  let totalBytes = 0
  const walk = async (directory: FileHandle, prefix: string): Promise<void> => {
    const rawNames = (await readdir(`/proc/self/fd/${directory.fd}`, {
      encoding: 'buffer',
    })) as Buffer[]
    rawNames.sort(Buffer.compare)
    for (const rawName of rawNames) {
      const name = decodeEntryName(rawName)
      const path = prefix === '' ? name : `${prefix}/${name}`
      validateRelativePath(path)
      let entry: FileHandle
      try {
        entry = await open(procEntry(directory, name), FILE_FLAGS)
      } catch (cause) {
        throw new Error(`source snapshot: symlink or unreadable entry rejected: ${path}`, { cause })
      }
      try {
        const info = await entry.stat()
        if (info.isDirectory()) {
          await walk(entry, path)
          continue
        }
        if (!info.isFile()) throw new Error(`source snapshot: special entry rejected: ${path}`)
        const collision = path.normalize('NFC').toLowerCase()
        if (collisions.has(collision)) {
          throw new Error(`source snapshot: Unicode/case collision: ${path}`)
        }
        collisions.add(collision)
        if (files.length >= limits.maxFileCount) {
          throw new Error(`source snapshot: file count exceeds ${limits.maxFileCount}`)
        }
        const bytes = await readHeldFile(entry, path, limits)
        totalBytes += bytes.byteLength
        if (totalBytes > limits.maxTotalBytes) {
          throw new Error(`source snapshot: total ${totalBytes} exceeds ${limits.maxTotalBytes}`)
        }
        files.push({ path, bytes })
      } finally {
        await entry.close()
      }
    }
  }
  try {
    await walk(root, '')
  } finally {
    await root.close()
  }
  files.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)))
  return files
}

async function materialize(files: FrozenCanonicalFile[]): Promise<{
  root: string
  cleanup(): Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-candidate-source-snapshot-'))
  const directories = new Set<string>([root])
  try {
    for (const file of files) {
      const absolute = join(root, file.path)
      const directory = dirname(absolute)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      let cursor = directory
      while (cursor.startsWith(root) && cursor !== dirname(cursor)) {
        directories.add(cursor)
        if (cursor === root) break
        cursor = dirname(cursor)
      }
      await writeFile(absolute, file.bytes, { flag: 'wx', mode: 0o400 })
    }
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
      await chmod(directory, 0o500)
    }
  } catch (cause) {
    await rm(root, { recursive: true, force: true })
    throw cause
  }
  let removed = false
  return {
    root,
    async cleanup() {
      if (removed) return
      removed = true
      for (const directory of [...directories].sort((a, b) => a.length - b.length)) {
        await chmod(directory, 0o700).catch(() => undefined)
      }
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function freeze(
  files: FrozenCanonicalFile[],
  limits: CanonicalLimits,
): Promise<FrozenCandidateSource> {
  const archive = buildCanonicalArchiveFromFiles(files, limits)
  const staging = await materialize(files)
  return { root: staging.root, files, archive, cleanup: staging.cleanup }
}

export async function freezeDeclaredSource(
  inputRoot: string,
  paths: string[],
  limits: CanonicalLimits = DEFAULT_LIMITS,
): Promise<FrozenCandidateSource> {
  return freeze(await captureDeclaredFiles(inputRoot, paths, limits), limits)
}

export async function freezeSourceTree(
  inputRoot: string,
  limits: CanonicalLimits = DEFAULT_LIMITS,
): Promise<FrozenCandidateSource> {
  return freeze(await captureTreeFiles(inputRoot, limits), limits)
}
