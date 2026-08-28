/**
 * Atomic bundle publication contract (issues #55 / #45).
 *
 * The manifest is the commit point: readers observe either no bundle
 * (incomplete prior attempt) or a fully verified set of files; any bytes
 * failing their bound digests are rejected on every load.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadPublishedBundle, PUBLISH_MANIFEST, publishBundle } from '../src/publish.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'publish-bundle-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('atomic publication', () => {
  it('round-trips a published bundle with verified bytes', async () => {
    const dir = join(root!, 'bundle')
    await mkdir(dir, { recursive: true })
    await publishBundle(dir, {
      'proposal.json': '{"id":"p1"}\n',
      'gateway-receipts.json': '[{"requestId":"r1"}]\n',
    })
    const loaded = await loadPublishedBundle(dir)
    expect(loaded).not.toBeNull()
    expect(loaded!['proposal.json']).toBe('{"id":"p1"}\n')
    expect(loaded!['gateway-receipts.json']).toBe('[{"requestId":"r1"}]\n')
  })

  it('returns null when the commit manifest is absent (incomplete prior attempt)', async () => {
    const dir = join(root!, 'partial')
    await mkdir(dir, { recursive: true })
    // A crashed publisher may have left proposal bytes but never committed.
    await writeFile(join(dir, 'proposal.json'), '{"id":"p1"}\n')
    expect(await loadPublishedBundle(dir)).toBeNull()
    expect(await loadPublishedBundle(join(root!, 'absent'))).toBeNull()
  })

  it('rejects a bound file that fails its manifest digest', async () => {
    const dir = join(root!, 'tampered')
    await mkdir(dir, { recursive: true })
    await publishBundle(dir, { 'proposal.json': '{"id":"p1"}\n' })
    await writeFile(join(dir, 'proposal.json'), '{"id":"p2"}\n')
    await expect(loadPublishedBundle(dir)).rejects.toThrow(/integrity verification/)
  })

  it('refuses double publication of the same directory', async () => {
    const dir = join(root!, 'once')
    await mkdir(dir, { recursive: true })
    await publishBundle(dir, { 'a.json': 'A\n' })
    await expect(publishBundle(dir, { 'a.json': 'CORRUPT\n' })).rejects.toThrow(/already exists/)
    expect(await readFile(join(dir, 'a.json'), 'utf8')).toBe('A\n')
  })

  it('treats an empty bundle as a protocol violation', async () => {
    const dir = join(root!, 'empty')
    await mkdir(dir, { recursive: true })
    await expect(publishBundle(dir, {})).rejects.toThrow(/empty bundle/)
  })

  it('refuses an entry that collides with the reserved manifest name', async () => {
    const dir = join(root!, 'naming')
    await mkdir(dir, { recursive: true })
    // The commit marker owns its name exclusively; an impostor entry must
    // fail closed instead of shadowing the verification anchor.
    await expect(publishBundle(dir, { [PUBLISH_MANIFEST]: 'IMPOSTOR\n' })).rejects.toThrow()
  })
})
