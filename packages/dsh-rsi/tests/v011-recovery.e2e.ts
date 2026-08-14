import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { settleV011GenerationAttempts, v011LineageStateHash } from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const worker = resolve(here, 'fixtures', 'v011-crash-worker.mjs')
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function run(root: string, action: 'proposal' | 'outcome', phase: 'crash' | 'resume') {
  return new Promise<{
    code: number | null
    signal: NodeJS.Signals | null
    stdout: string
    stderr: string
  }>((done, reject) => {
    const child = spawn(process.execPath, [worker, root, action, phase], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.once('error', reject)
    child.once('exit', (code, signal) =>
      done({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    )
  })
}

describe('v0.1.1 rejection and real crash recovery', () => {
  it('reuses a published proposal after SIGKILL without another model call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rsi-v011-crash-proposal-'))
    roots.push(root)
    expect((await run(root, 'proposal', 'crash')).signal).toBe('SIGKILL')
    const resumed = await run(root, 'proposal', 'resume')
    expect(resumed.code, resumed.stderr).toBe(0)
    expect(JSON.parse(resumed.stdout)).toMatchObject({ status: 'REUSED' })
    expect((await readFile(join(root, 'model-calls.txt'), 'utf8')).trim().split('\n')).toHaveLength(
      1,
    )
  })

  it('reuses exactly one outcome after SIGKILL between settlement and controller commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rsi-v011-crash-outcome-'))
    roots.push(root)
    expect((await run(root, 'outcome', 'crash')).signal).toBe('SIGKILL')
    const resumed = await run(root, 'outcome', 'resume')
    expect(resumed.code, resumed.stderr).toBe(0)
    const parsed = JSON.parse(resumed.stdout) as { status: string; record: { status: string } }
    expect(parsed).toMatchObject({ status: 'REUSED', record: { status: 'TARGET_IMPROVED' } })
    expect(JSON.parse(await readFile(join(root, 'outcome.json'), 'utf8'))).toMatchObject({
      status: 'TARGET_IMPROVED',
    })
  })

  it('retains one invalid child, replaces it, and deterministically exhausts three attempts', () => {
    const rejected = { attempt: 1, status: 'REJECTED' as const, classification: 'POLICY_REJECT' }
    expect(
      settleV011GenerationAttempts([
        rejected,
        { attempt: 2, status: 'ADMITTED', artifactDigest: `sha256:${'a'.repeat(64)}` },
      ]),
    ).toEqual({ status: 'ADMITTED', admittedDigest: `sha256:${'a'.repeat(64)}` })
    expect(
      settleV011GenerationAttempts([
        rejected,
        { attempt: 2, status: 'REJECTED', classification: 'BUILD_REJECT' },
        { attempt: 3, status: 'REJECTED', classification: 'LOADER_REJECT' },
      ]),
    ).toEqual({ status: 'NO_ADMISSIBLE_CHILD', admittedDigest: null })
  })

  it('canonical replay order yields one lineage state hash', () => {
    const input = {
      runId: 'v011-replay',
      candidates: [
        { digest: `sha256:${'b'.repeat(64)}`, parent: `sha256:${'a'.repeat(64)}` },
        { digest: `sha256:${'a'.repeat(64)}`, parent: null },
      ],
      attempts: [
        { attempt: 1, status: 'ADMITTED' as const, artifactDigest: `sha256:${'b'.repeat(64)}` },
      ],
      outcomes: [],
    }
    expect(v011LineageStateHash(input)).toBe(
      v011LineageStateHash({ ...input, candidates: [...input.candidates].reverse() }),
    )
  })
})
