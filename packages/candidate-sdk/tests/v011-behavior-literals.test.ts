import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deriveV011Operations, snapshotV011Tree } from '../src/index.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-v011-behavior-literals-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function snapshots(parentSource: string, childSource: string) {
  const parentRoot = join(root!, 'parent')
  const childRoot = join(root!, 'child')
  await mkdir(join(parentRoot, 'src'), { recursive: true })
  await mkdir(join(childRoot, 'src'), { recursive: true })
  await writeFile(join(parentRoot, 'src', 'index.ts'), parentSource)
  await writeFile(join(childRoot, 'src', 'index.ts'), childSource)
  return {
    parent: await snapshotV011Tree(parentRoot),
    child: await snapshotV011Tree(childRoot),
  }
}

describe('v0.1.1 production-change literal handling', () => {
  it('detects a behavior change after // inside a URL string', async () => {
    const { parent, child } = await snapshots(
      'export const endpoint = "https://example.test/v1"\n',
      'export const endpoint = "https://example.test/v2"\n',
    )

    const diff = await deriveV011Operations(parent, child)
    expect(diff.productionChanged).toBe(true)
    expect(diff.operations).toEqual([{ op: 'modify', path: 'src/index.ts' }])
  })

  it('detects a behavior change inside a block-comment-shaped string', async () => {
    const { parent, child } = await snapshots(
      'export const marker = "prefix /* first */ suffix"\n',
      'export const marker = "prefix /* second */ suffix"\n',
    )

    const diff = await deriveV011Operations(parent, child)
    expect(diff.productionChanged).toBe(true)
  })

  it('treats whitespace inside a string literal as behavior-significant', async () => {
    const { parent, child } = await snapshots(
      'export const value = "a b"\n',
      'export const value = "ab"\n',
    )

    expect((await deriveV011Operations(parent, child)).productionChanged).toBe(true)
  })

  it('continues to reject an actual comment-only production edit', async () => {
    const { parent, child } = await snapshots(
      'export const value = 1 // first explanation\n',
      'export const value = 1 // second explanation\n',
    )

    await expect(deriveV011Operations(parent, child)).rejects.toThrow(
      /test\/comment\/format\/manifest-only child rejected/,
    )
  })
})
