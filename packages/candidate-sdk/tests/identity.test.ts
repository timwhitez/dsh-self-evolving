/**
 * Canonical tar + candidate identity tests (spec 02 §1).
 *
 * Verifies determinism (same source → same hash), sorted-path order, fixed
 * mode/mtime, and rejection of symlink/traversal/absolute/oversize/collision.
 */
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildCanonicalArchive,
  candidateIdFromArchive,
  declareFiles,
  DEFAULT_LIMITS,
} from '../src/index.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-id-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function writeFile2(rel: string, content: string): Promise<void> {
  const p = join(root!, rel)
  await mkdir(join(p, '..'), { recursive: true })
  await writeFile(p, content)
}

describe('canonical tar + identity', () => {
  it('produces the same hash for the same source regardless of insertion order', async () => {
    await writeFile2('a.ts', 'export const a = 1\n')
    await writeFile2('b.ts', 'export const b = 2\n')
    const filesA = declareFiles(root!, ['b.ts', 'a.ts'])
    const filesB = declareFiles(root!, ['a.ts', 'b.ts'])
    const archA = await buildCanonicalArchive(filesA)
    const archB = await buildCanonicalArchive(filesB)
    expect(archA.hash).toBe(archB.hash)
    expect(archA.candidateId).toBe(archB.candidateId)
    expect(archA.candidateId).toMatch(/^c_[a-z2-7]{26}$/)
  })

  it('produces a DIFFERENT hash when content differs by one byte', async () => {
    await writeFile2('a.ts', 'export const a = 1\n')
    const arch1 = await buildCanonicalArchive(declareFiles(root!, ['a.ts']))
    await writeFile2('a.ts', 'export const a = 2\n')
    const arch2 = await buildCanonicalArchive(declareFiles(root!, ['a.ts']))
    expect(arch1.hash).not.toBe(arch2.hash)
  })

  it('sorts paths by UTF-8 byte order (b before a is normalized)', async () => {
    await writeFile2('a.ts', 'aaa\n')
    await writeFile2('b.ts', 'bbb\n')
    const arch = await buildCanonicalArchive(declareFiles(root!, ['b.ts', 'a.ts']))
    // The archive bytes should contain 'a.ts' before 'b.ts' (USTAR name field).
    const text = Buffer.from(arch.bytes).toString('latin1')
    expect(text.indexOf('a.ts')).toBeLessThan(text.indexOf('b.ts'))
  })

  it('rejects an absolute path', async () => {
    await writeFile2('a.ts', 'x\n')
    await expect(
      buildCanonicalArchive([{ path: '/etc/passwd', absPath: join(root!, 'a.ts') }]),
    ).rejects.toThrow(/absolute path rejected/)
  })

  it('rejects a traversal path', async () => {
    await writeFile2('a.ts', 'x\n')
    await expect(
      buildCanonicalArchive([{ path: '../escape.ts', absPath: join(root!, 'a.ts') }]),
    ).rejects.toThrow(/traversal path rejected/)
  })

  it('rejects a symlink', async () => {
    await writeFile2('real.ts', 'x\n')
    await symlink(join(root!, 'real.ts'), join(root!, 'link.ts'))
    await expect(buildCanonicalArchive(declareFiles(root!, ['link.ts']))).rejects.toThrow(
      /not a regular file|symlink/,
    )
  })

  it('rejects files exceeding the size limit', async () => {
    await writeFile2('big.ts', 'x'.repeat(DEFAULT_LIMITS.maxFileBytes + 1))
    await expect(buildCanonicalArchive(declareFiles(root!, ['big.ts']))).rejects.toThrow(/exceeds/)
  })

  it('rejects when file count exceeds the limit', async () => {
    for (let i = 0; i <= DEFAULT_LIMITS.maxFileCount; i++) {
      await writeFile2(`f${i}.ts`, 'x\n')
    }
    const paths = Array.from({ length: DEFAULT_LIMITS.maxFileCount + 1 }, (_, i) => `f${i}.ts`)
    await expect(buildCanonicalArchive(declareFiles(root!, paths))).rejects.toThrow(/exceeds max/)
  })

  it('rejects case-fold path collisions', async () => {
    await writeFile2('Foo.ts', 'x\n')
    await writeFile2('foo.ts', 'y\n')
    await expect(buildCanonicalArchive(declareFiles(root!, ['Foo.ts', 'foo.ts']))).rejects.toThrow(
      /case\/unicode collision/,
    )
  })

  it('candidateIdFromArchive recomputes the same id from the bytes', async () => {
    await writeFile2('a.ts', 'export const a = 1\n')
    const arch = await buildCanonicalArchive(declareFiles(root!, ['a.ts']))
    const recomputed = candidateIdFromArchive(arch.bytes)
    expect(recomputed.candidateId).toBe(arch.candidateId)
    expect(recomputed.hash).toBe(arch.hash)
  })
})
