import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyCandidateSourceDiff } from '../src/index.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rsi-source-diff-'))
  roots.push(root)
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'index.ts'), "export const value = 'old'\n")
  return root
}

describe('trusted candidate source diff', () => {
  it('applies a hunk-only proposer patch to src/index.ts', async () => {
    const root = await fixture()
    await applyCandidateSourceDiff(
      root,
      "@@ -1 +1 @@\n-export const value = 'old'\n+export const value = 'new'",
    )
    expect(await readFile(join(root, 'src', 'index.ts'), 'utf8')).toBe(
      "export const value = 'new'\n",
    )
  })

  it('rejects a patch for any other path', async () => {
    const root = await fixture()
    await expect(
      applyCandidateSourceDiff(
        root,
        '--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-{}\n+{"scripts":{}}',
      ),
    ).rejects.toThrow('escapes src/index.ts')
  })
})
