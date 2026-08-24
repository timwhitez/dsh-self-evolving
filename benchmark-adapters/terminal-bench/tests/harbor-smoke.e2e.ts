/**
 * Gate 2 — real Harbor job smoke (spec 07 §4 Accept).
 *
 * Runs three REAL Harbor jobs against the smoke-task fixture through the full
 * pipeline (docker build → solution/oracle-or-nop → verifier → reward), then
 * normalizes each trial's artifacts through the TS adapter and asserts:
 *
 *   golden (oracle + correct solution) → reward 1.0 → PASS
 *   nop    (nop agent)                 → reward 0.0 → FAIL
 *   broken (oracle + crashing solution) → reward 0.0 → FAIL
 *
 * This proves the adapter's verifier pipeline and normalizer work against real
 * Harbor output, not synthetic fixtures. The smoke task is model-free (no API
 * key, no paid model) — the "agent" is a fixed script.
 *
 * Requires: docker daemon + harbor venv at ./harbor/.venv. Skips gracefully if
 * the harbor binary is absent (e.g. CI without docker).
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeTrial } from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const harborDir = join(repoRoot, 'harbor')
const fixturesDir = join(here, '..', 'fixtures')
const harborBin = join(harborDir, '.venv', 'bin', 'harbor')

const SMOKE_TIMEOUT = { timeout: 300_000 }

let scratch: string | undefined

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-harbor-e2e-'))
})

afterEach(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
  scratch = undefined
})

async function harborAvailable(): Promise<boolean> {
  try {
    await new Promise<void>((resolveRun, reject) => {
      execFile(harborBin, ['--version'], { cwd: harborDir }, (err) =>
        err ? reject(err) : resolveRun(),
      )
    })
    return true
  } catch {
    return false
  }
}

/**
 * Run a Harbor job from a job-config YAML and return the path to the single
 * trial directory it produced.
 */
async function runHarborJob(jobName: string, agent: string, taskRel: string): Promise<string> {
  const jobsDir = join(scratch!, `jobs-${jobName}`)
  const cfg = {
    job_name: `dsh-self-evolving-${jobName}`,
    jobs_dir: jobsDir,
    n_attempts: 1,
    n_concurrent_trials: 1,
    environment: { type: 'docker', force_build: true, delete: true },
    agents: [{ name: agent }],
    tasks: [{ path: taskRel }],
  }
  const cfgPath = join(scratch!, `${jobName}.yaml`)
  await writeFile(cfgPath, yamlStringify(cfg))
  await new Promise<void>((resolveRun, reject) => {
    execFile(
      harborBin,
      ['job', 'start', '-c', cfgPath],
      { cwd: harborDir },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(`harbor job failed: ${stderr}\n${err.message}`))
        else resolveRun()
      },
    )
  })
  // Find the trial directory: <jobsDir>/<job_name>/<task>__<id>/
  const { readdir } = await import('node:fs/promises')
  const jobDir = join(jobsDir, `dsh-self-evolving-${jobName}`)
  const entries = await readdir(jobDir, { withFileTypes: true })
  const trialDir = entries.find((e) => e.isDirectory() && e.name.includes('__'))
  if (!trialDir) throw new Error(`no trial directory under ${jobDir}`)
  return join(jobDir, trialDir.name)
}

/** Minimal YAML stringifier for the simple flat job config (avoids a dep here). */
function yamlStringify(cfg: unknown): string {
  const lines: string[] = []
  function emit(obj: unknown, indent = ''): void {
    if (obj === null || typeof obj !== 'object') {
      lines.push(`${indent}${String(obj)}`)
      return
    }
    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
          const keys = Object.keys(item as Record<string, unknown>)
          lines.push(
            `${indent}- ${keys[0]}: ${formatVal((item as Record<string, unknown>)[keys[0]!])}`,
          )
          for (const k of keys.slice(1)) {
            lines.push(`${indent}  ${k}: ${formatVal((item as Record<string, unknown>)[k])}`)
          }
        } else {
          lines.push(`${indent}- ${String(item)}`)
        }
      }
      return
    }
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v !== null && typeof v === 'object') {
        lines.push(`${indent}${k}:`)
        emit(v, indent + '  ')
      } else {
        lines.push(`${indent}${k}: ${formatVal(v)}`)
      }
    }
  }
  function formatVal(v: unknown): string {
    if (typeof v === 'string') return v
    return String(v)
  }
  emit(cfg)
  return lines.join('\n') + '\n'
}

describe.skipIf(
  !(await import('node:fs/promises').then((fs) =>
    fs
      .stat(harborBin)
      .then(() => true)
      .catch(() => false),
  )),
)('Gate 2 — real Harbor extract-elf-style smoke', () => {
  it(
    'golden: oracle + correct solution → reward 1.0 → normalizer PASS',
    SMOKE_TIMEOUT,
    async () => {
      if (!(await harborAvailable())) return // skip when harbor absent
      const trialDir = await runHarborJob('golden', 'oracle', join(fixturesDir, 'smoke-task'))
      // Write the attribution sidecar the TCB controller would write.
      await writeFile(
        join(trialDir, 'attribution.json'),
        JSON.stringify({ candidate_id: 'c_baseline', task_id: 'smoke', attempt_index: 0 }),
      )
      // Copy the verifier reward as a trajectory stand-in (the smoke task is script-based;
      // a real ACP trial writes acp-events.jsonl).
      await writeFile(join(trialDir, 'trajectory.json'), JSON.stringify({ source: 'oracle-smoke' }))
      const rec = await normalizeTrial({
        trialDir,
        expectedCandidateId: 'c_baseline',
        taskId: 'smoke',
        expectedAttemptIndex: 0,
      })
      expect(rec.reward).toBe(1.0)
      expect(rec.status).toBe('pass')
    },
  )

  it('nop: nop agent → reward 0.0 → normalizer FAIL', SMOKE_TIMEOUT, async () => {
    if (!(await harborAvailable())) return
    const trialDir = await runHarborJob('nop', 'nop', join(fixturesDir, 'smoke-task'))
    await writeFile(
      join(trialDir, 'attribution.json'),
      JSON.stringify({ candidate_id: 'c_baseline', task_id: 'smoke', attempt_index: 0 }),
    )
    await writeFile(join(trialDir, 'trajectory.json'), JSON.stringify({ source: 'nop' }))
    const rec = await normalizeTrial({
      trialDir,
      expectedCandidateId: 'c_baseline',
      taskId: 'smoke',
      expectedAttemptIndex: 0,
    })
    expect(rec.reward).toBe(0.0)
    expect(rec.status).toBe('fail')
  })

  it(
    'broken: oracle + crashing solution → reward 0.0 → normalizer FAIL',
    SMOKE_TIMEOUT,
    async () => {
      if (!(await harborAvailable())) return
      const trialDir = await runHarborJob(
        'broken',
        'oracle',
        join(fixturesDir, 'smoke-task-broken'),
      )
      await writeFile(
        join(trialDir, 'attribution.json'),
        JSON.stringify({ candidate_id: 'c_baseline', task_id: 'smoke', attempt_index: 0 }),
      )
      await writeFile(join(trialDir, 'trajectory.json'), JSON.stringify({ source: 'broken' }))
      const rec = await normalizeTrial({
        trialDir,
        expectedCandidateId: 'c_baseline',
        taskId: 'smoke',
        expectedAttemptIndex: 0,
      })
      expect(rec.reward).toBe(0.0)
      expect(rec.status).toBe('fail')
    },
  )
})
