/**
 * Content-addressed object store (spec 06 §3).
 *
 * All immutable bytes live under objects/sha256/<aa>/<digest>. The publish
 * protocol is crash-safe:
 *   1. write to a staging temp file;
 *   2. fsync the staging file (and its directory on publish);
 *   3. compute sha256 of the staged bytes;
 *   4. reserve the immutable metadata binding;
 *   5. no-clobber link into the final path;
 *   6. if the digest already exists, verify byte-for-byte equality.
 *
 * A crash after metadata reservation but before byte linking is an explicit,
 * retryable incomplete publish, not evidence corruption. Retrying the same
 * immutable reference completes it; a conflicting label/media binding remains
 * fail-closed.
 */
import { createHash, randomBytes } from 'node:crypto'
import { link, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

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

interface StoredObjectMetadata {
  schemaVersion: 1
  digest: string
  size: number
  mediaType: string
  label: DataLabel
  metadataHash: string
}

export class IncompleteObjectPublishError extends Error {
  readonly code = 'OBJECT_PUBLISH_INCOMPLETE'

  constructor(readonly digest: string) {
    super(`object-store: publish is incomplete for object ${digest}`)
    this.name = 'IncompleteObjectPublishError'
  }
}

/** Two-level sharded path for a digest: objects/sha256/<aa>/<digest>. */
function digestPath(root: string, digest: string): string {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`object-store: bad digest ${digest}`)
  return join(root, 'objects', 'sha256', digest.slice(0, 2), digest)
}

function metadataPath(root: string, digest: string): string {
  return `${digestPath(root, digest)}.meta.json`
}

function metadataBody(
  ref: Pick<ObjectRef, 'digest' | 'size' | 'mediaType' | 'label'>,
): Omit<StoredObjectMetadata, 'metadataHash'> {
  return {
    schemaVersion: 1,
    digest: ref.digest,
    size: ref.size,
    mediaType: ref.mediaType,
    label: ref.label,
  }
}

function createMetadata(ref: ObjectRef): StoredObjectMetadata {
  const body = metadataBody(ref)
  return {
    ...body,
    metadataHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  }
}

async function readMetadata(store: ObjectStore, digest: string): Promise<StoredObjectMetadata> {
  const { readFile } = await import('node:fs/promises')
  let parsed: StoredObjectMetadata
  try {
    parsed = JSON.parse(
      await readFile(metadataPath(store.root, digest), 'utf8'),
    ) as StoredObjectMetadata
  } catch (error) {
    throw new Error(`EVIDENCE_CORRUPT: metadata missing or invalid for object ${digest}`, {
      cause: error,
    })
  }
  const validLabels: DataLabel[] = ['PUBLIC_SPEC', 'DEV_OBSERVED', 'GUARDED', 'SEALED']
  const body = metadataBody(parsed)
  const recomputed = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  if (
    parsed.schemaVersion !== 1 ||
    parsed.digest !== digest ||
    !Number.isSafeInteger(parsed.size) ||
    parsed.size < 0 ||
    typeof parsed.mediaType !== 'string' ||
    !validLabels.includes(parsed.label) ||
    parsed.metadataHash !== recomputed
  ) {
    throw new Error(`EVIDENCE_CORRUPT: metadata mismatch for object ${digest}`)
  }
  return parsed
}

async function publishMetadata(store: ObjectStore, ref: ObjectRef): Promise<void> {
  const path = metadataPath(store.root, ref.digest)
  const expected = createMetadata(ref)
  const bytes = JSON.stringify(expected) + '\n'
  let file
  try {
    file = await open(path, 'wx', 0o600)
    await file.writeFile(bytes)
    await file.sync()
    await file.close()
  } catch (error) {
    await file?.close().catch(() => {})
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = await readMetadata(store, ref.digest)
    if (JSON.stringify(existing) !== JSON.stringify(expected)) {
      throw new Error(`EVIDENCE_CORRUPT: immutable metadata conflict for object ${ref.digest}`, {
        cause: error,
      })
    }
  }
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
  const ref: ObjectRef = { algorithm: 'sha256', digest, size: bytes.length, mediaType, label }
  const finalPath = digestPath(store.root, digest)
  const existing = await stat(finalPath).catch(() => null)
  if (existing) {
    // Verify byte-for-byte equality (size first, then full hash via re-read).
    if (existing.size !== bytes.length) {
      throw new Error(`EVIDENCE_CORRUPT: size mismatch for existing object ${digest}`)
    }
    const existingMetadata = await readMetadata(store, digest)
    if (JSON.stringify(existingMetadata) !== JSON.stringify(createMetadata(ref))) {
      throw new Error(`EVIDENCE_CORRUPT: immutable metadata conflict for object ${digest}`)
    }
    if (!(await verifyEqualityBytes(bytes, finalPath))) {
      throw new Error(`EVIDENCE_CORRUPT: byte mismatch for existing object ${digest}`)
    }
    return ref
  }

  // Stage → fsync → reserve metadata → no-clobber link. Metadata reservation
  // intentionally precedes bytes so concurrent publishers cannot relabel the
  // same digest. Its crash-only intermediate state is explicitly recoverable.
  const stagingDir = join(store.root, 'objects', 'sha256', '.staging')
  await mkdir(stagingDir, { recursive: true })
  const stagingPath = join(stagingDir, `${digest}.${randomBytes(8).toString('hex')}.tmp`)
  const fh = await open(stagingPath, 'wx')
  try {
    await fh.writeFile(bytes)
    await fh.sync()
  } finally {
    await fh.close()
  }

  try {
    await mkdir(join(finalPath, '..'), { recursive: true })
    await publishMetadata(store, ref)
    try {
      await link(stagingPath, finalPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // Another writer won after the initial stat. Both immutable metadata and
      // bytes must match before this publication can be reused.
      const existingMetadata = await readMetadata(store, digest)
      if (JSON.stringify(existingMetadata) !== JSON.stringify(createMetadata(ref))) {
        throw new Error(`EVIDENCE_CORRUPT: immutable metadata conflict for object ${digest}`, {
          cause: error,
        })
      }
      if (!(await verifyEquality(stagingPath, finalPath))) {
        throw new Error(`EVIDENCE_CORRUPT: byte mismatch for existing object ${digest}`, {
          cause: error,
        })
      }
    }
    await fsyncDir(join(finalPath, '..'))
    return ref
  } finally {
    await rm(stagingPath, { force: true })
  }
}

async function verifyEqualityBytes(bytes: Uint8Array, path: string): Promise<boolean> {
  const { readFile } = await import('node:fs/promises')
  const existing = await readFile(path)
  return (
    existing.byteLength === bytes.byteLength &&
    createHash('sha256').update(existing).digest('hex') ===
      createHash('sha256').update(bytes).digest('hex')
  )
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
 * Read an object's bytes by digest. Throws a dedicated retryable error when a
 * valid immutable metadata reservation exists but byte publication was
 * interrupted. Throws EVIDENCE_CORRUPT for invalid metadata or byte corruption.
 */
export async function readBytes(store: ObjectStore, digest: string): Promise<Uint8Array> {
  const { readFile } = await import('node:fs/promises')
  let data: Buffer
  try {
    data = await readFile(digestPath(store.root, digest))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const reserved = await stat(metadataPath(store.root, digest)).catch(() => null)
    if (reserved === null) throw error
    await readMetadata(store, digest)
    throw new IncompleteObjectPublishError(digest)
  }
  const metadata = await readMetadata(store, digest)
  // Integrity check on read.
  const actual = createHash('sha256').update(data).digest('hex')
  if (actual !== digest) {
    throw new Error(`EVIDENCE_CORRUPT: object ${digest} hashes to ${actual}`)
  }
  if (metadata.size !== data.byteLength) {
    throw new Error(`EVIDENCE_CORRUPT: metadata size mismatch for object ${digest}`)
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

/** Read bytes and verify the caller's full immutable reference metadata. */
export async function readRefBytes(store: ObjectStore, ref: ObjectRef): Promise<Uint8Array> {
  if (ref.algorithm !== 'sha256') throw new Error('object-store: unsupported reference algorithm')
  const metadata = await readMetadata(store, ref.digest)
  if (JSON.stringify(metadata) !== JSON.stringify(createMetadata(ref))) {
    throw new Error(`EVIDENCE_CORRUPT: reference metadata mismatch for object ${ref.digest}`)
  }
  return readBytes(store, ref.digest)
}

/**
 * Scrub: re-hash every completed object under the store. Returns the list of
 * corrupt digests (empty = healthy). A valid metadata-only reservation is an
 * incomplete publish and remains retryable; invalid metadata is corruption.
 */
export async function scrub(store: ObjectStore): Promise<string[]> {
  const corrupt = new Set<string>()
  const { readFile } = await import('node:fs/promises')
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) await walk(abs)
      else if (e.isFile() && /^[0-9a-f]{64}$/.test(e.name)) {
        const data = await readFile(abs)
        const actual = createHash('sha256').update(data).digest('hex')
        if (actual !== e.name) corrupt.add(e.name)
        try {
          const metadata = await readMetadata(store, e.name)
          if (metadata.size !== data.byteLength) corrupt.add(e.name)
        } catch {
          corrupt.add(e.name)
        }
      } else if (e.isFile() && /^[0-9a-f]{64}\.meta\.json$/.test(e.name)) {
        const digest = e.name.slice(0, 64)
        if ((await stat(digestPath(store.root, digest)).catch(() => null)) === null) {
          try {
            await readMetadata(store, digest)
            // Valid metadata-only state: interrupted but recoverable publication.
          } catch {
            corrupt.add(digest)
          }
        }
      }
    }
  }
  const objectsRoot = join(store.root, 'objects', 'sha256')
  await mkdir(objectsRoot, { recursive: true })
  await walk(objectsRoot)
  return [...corrupt].sort()
}

/** Check whether completed object bytes exist in the store. */
export async function exists(store: ObjectStore, digest: string): Promise<boolean> {
  return (await stat(digestPath(store.root, digest)).catch(() => null)) !== null
}

/** rename helper exported for the journal (same fsync-dir discipline). */
export async function atomicRenameWithDirSync(from: string, to: string): Promise<void> {
  await rename(from, to)
  await fsyncDir(join(to, '..'))
}
