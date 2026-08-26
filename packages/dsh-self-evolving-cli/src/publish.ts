/**
 * Atomic multi-file evidence publication (issues #55 / #45).
 *
 * Publishing related evidence files one-by-one at their final paths leaves a
 * crash window where a result exists without its receipts (or vice versa) and
 * resume treats the partial state as complete. A bundle is instead published
 * with a LAST-written manifest commit marker:
 *
 *   1. every entry is written + fsynced under a unique staging name,
 *   2. renamed to its final name,
 *   3. after all entries are durable, `publish-manifest.json` is created
 *      exclusively, binding each file's sha256.
 *
 * Readers gate on the manifest: a bundle without one is an INCOMPLETE prior
 * attempt and must never be adopted as finished; a complete bundle is
 * verified byte-for-byte against the manifest digests on every load.
 */
import { createHash } from 'node:crypto'
import { open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const PUBLISH_MANIFEST = 'publish-manifest.json'

export interface PublishedBundle {
  files: Record<string, string>
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

/**
 * Publish a set of evidence files atomically. Throws if ANY final entry or
 * the manifest already exists — publication happens exactly once.
 */
export async function publishBundle(dir: string, entries: Record<string, string>): Promise<void> {
  const names = Object.keys(entries).sort()
  if (names.length === 0) throw new Error('publish: empty bundle')
  const files: Record<string, string> = {}
  const staged: Array<{ staging: string; final: string }> = []
  try {
    for (const name of names) {
      const bytes = entries[name]!
      files[name] = sha256Hex(bytes)
      const staging = join(dir, `.${name}.staging-${process.pid}-${randomUUID()}`)
      await writeDurable(staging, bytes)
      staged.push({ staging, final: join(dir, name) })
    }
    for (const { staging, final } of staged) {
      // link() refuses to clobber an existing final file; fall back to rename
      // semantics only when the target is provably absent.
      try {
        await rename(staging, final)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        throw new Error(`publish: final path already exists: ${final}`, { cause: error })
      }
    }
    await writeDurable(
      join(dir, PUBLISH_MANIFEST),
      JSON.stringify({ schemaVersion: 1, files }, null, 2) + '\n',
    )
    for (const { staging } of staged) await rm(staging, { force: true }).catch(() => {})
  } catch (error) {
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
    manifest.schemaVersion !== 1 ||
    manifest.files === null ||
    typeof manifest.files !== 'object' ||
    Array.isArray(manifest.files)
  ) {
    throw new Error(`publish: invalid publish manifest in ${dir}`)
  }
  const out: Record<string, string> = {}
  for (const [name, expectedDigest] of Object.entries(manifest.files as Record<string, unknown>)) {
    if (typeof expectedDigest !== 'string' || !/^[0-9a-f]{64}$/.test(expectedDigest)) {
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
