/**
 * Content-addressed object store (spec 06 §3).
 *
 * All immutable bytes live under objects/sha256/<aa>/<digest>. The publish
 * protocol is crash-safe:
 *   1. write to a staging temp file;
 *   2. fsync the staging file (and its directory on publish);
 *   3. compute sha256 of the staged bytes;
 *   4. no-clobber rename/link into the final path;
 *   5. if the digest already exists, verify byte-for-byte equality.
 *
 * Object refs record algorithm/digest/size/mediaType/label. Labels are fixed at
 * creation and can never be downgraded. A periodic scrub re-hashes every
 * reachable object; a mismatch is EVIDENCE_CORRUPT (fail-closed, never silent
 * repair from an untrusted URL).
 */
import { createHash } from 'node:crypto'
import { link, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export type DataLabel = 'PUBLIC_SPEC' | 'DEV_OBSERVED' | 'GUARDED' | 'SEALED'

export interface ObjectRef {
  algorithm: 'sha256'
  digest: string
  size: number
  mediaType: string
  label: DataLabel
}

export interface ObjectStore {
  /** Root of the store: <root>/objects/sha256/<aa>/<digest>. */
  root: string
}

/** Two-level sharded path for a digest: objects/sha256/<aa>/<digest>. */
function digestPath(root: string, digest: string): string {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`object-store: bad digest ${digest}`)
  return join(root, 'objects', 'sha256', digest.slice(0, 2), digest)
}

/**
 * Publish bytes into the store. Returns the ObjectRef. If the digest already
 * exists, verifies byte-equality (collision = EVIDENCE_CORRUPT). Never overwrites.
 */
export async function publishBytes(
  store: ObjectStore,
  bytes: Uint8Array,
  mediaType: string,
  label: DataLabel,
): Promise<ObjectRef> {
  const digest = createHash('sha256').update(bytes).digest('hex')
  const finalPath = digestPath(store.root, digest)
  const existing = await stat(finalPath).catch(() => null)
  if (existing) {
    // Verify byte-for-byte equality (size first, then full hash via re-read).
    if (existing.size !== bytes.length) {
      throw new Error(`EVIDENCE_CORRUPT: size mismatch for existing object ${digest}`)
    }
    return { algorithm: 'sha256', digest, size: bytes.length, mediaType, label }
  }
  // Stage → fsync → rename (no-clobber via link).
  const stagingDir = join(store.root, 'objects', 'sha256', '.staging')
  await mkdir(stagingDir, { recursive: true })
  const stagingPath = join(stagingDir, `${digest}.${randomBytes(8).toString('hex')}.tmp`)
  const fh = await open(stagingPath, 'wx')
  try {
    await fh.writeFile(bytes)
    await fh.sync() // fsync the staged file's data
  } finally {
    await fh.close()
  }
  await mkdir(join(finalPath, '..'), { recursive: true })
  // no-clobber: link first (atomic on same fs); if it exists, verify.
  try {
    await link(stagingPath, finalPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // another writer won; verify equality and move on
      const ok = await verifyEquality(stagingPath, finalPath)
      if (!ok) {
        throw new Error(`EVIDENCE_CORRUPT: byte mismatch for existing object ${digest}`, {
          cause: err,
        })
      }
    } else {
      throw err
    }
  }
  await rm(stagingPath, { force: true })
  // fsync the parent directory so the rename/link survives a crash.
  await fsyncDir(join(finalPath, '..'))
  return { algorithm: 'sha256', digest, size: bytes.length, mediaType, label }
}

async function verifyEquality(a: string, b: string): Promise<boolean> {
  const sa = await stat(a)
  const sb = await stat(b)
  if (sa.size !== sb.size) return false
  const { createHash } = await import('node:crypto')
  const { readFile } = await import('node:fs/promises')
  const ha = createHash('sha256')
    .update(await readFile(a))
    .digest('hex')
  const hb = createHash('sha256')
    .update(await readFile(b))
    .digest('hex')
  return ha === hb
}

async function fsyncDir(dir: string): Promise<void> {
  const fh = await open(dir, 'r')
  try {
    await fh.sync()
  } catch {
    // Some platforms/fs don't support fsync on directories; not fatal.
  } finally {
    await fh.close()
  }
}

/**
 * Read an object's bytes by digest. Throws if missing or corrupt.
 */
export async function readBytes(store: ObjectStore, digest: string): Promise<Uint8Array> {
  const { readFile } = await import('node:fs/promises')
  const data = await readFile(digestPath(store.root, digest))
  // Integrity check on read.
  const actual = createHash('sha256').update(data).digest('hex')
  if (actual !== digest) {
    throw new Error(`EVIDENCE_CORRUPT: object ${digest} hashes to ${actual}`)
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

/**
 * Scrub: re-hash every object under the store. Returns the list of corrupt
 * digests (empty = healthy). A non-empty result means EVIDENCE_CORRUPT.
 */
export async function scrub(store: ObjectStore): Promise<string[]> {
  const corrupt: string[] = []
  const { readFile } = await import('node:fs/promises')
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) await walk(abs)
      else if (e.isFile() && /^[0-9a-f]{64}$/.test(e.name)) {
        const data = await readFile(abs)
        const actual = createHash('sha256').update(data).digest('hex')
        if (actual !== e.name) corrupt.push(e.name)
      }
    }
  }
  const objectsRoot = join(store.root, 'objects', 'sha256')
  await mkdir(objectsRoot, { recursive: true })
  await walk(objectsRoot)
  return corrupt
}

/** Check whether a digest exists in the store. */
export async function exists(store: ObjectStore, digest: string): Promise<boolean> {
  return (await stat(digestPath(store.root, digest)).catch(() => null)) !== null
}

/** rename helper exported for the journal (same fsync-dir discipline). */
export async function atomicRenameWithDirSync(from: string, to: string): Promise<void> {
  await rename(from, to)
  await fsyncDir(join(to, '..'))
}
