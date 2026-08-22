import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isBernoulliValid, normalizeTrial } from '../src/index.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-normalizer-attempt-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function fixture(attribution: Record<string, unknown>) {
  const trialDir = join(root!, 'trial')
  const artifactDir = join(root!, 'artifact')
  await mkdir(join(trialDir, 'agent'), { recursive: true })
  await mkdir(artifactDir, { recursive: true })
  await writeFile(
    join(trialDir, 'result.json'),
    JSON.stringify({ task_id: 'task-a', reward: 1 }) + '\n',
  )
  await writeFile(join(trialDir, 'reward.txt'), '1\n')
  await writeFile(join(trialDir, 'agent', 'trajectory.json'), '{}\n')
  await writeFile(
    join(artifactDir, 'candidate-attribution.json'),
    JSON.stringify({ candidate_id: 'candidate-a', task_id: 'task-a', ...attribution }) + '\n',
  )
  return normalizeTrial({
    trialDir,
    candidateArtifactDir: artifactDir,
    expectedCandidateId: 'candidate-a',
    expectedTaskId: 'task-a',
    attemptIndex: 0,
  })
}

describe('trial attempt attribution validation', () => {
  for (const [label, attribution] of [
    ['missing', {}],
    ['negative', { attempt_index: -1 }],
    ['fractional', { attempt_index: 0.5 }],
    ['string', { attempt_index: '0' }],
    ['null', { attempt_index: null }],
  ] as const) {
    it(`marks a ${label} attempt index invalid`, async () => {
      const record = await fixture(attribution)
      expect(record.status).toBe('invalid')
      expect(record.reward).toBeNull()
      expect(record.attemptIndex).toBeNull()
      expect(record.invalidReason).toMatch(/attempt attribution missing or invalid/)
      expect(isBernoulliValid(record)).toBe(false)
    })
  }

  it('accepts zero as a valid first attempt index', async () => {
    const record = await fixture({ attempt_index: 0 })
    expect(record.status).toBe('pass')
    expect(record.reward).toBe(1)
    expect(record.attemptIndex).toBe(0)
    expect(isBernoulliValid(record)).toBe(true)
  })
})
