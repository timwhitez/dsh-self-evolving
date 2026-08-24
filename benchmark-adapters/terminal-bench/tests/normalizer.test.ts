/**
 * Normalizer fixture tests (spec 07 §4 Accept: nop/broken/golden → fail/fail/valid).
 *
 * Uses Harbor's ACTUAL trial result.json structure:
 *   verifier_result.rewards.reward  — numeric reward
 *   exception_info                  — Harbor exception classification
 * plus a controller-written attribution.json sidecar (candidate_id + task_id + attempt_index).
 * Trajectory = trajectory.json (or acp-events.jsonl fallback).
 *
 * The normalizer must classify golden→pass, nop→fail, broken→invalid, and
 * INVALID records NEVER drop from the denominator. Re-parse → same record hash.
 */
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeTrial } from '../src/index.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-norm-'))
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
const attribution = (candidateId = CANDIDATE, attemptIndex = 0, taskId = 'smoke') =>
  JSON.stringify({ candidate_id: candidateId, task_id: taskId, attempt_index: attemptIndex })

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
      expectedAttemptIndex: 0,
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
      expectedAttemptIndex: 0,
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
      expectedAttemptIndex: 0,
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
      expectedAttemptIndex: 0,
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
      expectedAttemptIndex: 0,
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
      expectedAttemptIndex: 0,
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
      expectedAttemptIndex: 0,
    })
    expect(rec.status).toBe('pass')
    expect(rec.trajectoryHash).not.toBeNull()
  })

  it('accepts Harbor ACP evidence under agent/ only when trajectory, events, and summary exist', async () => {
    const dir = await makeTrial('harbor-acp-layout', {
      'result.json': harborResult(0.0),
      'attribution.json': attribution(),
      'agent/trajectory.json': JSON.stringify({ schema_version: 'ATIF-v1.5', steps: [] }),
      'agent/acp-events.jsonl': '{"direction":"agent_to_client"}\n',
      'agent/acp-summary.json': JSON.stringify({ agent_info: { name: 'deepseek-harness-acp' } }),
    })
    const rec = await normalizeTrial({
      trialDir: dir,
      expectedCandidateId: CANDIDATE,
      taskId: 'smoke',
      expectedAttemptIndex: 0,
      requireAcpEvidence: true,
    })
    expect(rec.status).toBe('fail')
    expect(rec.trajectoryHash).not.toBeNull()
    expect(rec.acpEventsHash).not.toBeNull()
    expect(rec.acpSummaryHash).not.toBeNull()
  })

  it('does not retry a completed fail carrying stale infrastructure metadata', async () => {
    const dir = await makeTrial('infra-oom', {
      'result.json': harborResult(0.0, { type: 'EnvironmentError', classification: 'oom-crash' }),
      'attribution.json': attribution(),
      'trajectory.json': JSON.stringify({ steps: [] }),
    })
    const rec = await normalizeTrial({
      trialDir: dir,
      expectedCandidateId: CANDIDATE,
      taskId: 'smoke',
      expectedAttemptIndex: 0,
    })
    expect(rec.status).toBe('fail')
    expect(rec.retryEligible).toBe(false)
    expect(rec.infraClass).toBeNull()
  })
})

describe('normalizer — attribution and reward integrity', () => {
  it.each([
    ['missing', JSON.stringify({ candidate_id: CANDIDATE, task_id: 'smoke' })],
    ['string', JSON.stringify({ candidate_id: CANDIDATE, task_id: 'smoke', attempt_index: '0' })],
    ['negative', JSON.stringify({ candidate_id: CANDIDATE, task_id: 'smoke', attempt_index: -1 })],
    [
      'fractional',
      JSON.stringify({ candidate_id: CANDIDATE, task_id: 'smoke', attempt_index: 0.5 }),
    ],
    ['non-finite', '{"candidate_id":"c_baseline0001","task_id":"smoke","attempt_index":1e400}'],
  ])('rejects a %s attempt index', async (_name, rawAttribution) => {
    const dir = await makeTrial('invalid-attempt-' + _name, {
      'result.json': harborResult(1),
      'attribution.json': rawAttribution,
      'trajectory.json': JSON.stringify({ steps: [] }),
    })
    const rec = await normalizeTrial({
      trialDir: dir,
      expectedCandidateId: CANDIDATE,
      taskId: 'smoke',
      expectedAttemptIndex: 0,
    })
    expect(rec.status).toBe('invalid')
    expect(rec.reason).toMatch(/attribution\.json has an invalid or extended schema/)
  })

  it.each([
    ['negative', '-1'],
    ['fractional', '0.5'],
    ['greater-than-one', '2'],
    ['exponent overflow', '1e400'],
    ['non-numeric', '"1"'],
  ])('rejects a %s reward', async (_name, rawReward) => {
    const dir = await makeTrial('invalid-reward-' + _name, {
      'result.json':
        '{"verifier_result":{"rewards":{"reward":' + rawReward + '}},"exception_info":null}',
      'attribution.json': attribution(),
      'trajectory.json': JSON.stringify({ steps: [] }),
    })
    const rec = await normalizeTrial({
      trialDir: dir,
      expectedCandidateId: CANDIDATE,
      taskId: 'smoke',
      expectedAttemptIndex: 0,
    })
    expect(rec.status).toBe('invalid')
    expect(rec.reason).toMatch(/expected exactly 0 or 1/)
    expect(rec.retryEligible).toBe(false)
  })
})

describe('normalizer — ACP artifact identity', () => {
  async function normalizeAcp(dir: string) {
    return normalizeTrial({
      trialDir: dir,
      expectedCandidateId: CANDIDATE,
      taskId: 'smoke',
      expectedAttemptIndex: 0,
      requireAcpEvidence: true,
    })
  }

  it('rejects an invalid preferred summary even when a valid fallback exists', async () => {
    const dir = await makeTrial('invalid-preferred-summary', {
      'result.json': harborResult(1),
      'attribution.json': attribution(),
      'agent/acp-events.jsonl': '{}\n',
      'agent/acp-summary.json': '{broken',
      'acp-summary.json': '{}',
    })
    const rec = await normalizeAcp(dir)
    expect(rec.status).toBe('invalid')
    expect(rec.reason).toMatch(/ACP summary is ambiguous/)
  })

  it('rejects two conflicting summary aliases', async () => {
    const dir = await makeTrial('conflicting-summaries', {
      'result.json': harborResult(1),
      'attribution.json': attribution(),
      'agent/acp-events.jsonl': '{}\n',
      'agent/acp-summary.json': '{"source":"agent"}',
      'acp-summary.json': '{"source":"root"}',
    })
    const rec = await normalizeAcp(dir)
    expect(rec.status).toBe('invalid')
    expect(rec.reason).toMatch(/ACP summary is ambiguous/)
  })

  it('does not follow an unreadable preferred summary symlink', async () => {
    const dir = await makeTrial('linked-preferred-summary', {
      'result.json': harborResult(1),
      'attribution.json': attribution(),
      'agent/acp-events.jsonl': '{}\n',
      'acp-summary.json': '{}',
    })
    await symlink('../acp-summary.json', join(dir, 'agent', 'acp-summary.json'))
    const rec = await normalizeAcp(dir)
    expect(rec.status).toBe('invalid')
    expect(rec.reason).toMatch(/ACP summary is not readable/)
  })

  it('rejects missing ACP summaries', async () => {
    const dir = await makeTrial('missing-summary', {
      'result.json': harborResult(1),
      'attribution.json': attribution(),
      'agent/acp-events.jsonl': '{}\n',
    })
    const rec = await normalizeAcp(dir)
    expect(rec.status).toBe('invalid')
    expect(rec.reason).toMatch(/ACP summary missing/)
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
      expectedAttemptIndex: 2,
    })
    const rec2 = await normalizeTrial({
      trialDir: dir,
      expectedCandidateId: CANDIDATE,
      taskId: 'smoke',
      expectedAttemptIndex: 2,
    })
    expect(rec1.recordHash).toBe(rec2.recordHash)
    expect(rec1.recordHash).toMatch(/^[0-9a-f]{64}$/)
  })
})
