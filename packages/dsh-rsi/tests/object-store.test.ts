/**
 * Object store tests (spec 06 §3): content-addressing, no-clobber, scrub, corruption.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { publishBytes, readBytes, scrub, exists, type ObjectStore } from '../src/index.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-rsi-obj-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function store(): ObjectStore {
  return { root: root! }
}

describe('object store', () => {
  it('publishes bytes and the digest matches the content', async () => {
    const bytes = new TextEncoder().encode('hello world')
    const ref = await publishBytes(store(), bytes, 'text/plain', 'DEV_OBSERVED')
    expect(ref.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(ref.size).toBe(11)
    expect(ref.label).toBe('DEV_OBSERVED')
    expect(await exists(store(), ref.digest)).toBe(true)
  })

  it('same bytes → same digest (dedup)', async () => {
    const bytes = new TextEncoder().encode('same content')
    const a = await publishBytes(store(), bytes, 'text/plain', 'DEV_OBSERVED')
    const b = await publishBytes(store(), bytes, 'text/plain', 'DEV_OBSERVED')
    expect(a.digest).toBe(b.digest)
  })

  it('readBytes verifies integrity on read', async () => {
    const bytes = new TextEncoder().encode('integrity check')
    const ref = await publishBytes(store(), bytes, 'text/plain', 'DEV_OBSERVED')
    const read = await readBytes(store(), ref.digest)
    expect(new TextDecoder().decode(read)).toBe('integrity check')
  })

  it('readBytes rejects a tampered object (EVIDENCE_CORRUPT)', async () => {
    const bytes = new TextEncoder().encode('original')
    const ref = await publishBytes(store(), bytes, 'text/plain', 'DEV_OBSERVED')
    // Tamper the stored object on disk.
    const path = join(root!, 'objects', 'sha256', ref.digest.slice(0, 2), ref.digest)
    await writeFile(path, 'TAMPERED')
    await expect(readBytes(store(), ref.digest)).rejects.toThrow(/EVIDENCE_CORRUPT/)
  })

  it('scrub reports zero corrupt digests on a healthy store', async () => {
    await publishBytes(store(), new TextEncoder().encode('a'), 'text/plain', 'DEV_OBSERVED')
    await publishBytes(store(), new TextEncoder().encode('b'), 'text/plain', 'DEV_OBSERVED')
    const corrupt = await scrub(store())
    expect(corrupt).toEqual([])
  })

  it('scrub detects a corrupted object', async () => {
    const ref = await publishBytes(
      store(),
      new TextEncoder().encode('clean'),
      'text/plain',
      'DEV_OBSERVED',
    )
    const path = join(root!, 'objects', 'sha256', ref.digest.slice(0, 2), ref.digest)
    await writeFile(path, 'corrupted-bytes')
    const corrupt = await scrub(store())
    expect(corrupt).toContain(ref.digest)
  })

  it('no-clobber: republishing different bytes under a colliding path is detected', async () => {
    const bytes = new TextEncoder().encode('content-one')
    const ref = await publishBytes(store(), bytes, 'text/plain', 'DEV_OBSERVED')
    // Manually write a different-size file at the digest path to simulate collision.
    const path = join(root!, 'objects', 'sha256', ref.digest.slice(0, 2), ref.digest)
    await writeFile(path, 'shorter-but-different')
    // Republishing the ORIGINAL bytes should detect the size mismatch.
    await expect(publishBytes(store(), bytes, 'text/plain', 'DEV_OBSERVED')).rejects.toThrow(
      /EVIDENCE_CORRUPT/,
    )
  })
})
