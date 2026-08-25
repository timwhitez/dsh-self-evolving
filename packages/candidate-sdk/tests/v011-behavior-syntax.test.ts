import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deriveV011Operations, snapshotV011Tree } from '../src/index.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-v011-behavior-syntax-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function diff(parentSource: string, childSource: string) {
  const parentRoot = join(root!, 'parent')
  const childRoot = join(root!, 'child')
  await mkdir(join(parentRoot, 'src'), { recursive: true })
  await mkdir(join(childRoot, 'src'), { recursive: true })
  await writeFile(join(parentRoot, 'src', 'index.ts'), parentSource)
  await writeFile(join(childRoot, 'src', 'index.ts'), childSource)
  return deriveV011Operations(await snapshotV011Tree(parentRoot), await snapshotV011Tree(childRoot))
}

describe('v0.1.1 grammar-aware production change projection', () => {
  it.each([
    [
      'URL string',
      'export const endpoint = "https://example.test/v1"\n',
      'export const endpoint = "https://example.test/v2"\n',
    ],
    [
      'block-comment-shaped string',
      'export const marker = "prefix /* first */ suffix"\n',
      'export const marker = "prefix /* second */ suffix"\n',
    ],
    [
      'regular expression literal',
      'export const route = /https?:\\/\\/old\\.test/\n',
      'export const route = /https?:\\/\\/new\\.test/\n',
    ],
    [
      'template literal text',
      'export const message = `visit //old ${1}`\n',
      'export const message = `visit //new ${1}`\n',
    ],
    [
      'escaped quote literal',
      'export const quote = "a \\"first\\" value"\n',
      'export const quote = "a \\"second\\" value"\n',
    ],
  ])('detects a behavior change in %s', async (_name, parent, child) => {
    const result = await diff(parent, child)
    expect(result.productionChanged).toBe(true)
    expect(result.operations).toEqual([{ op: 'modify', path: 'src/index.ts' }])
  })

  it.each([
    [
      'line comment',
      'export const value = 1 // first explanation\n',
      'export const value = 1 // second explanation\n',
    ],
    [
      'block comment',
      'export const value = 1 /* first explanation */\n',
      'export const value = 1 /* second explanation */\n',
    ],
    [
      'template expression comment',
      'export const value = `count:${1 /* first */}`\n',
      'export const value = `count:${1 /* second */}`\n',
    ],
    [
      'formatting',
      'export const value={a:1,b:"https://example.test"}\n',
      'export const value = { a: 1, b: "https://example.test" }\n',
    ],
  ])('rejects a %s-only production edit', async (_name, parent, child) => {
    await expect(diff(parent, child)).rejects.toThrow(
      /test\/comment\/format\/manifest-only child rejected/,
    )
  })
})
