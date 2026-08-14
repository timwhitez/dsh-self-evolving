/**
 * Normalizer fixture tests (spec 07 §4 Accept: nop/broken/golden → fail/fail/valid).
 *
 * Uses Harbor's ACTUAL trial result.json structure:
 *   verifier_result.rewards.reward  — numeric reward
 *   exception_info                  — Harbor exception classification
 * plus a controller-written attribution.json sidecar (candidate_id + attempt_index).
 * Trajectory = trajectory.json (or acp-events.jsonl fallback).
 *
 * The normalizer must classify golden→pass, nop→fail, broken→invalid, and
 * INVALID records NEVER drop from the denominator. Re-parse → same record hash.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeTrial } from '../src/index.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-rsi-norm-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function makeTrial(name: string, files: Record<string, string>): Promise<string> {
  const dir = join(root!, name)
  await mkdir(dir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const sub = rel.includes('/') ? join('/', rel, '..').replace(/^\//, '') : ''
    if (sub) await mkdir(join(dir, sub), { recursive: true })
    await writeFile(join(dir, rel), content)
  }
  return dir
}

const CANDIDATE = 'c_baseline0001'
const attribution = (candidateId = CANDIDATE, attemptIndex = 0) =>
  JSON.stringify({ candidate_id: candidateId, attempt_index: attemptIndex })

function harborResult(
  reward: number | null,
  exc: { type?: string; classification?: string } | null = null,
): string {
  return JSON.stringify({
    verifier_result: reward === null ? { rewards: {} } : { rewards: { reward } },
    exception_info: exc,
  })
}

describe('normalizer — nop/broken/golden fixtures', () => {
  it('golden: reward=1.0 + trajectory + matching candidate → PASS', async () => {
    const dir = await makeTrial('golden', {
      'result.json': harborResult(1.0),
      'attribution.json': attribution(),
      'trajectory.json': JSON.stringify({ steps: [{ role: 'agent', content: 'solved' }] }),
    })
    const rec = await normalizeTrial({
      trialDir: dir,
      expectedCandidateId: CANDIDATE,
      taskId: 'smoke',
    })
    expect(rec.status).toBe('pass')
    expect(rec.reward).toBe(1.0)
    expect(rec.trajectoryHash).not.toBeNull()
    expect(rec.retryEligible).toBe(false)
  })

  it('nop: reward=0.0 (agent did nothing) → FAIL', async () => {
    const dir = await makeTrial('nop', {
      'result.json': harborResult(0.0),
      'attribution.json': attribution(),
      'trajectory.json': JSON.stringify({ steps: [] }),
    })
    const rec = await normalizeTrial({
      trialDir: dir,
      expectedCandidateId: CANDIDATE,
      taskId: 'smoke',
    })
    expect(rec.status).toBe('fail')
    expect(rec.reward).toBe(0.0)
  })

  it('broken: missing result.json → INVALID (not dropped)', async () => {
    const dir = await makeTrial('broken-no-result', {
      'attribution.json': attribution(),
      'trajectory.json': JSON.stringify({ steps: [] }),
    })
    const rec = await normalizeTrial({
      trialDir: dir,
      expectedCandidateId: CANDIDATE,
      taskId: 'smoke',
    })
    expect(rec.status).toBe('invalid')
    expect(rec.reason).toMatch(/result\.json missing/)
  })

  it('broken: missing reward → INVALID', async () => {
    const dir = await makeTrial('broken-no-reward', {
      'result.json': harborResult(null),
      'attribution.json': attribution(),
      'trajectory.json': JSON.stringify({ steps: [] }),
    })
    const rec = await normalizeTrial({
      trialDir: dir,
      expectedCandidateId: CANDIDATE,
      taskId: 'smoke',
    })
    expect(rec.status).toBe('invalid')
    expect(rec.reason).toMatch(/reward/)
  })

  it('broken: missing trajectory → INVALID', async () => {
    const dir = await makeTrial('broken-no-traj', {
      'result.json': harborResult(1.0),
      'attribution.json': attribution(),
    })
    const rec = await normalizeTrial({
      trialDir: dir,
      expectedCandidateId: CANDIDATE,
      taskId: 'smoke',
    })
    expect(rec.status).toBe('invalid')
    expect(rec.reason).toMatch(/trajectory/)
  })

  it('broken: candidate attribution mismatch → INVALID', async () => {
    const dir = await makeTrial('broken-mismatch', {
      'result.json': harborResult(1.0),
      'attribution.json': attribution('c_SOMEONE_ELSE'),
      'trajectory.json': JSON.stringify({ steps: [] }),
    })
    const rec = await normalizeTrial({
      trialDir: dir,
      expectedCandidateId: CANDIDATE,
      taskId: 'smoke',
    })
    expect(rec.status).toBe('invalid')
    expect(rec.reason).toMatch(/candidate_id mismatch/)
  })

  it('uses acp-events.jsonl as trajectory fallback', async () => {
    const dir = await makeTrial('acp-traj', {
      'result.json': harborResult(1.0),
      'attribution.json': attribution(),
      'acp-events.jsonl': '{"type":"session/update"}\n',
    })
    const rec = await normalizeTrial({
      trialDir: dir,
      expectedCandidateId: CANDIDATE,
      taskId: 'smoke',
    })
    expect(rec.status).toBe('pass')
    expect(rec.trajectoryHash).not.toBeNull()
  })

  it('infra-classified exception is retry-eligible (reward-independent)', async () => {
    const dir = await makeTrial('infra-oom', {
      'result.json': harborResult(0.0, { type: 'EnvironmentError', classification: 'oom-crash' }),
      'attribution.json': attribution(),
      'trajectory.json': JSON.stringify({ steps: [] }),
    })
    const rec = await normalizeTrial({
      trialDir: dir,
      expectedCandidateId: CANDIDATE,
      taskId: 'smoke',
    })
    expect(rec.status).toBe('fail')
    expect(rec.retryEligible).toBe(true)
    expect(rec.infraClass).toBe('oom-crash')
  })
})

describe('normalizer — reproducibility', () => {
  it('re-parsing the same artifacts yields the same record hash', async () => {
    const dir = await makeTrial('repro', {
      'result.json': harborResult(1.0),
      'attribution.json': attribution(CANDIDATE, 2),
      'trajectory.json': JSON.stringify({ steps: [{ content: 'x' }] }),
    })
    const rec1 = await normalizeTrial({
      trialDir: dir,
      expectedCandidateId: CANDIDATE,
      taskId: 'smoke',
    })
    const rec2 = await normalizeTrial({
      trialDir: dir,
      expectedCandidateId: CANDIDATE,
      taskId: 'smoke',
    })
    expect(rec1.recordHash).toBe(rec2.recordHash)
    expect(rec1.recordHash).toMatch(/^[0-9a-f]{64}$/)
  })
})
