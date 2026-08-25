import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCanonicalArchive, declareFiles } from '../src/index.js'

const roots: string[] = []

async function fixture(paths: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'candidate-unicode-paths-'))
  roots.push(root)
  for (const path of paths) {
    const full = join(root, path)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, `export const value = ${JSON.stringify(path)}\n`)
  }
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('canonical Unicode path collision policy', () => {
  it('rejects NFC/NFD-equivalent paths without rewriting original archive names', async () => {
    const nfc = 'caf\u00e9.ts'
    const nfd = 'cafe\u0301.ts'
    const root = await fixture([nfc, nfd])

    await expect(buildCanonicalArchive(declareFiles(root, [nfc, nfd]))).rejects.toThrow(
      /case\/unicode collision/,
    )
  })

  it('rejects combined case and normalization aliases in nested components', async () => {
    const first = 'Src/CAF\u00c9/index.ts'
    const second = 'src/cafe\u0301/index.ts'
    const root = await fixture([first, second])

    await expect(buildCanonicalArchive(declareFiles(root, [first, second]))).rejects.toThrow(
      /case\/unicode collision/,
    )
  })

  it('keeps genuinely distinct normalized paths and their original UTF-8 bytes', async () => {
    const first = 'caf\u00e9.ts'
    const second = 'caf\u00e8.ts'
    const root = await fixture([first, second])

    const archive = await buildCanonicalArchive(declareFiles(root, [second, first]))
    const text = Buffer.from(archive.bytes).toString('utf8')
    expect(text).toContain(first)
    expect(text).toContain(second)
    expect(archive.fileCount).toBe(2)
  })
})
