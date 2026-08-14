/** Gate 3: actual controller processes are SIGKILLed at every saga boundary. */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  computeTotals,
  readAll,
  replay,
  stateHash,
  type BudgetLimits,
  type DurableBoundary,
  type Journal,
} from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const worker = join(here, 'fixtures', 'controller-crash-worker.mjs')
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function runWorker(
  stateDir: string,
  boundary: DurableBoundary | 'none',
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [worker, stateDir, boundary], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const stderr: string[] = []
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => stderr.push(chunk))
    child.once('error', reject)
    child.once('exit', (code, signal) => done({ code, signal, stderr: stderr.join('') }))
  })
}

const limits: BudgetLimits = {
  usd: 10,
  solverTokens: 1_000_000,
  proposerTokens: 1_000_000,
  taskTrials: 10,
  proposalCalls: 10,
  wallClockSec: 3600,
  concurrencySlots: 1,
  storageBytes: 1_000_000,
}

describe('Gate 3 — process-level crash/resume', () => {
  for (const boundary of ['intent', 'launch', 'collect', 'commit'] as const) {
    it(`SIGKILL after ${boundary} resumes without duplicate launch, score, or cost`, async () => {
      const root = await mkdtemp(join(tmpdir(), `dsh-rsi-process-${boundary}-`))
      roots.push(root)
      const crashed = await runWorker(root, boundary)
      expect(crashed.signal, crashed.stderr).toBe('SIGKILL')

      const resumed = await runWorker(root, 'none')
      expect(resumed.code, resumed.stderr).toBe(0)
      expect(resumed.signal).toBeNull()

      const provider = JSON.parse(await readFile(join(root, 'provider.json'), 'utf8')) as {
        launchCount: number
        collectCount: number
      }
      expect(provider.launchCount).toBe(1)
      expect(provider.collectCount).toBe(1)

      const journal: Journal = {
        journalDir: join(root, 'journal'),
        runId: 'run-process-crash-e2e',
        segmentMaxBytes: 1_000_000,
      }
      const events = await readAll(journal)
      expect(events.filter((event) => event.type === 'action.launched')).toHaveLength(1)
      expect(events.filter((event) => event.type === 'evaluation.observed')).toHaveLength(1)
      expect(events.filter((event) => event.type === 'action.committed')).toHaveLength(1)
      expect(stateHash(replay(await readAll(journal)))).toBe(stateHash(replay(events)))

      const { totals, entries } = await computeTotals({
        ledgerPath: join(root, 'budget.jsonl'),
        limits,
      })
      expect(entries.filter((entry) => entry.kind === 'spend')).toHaveLength(1)
      expect(entries.filter((entry) => entry.kind === 'release')).toHaveLength(1)
      expect(totals.spent.usd).toBe(2)
      expect(totals.reserved.usd).toBe(0)

      const journalFiles = await readdir(join(root, 'journal'))
      expect(journalFiles.some((name) => name.startsWith('lock.stale-'))).toBe(true)
      await expect(stat(join(root, 'journal', 'lock.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    })
  }
})
