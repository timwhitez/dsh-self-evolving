import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
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

type Action = 'proposal' | 'outcome'
type CrashPhase =
  | 'before-entry'
  | 'during'
  | 'append-segment-write'
  | 'append-segment-fsync'
  | 'append-segment-directory-fsync'
  | 'append-head-staging-write'
  | 'append-head-staging-fsync'
  | 'append-head-rename'
  | 'append-head-directory-fsync'
  | 'after-commit'
type Phase = CrashPhase | 'resume' | 'uninterrupted'

interface WorkerResult {
  result: { status: 'CREATED' | 'REUSED'; record?: { status: string } }
  reconciliationStatus: 'CREATED' | 'REUSED'
  events: Array<{
    eventId: string
    eventHash: string
    type: string
    payload: Record<string, unknown>
  }>
  controller: { eventCount: number; stateHash: string; head: Record<string, unknown> }
}

function run(root: string, action: Action, phase: Phase) {
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
  it.each(['proposal', 'outcome'] as const)(
    'converges %s publication across every callback SIGKILL boundary',
    async (action) => {
      const baselineRoot = await mkdtemp(
        join(tmpdir(), `dsh-self-evolving-v011-baseline-${action}-`),
      )
      roots.push(baselineRoot)
      const baselineProcess = await run(baselineRoot, action, 'uninterrupted')
      expect(baselineProcess.code, baselineProcess.stderr).toBe(0)
      const baseline = JSON.parse(baselineProcess.stdout) as WorkerResult
      expect(baseline.result.status).toBe('CREATED')
      expect(baseline.reconciliationStatus).toBe('CREATED')
      expect(baseline.events).toHaveLength(2)
      expect(
        baseline.events.filter((event) => event.type === 'v011.artifact.reconciled'),
      ).toHaveLength(1)

      const crashPhases: CrashPhase[] = [
        'before-entry',
        'during',
        'append-segment-write',
        'append-segment-fsync',
        'append-segment-directory-fsync',
        'append-head-staging-write',
        'append-head-staging-fsync',
        'append-head-rename',
        'append-head-directory-fsync',
        'after-commit',
      ]
      for (const phase of crashPhases) {
        const root = await mkdtemp(join(tmpdir(), `dsh-self-evolving-v011-${action}-${phase}-`))
        roots.push(root)
        expect((await run(root, action, phase)).signal).toBe('SIGKILL')
        if (phase === 'during') {
          expect(await readFile(join(root, 'callback-started.txt'), 'utf8')).toMatch(
            /^sha256:[0-9a-f]{64}\n$/,
          )
        }

        const resumedProcess = await run(root, action, 'resume')
        expect(resumedProcess.code, resumedProcess.stderr).toBe(0)
        const resumed = JSON.parse(resumedProcess.stdout) as WorkerResult
        expect(resumed.result.status).toBe('REUSED')
        expect(resumed.events).toEqual(baseline.events)
        expect(resumed.controller).toEqual(baseline.controller)
        const committedBeforeCrash = [
          'append-head-rename',
          'append-head-directory-fsync',
          'after-commit',
        ].includes(phase)
        expect(resumed.reconciliationStatus).toBe(committedBeforeCrash ? 'REUSED' : 'CREATED')
        expect(
          resumed.events.filter((event) => event.type === 'v011.artifact.reconciled'),
        ).toHaveLength(1)
        if (phase.startsWith('append-') && !committedBeforeCrash) {
          expect(await readdir(join(root, 'journal', 'crash-residue'))).not.toHaveLength(0)
        }
        if (action === 'proposal') {
          expect(
            (await readFile(join(root, 'model-calls.txt'), 'utf8')).trim().split('\n'),
          ).toHaveLength(1)
        } else {
          expect(resumed.result.record).toMatchObject({ status: 'TARGET_IMPROVED' })
          expect(JSON.parse(await readFile(join(root, 'outcome.json'), 'utf8'))).toMatchObject({
            status: 'TARGET_IMPROVED',
          })
        }
      }
    },
    60_000,
  )

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
