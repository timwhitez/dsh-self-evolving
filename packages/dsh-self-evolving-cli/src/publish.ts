/**
 * Atomic multi-file evidence publication (issues #55 / #45).
 *
 * Publishing related evidence files one-by-one at their final paths leaves a
 * crash window where a result exists without its receipts (or vice versa) and
 * resume treats the partial state as complete. A bundle is instead published
 * with a LAST-written manifest commit marker:
 *
 *   1. every entry is written + fsynced under a unique staging name,
 *   2. no-clobber hard-linked to its final name,
 *   3. after all entries are directory-durable, a complete fsynced manifest
 *      is no-clobber linked LAST and the directory is fsynced again.
 *
 * Readers gate on the manifest: a bundle without one is an INCOMPLETE prior
 * attempt and must never be adopted as finished; a complete bundle is
 * verified byte-for-byte against the manifest digests on every load.
 */
import { createHash } from 'node:crypto'
import { link, open, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const PUBLISH_MANIFEST = 'publish-manifest.json'

export interface PublishedBundle {
  files: Record<string, string>
}

export type PublishCheckpoint = 'manifest-staged' | 'manifest-linked' | 'manifest-directory-synced'

export interface PublishBundleOptions {
  /** Fault-injection/verification hook; production callers normally omit it. */
  onCheckpoint?: (checkpoint: PublishCheckpoint) => void | Promise<void>
}

function sha256Hex(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function writeDurable(path: string, bytes: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Publish a set of evidence files atomically. Throws if ANY final entry or
 * the manifest already exists — publication happens exactly once.
 */
export async function publishBundle(
  dir: string,
  entries: Record<string, string>,
  options: PublishBundleOptions = {},
): Promise<void> {
  const names = Object.keys(entries).sort()
  if (names.length === 0) throw new Error('publish: empty bundle')
  if (
    names.some(
      (name) =>
        name === PUBLISH_MANIFEST ||
        name.length === 0 ||
        name === '.' ||
        name === '..' ||
        name.includes('/') ||
        name.includes('\\') ||
        name.includes('\0'),
    )
  ) {
    throw new Error('publish: unsafe or reserved bundle entry name')
  }
  const files: Record<string, string> = {}
  const staged: Array<{ staging: string; final: string }> = []
  let manifestStaging: string | undefined
  try {
    for (const name of names) {
      const bytes = entries[name]!
      files[name] = sha256Hex(bytes)
      const staging = join(dir, `.${name}.staging-${process.pid}-${randomUUID()}`)
      await writeDurable(staging, bytes)
      staged.push({ staging, final: join(dir, name) })
    }
    for (const { staging, final } of staged) {
      // A hard link is the no-clobber commit for each data entry. rename(2)
      // would silently replace an existing file on POSIX and could corrupt an
      // already committed bundle before the exclusive manifest write fails.
      try {
        await link(staging, final)
        await rm(staging, { force: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        throw new Error(`publish: final path already exists: ${final}`, { cause: error })
      }
    }
    await fsyncDirectory(dir)
    const manifestFinal = join(dir, PUBLISH_MANIFEST)
    manifestStaging = join(dir, `.${PUBLISH_MANIFEST}.staging-${process.pid}-${randomUUID()}`)
    await writeDurable(manifestStaging, JSON.stringify({ schemaVersion: 1, files }, null, 2) + '\n')
    await options.onCheckpoint?.('manifest-staged')
    try {
      await link(manifestStaging, manifestFinal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      throw new Error(`publish: final path already exists: ${manifestFinal}`, { cause: error })
    }
    await options.onCheckpoint?.('manifest-linked')
    await rm(manifestStaging, { force: true })
    await fsyncDirectory(dir)
    await options.onCheckpoint?.('manifest-directory-synced')
    for (const { staging } of staged) await rm(staging, { force: true }).catch(() => {})
  } catch (error) {
    if (manifestStaging !== undefined) await rm(manifestStaging, { force: true }).catch(() => {})
    for (const { staging, final } of staged) {
      await rm(staging, { force: true }).catch(() => {})
      void final
    }
    throw error
  }
}

/**
 * Load a published bundle. Returns null when no commit marker exists
 * (incomplete prior attempt); throws when the manifest exists but any bound
 * file is missing or fails digest verification (corruption/tamper).
 */
export async function loadPublishedBundle(dir: string): Promise<Record<string, string> | null> {
  const rawManifest = await readFile(join(dir, PUBLISH_MANIFEST), 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    },
  )
  if (rawManifest === null) return null
  const manifest = JSON.parse(rawManifest) as { schemaVersion?: unknown; files?: unknown }
  if (
    JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(['files', 'schemaVersion']) ||
    manifest.schemaVersion !== 1 ||
    manifest.files === null ||
    typeof manifest.files !== 'object' ||
    Array.isArray(manifest.files)
  ) {
    throw new Error(`publish: invalid publish manifest in ${dir}`)
  }
  const out: Record<string, string> = {}
  for (const [name, expectedDigest] of Object.entries(manifest.files as Record<string, unknown>)) {
    if (
      name === PUBLISH_MANIFEST ||
      name.length === 0 ||
      name === '.' ||
      name === '..' ||
      name.includes('/') ||
      name.includes('\\') ||
      name.includes('\0') ||
      typeof expectedDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(expectedDigest)
    ) {
      throw new Error(`publish: manifest digest malformed for ${name} in ${dir}`)
    }
    const bytes = await readFile(join(dir, name), 'utf8')
    if (sha256Hex(bytes) !== expectedDigest) {
      throw new Error(`publish: published file failed integrity verification: ${join(dir, name)}`)
    }
    out[name] = bytes
  }
  return out
}
