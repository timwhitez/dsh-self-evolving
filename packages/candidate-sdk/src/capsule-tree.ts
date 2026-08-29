import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, readlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const CAPSULE_TREE_FORMAT = 'dsh-capsule-tree-v2' as const

export type CapsuleTreeFormat = typeof CAPSULE_TREE_FORMAT | 'dsh-capsule-files-v1'

export interface CapsuleTreeResult {
  digest: `sha256:${string}`
  format: CapsuleTreeFormat
}

const CONTROL_PATHS = new Set(['SHA256SUMS', 'capsule.json'])
const TYPED_ENTRY = /^(directory|file|symlink):(0[0-7]{3}):(.+)$/

function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  const buffer = Buffer.from(bytes)
  const decoded = buffer.toString('utf8')
  if (!Buffer.from(decoded, 'utf8').equals(buffer)) {
    throw new Error(`capsule tree: invalid UTF-8 ${label}`)
  }
  return decoded
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function containsForbiddenPathCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    ) {
      return true
    }
  }
  return false
}

function assertRelativePath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    containsForbiddenPathCharacter(path) ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`capsule tree: unsafe entry path ${JSON.stringify(path)}`)
  }
}

function normalizedFileMode(mode: number): '0644' | '0755' {
  return (mode & 0o111) === 0 ? '0644' : '0755'
}

function directoryHash(path: string): string {
  return sha256(`directory\0${path}`)
}

async function collectTypedTree(root: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>()
  async function walk(dir: string, prefix = ''): Promise<void> {
    for (const entry of (await readdir(dir, { withFileTypes: true, encoding: 'buffer' })).sort(
      (left, right) => Buffer.compare(left.name, right.name),
    )) {
      const name = decodeUtf8(entry.name, `entry name beneath ${JSON.stringify(prefix)}`)
      const abs = join(dir, name)
      const rel = prefix === '' ? name : `${prefix}/${name}`
      assertRelativePath(rel)
      const info = await lstat(abs)
      if (CONTROL_PATHS.has(rel)) {
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.nlink !== 1 ||
          (info.mode & 0o7111) !== 0
        ) {
          throw new Error(
            `capsule tree: control path must be one normalized 0644 regular file: ${rel}`,
          )
        }
        continue
      }
      if (info.isDirectory()) {
        if ((info.mode & 0o7000) !== 0) {
          throw new Error(`capsule tree: special directory mode is forbidden: ${rel}`)
        }
        entries.set(`directory:0755:${rel}`, directoryHash(rel))
        await walk(abs, rel)
        continue
      }
      if (info.isSymbolicLink()) {
        if (info.nlink !== 1) {
          throw new Error(`capsule tree: hard-linked capsule entry ${rel}`)
        }
        entries.set(`symlink:0755:${rel}`, sha256(await readlink(abs, { encoding: 'buffer' })))
        continue
      }
      if (!info.isFile()) {
        throw new Error(`capsule tree: special capsule entry ${rel}`)
      }
      if ((info.mode & 0o7000) !== 0) {
        throw new Error(`capsule tree: special file mode is forbidden: ${rel}`)
      }
      if (info.nlink !== 1) {
        throw new Error(`capsule tree: hard-linked capsule entry ${rel}`)
      }
      entries.set(`file:${normalizedFileMode(info.mode)}:${rel}`, sha256(await readFile(abs)))
    }
  }
  await walk(root)
  return entries
}

async function collectLegacyTree(root: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>()
  async function walk(dir: string, prefix = ''): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true, encoding: 'buffer' })) {
      const name = decodeUtf8(entry.name, `entry name beneath ${JSON.stringify(prefix)}`)
      const abs = join(dir, name)
      const rel = prefix === '' ? name : `${prefix}/${name}`
      assertRelativePath(rel)
      const info = await lstat(abs)
      if (CONTROL_PATHS.has(rel)) {
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.nlink !== 1 ||
          (info.mode & 0o7111) !== 0
        ) {
          throw new Error(
            `capsule tree: control path must be one normalized 0644 regular file: ${rel}`,
          )
        }
        continue
      }
      if (info.isDirectory()) {
        await walk(abs, rel)
        continue
      }
      if (info.isSymbolicLink()) {
        if (info.nlink !== 1) {
          throw new Error(`capsule tree: hard-linked capsule entry ${rel}`)
        }
        entries.set(`symlink:${rel}`, sha256(await readlink(abs, { encoding: 'buffer' })))
        continue
      }
      if (!info.isFile()) throw new Error(`capsule tree: special capsule entry ${rel}`)
      if (info.nlink !== 1) throw new Error(`capsule tree: hard-linked capsule entry ${rel}`)
      entries.set(rel, sha256(await readFile(abs)))
    }
  }
  await walk(root)
  return entries
}

function assertExactEntries(listed: Map<string, string>, walked: Map<string, string>): void {
  for (const [key, hash] of walked) {
    const expected = listed.get(key)
    if (expected === undefined) throw new Error(`capsule tree: unlisted capsule entry ${key}`)
    if (expected !== hash) throw new Error(`capsule tree: capsule checksum mismatch ${key}`)
  }
  for (const key of listed.keys()) {
    if (!walked.has(key)) throw new Error(`capsule tree: capsule lists a missing entry ${key}`)
  }
}

export async function writeCapsuleTreeManifest(
  root: string,
  sumsPath: string,
): Promise<{ entries: Map<string, string>; hash: string }> {
  const entries = await collectTypedTree(root)
  const body =
    [...entries.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([descriptor, hash]) => `${hash}  ${descriptor}`)
      .join('\n') + '\n'
  await writeFile(sumsPath, body)
  return { entries, hash: sha256(body) }
}

export async function verifyCapsuleTreeManifest(capsuleRoot: string): Promise<CapsuleTreeResult> {
  const [manifestBytes, sumsBytes] = await Promise.all([
    readFile(join(capsuleRoot, 'capsule.json')),
    readFile(join(capsuleRoot, 'SHA256SUMS')),
  ])
  const manifestText = decodeUtf8(manifestBytes, 'capsule manifest')
  const sums = decodeUtf8(sumsBytes, 'checksum text')
  let manifest: {
    schemaVersion?: unknown
    sha256sums?: { ref?: unknown; hash?: unknown; format?: unknown }
  }
  try {
    manifest = JSON.parse(manifestText) as typeof manifest
  } catch (error) {
    throw new Error('capsule tree: invalid capsule manifest JSON', { cause: error })
  }
  const sumsHash = sha256(sumsBytes)
  if (manifest.sha256sums?.ref !== 'SHA256SUMS' || manifest.sha256sums.hash !== sumsHash) {
    throw new Error('capsule tree: manifest does not bind SHA256SUMS')
  }
  if (!sums.endsWith('\n') || sums.endsWith('\n\n') || sums.includes('\r')) {
    throw new Error('capsule tree: checksum text is not canonical LF-delimited data')
  }
  const lines = sums.slice(0, -1).split('\n')
  if (lines.length === 0 || lines[0] === '') throw new Error('capsule tree: empty capsule sums')
  const listed = new Map<string, string>()

  if (manifest.schemaVersion === 2 && manifest.sha256sums.format === CAPSULE_TREE_FORMAT) {
    const descriptorOrder: string[] = []
    for (const line of lines) {
      const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line)
      const typed = match === null ? null : TYPED_ENTRY.exec(match[2]!)
      if (match === null || typed === null) throw new Error('capsule tree: malformed v2 entry')
      const [, kind, mode, path] = typed
      assertRelativePath(path!)
      if (
        (kind === 'directory' && mode !== '0755') ||
        (kind === 'symlink' && mode !== '0755') ||
        (kind === 'file' && mode !== '0644' && mode !== '0755')
      ) {
        throw new Error(`capsule tree: invalid normalized mode in ${match[2]}`)
      }
      const key = match[2]!
      if (listed.has(key)) throw new Error(`capsule tree: duplicate capsule entry ${key}`)
      listed.set(key, match[1]!)
      descriptorOrder.push(key)
    }
    if (descriptorOrder.join('\n') !== [...descriptorOrder].sort(compareText).join('\n')) {
      throw new Error('capsule tree: v2 entries are not in canonical descriptor order')
    }
    assertExactEntries(listed, await collectTypedTree(capsuleRoot))
    return { digest: `sha256:${sumsHash}`, format: CAPSULE_TREE_FORMAT }
  }

  if (manifest.schemaVersion === 1 && manifest.sha256sums.format === undefined) {
    for (const line of lines) {
      const match = /^([0-9a-f]{64}) {2}(symlink:)?(.+)$/.exec(line)
      if (match === null) throw new Error('capsule tree: malformed legacy entry')
      const key = `${match[2] ?? ''}${match[3]!}`
      if (listed.has(key)) throw new Error(`capsule tree: duplicate capsule entry ${key}`)
      listed.set(key, match[1]!)
    }
    assertExactEntries(listed, await collectLegacyTree(capsuleRoot))
    return { digest: `sha256:${sumsHash}`, format: 'dsh-capsule-files-v1' }
  }

  throw new Error('capsule tree: unsupported manifest/checksum format')
}
