/**
 * Worker exit-gate negative coverage (issue #200).
 *
 * verifyFinishedTreeBinding is the sandbox worker's post-turn gate: any
 * mutation of the child tree after finish_proposal must fail it. Direct
 * fault-injection on the gate logic (the worker wiring is covered positively
 * by the sandboxed-proposal E2E).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  canonicalizeV011Tree,
  digestV011,
  snapshotV011Tree,
} from '@dsh-self-evolving/candidate-sdk'
import { verifyFinishedTreeBinding } from '../src/v011-runner.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'v011-finish-gate-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function seededDigest(): Promise<string> {
  await mkdir(join(root!, 'src'), { recursive: true })
  await writeFile(join(root!, 'src', 'index.ts'), 'export const a = 1\n')
  const snapshot = await snapshotV011Tree(root!)
  return digestV011((await canonicalizeV011Tree(snapshot)).bytes)
}

describe('verifyFinishedTreeBinding (issue #200)', () => {
  it('passes when the tree still hashes to the finish digest', async () => {
    const digest = await seededDigest()
    await expect(verifyFinishedTreeBinding(root!, digest)).resolves.toBeUndefined()
  })

  it('fails when a file is modified after finish', async () => {
    const digest = await seededDigest()
    await writeFile(join(root!, 'src', 'index.ts'), 'export const evil = 1\n')
    await expect(verifyFinishedTreeBinding(root!, digest)).rejects.toThrow(
      /changed after finish_proposal/,
    )
  })

  it('fails when a file is added after finish', async () => {
    const digest = await seededDigest()
    await writeFile(join(root!, 'planted.ts'), 'export const p = 1\n')
    await expect(verifyFinishedTreeBinding(root!, digest)).rejects.toThrow(
      /changed after finish_proposal/,
    )
  })

  it('fails when a supporting file is removed after finish', async () => {
    await seededDigest()
    await writeFile(join(root!, 'extra.ts'), 'export const e = 1\n')
    const withExtra = digestV011((await canonicalizeV011Tree(await snapshotV011Tree(root!))).bytes)
    await rm(join(root!, 'extra.ts'))
    await expect(verifyFinishedTreeBinding(root!, withExtra)).rejects.toThrow(
      /changed after finish_proposal/,
    )
  })
})
