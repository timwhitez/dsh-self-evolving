import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isBernoulliValid, normalizeTrial } from '../src/index.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-normalizer-reward-syntax-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function normalizeReward(rewardText: string) {
  const trialDir = join(root!, 'trial')
  const artifactDir = join(root!, 'artifact')
  await mkdir(join(trialDir, 'agent'), { recursive: true })
  await mkdir(artifactDir, { recursive: true })
  await writeFile(
    join(trialDir, 'result.json'),
    JSON.stringify({ task_id: 'task-a', reward: 1 }) + '\n',
  )
  await writeFile(join(trialDir, 'reward.txt'), rewardText)
  await writeFile(join(trialDir, 'agent', 'trajectory.json'), '{}\n')
  await writeFile(
    join(artifactDir, 'candidate-attribution.json'),
    JSON.stringify({ candidate_id: 'candidate-a', task_id: 'task-a', attempt_index: 0 }) + '\n',
  )
  return normalizeTrial({
    trialDir,
    candidateArtifactDir: artifactDir,
    expectedCandidateId: 'candidate-a',
    expectedTaskId: 'task-a',
    attemptIndex: 0,
  })
}

describe('strict binary reward syntax', () => {
  for (const [label, text] of [
    ['empty', ''],
    ['whitespace-only', ' \n\t'],
    ['hexadecimal', '0x1\n'],
    ['exponential', '1e0\n'],
    ['signed', '+1\n'],
    ['leading-zero', '01\n'],
    ['decimal', '1.0\n'],
  ] as const) {
    it(`rejects ${label} reward syntax`, async () => {
      const record = await normalizeReward(text)
      expect(record.status).toBe('invalid')
      expect(record.reward).toBeNull()
      expect(record.invalidReason).toBe('missing or invalid reward.txt')
      expect(isBernoulliValid(record)).toBe(false)
    })
  }

  it('accepts canonical zero with surrounding whitespace', async () => {
    const record = await normalizeReward(' 0\n')
    expect(record.status).toBe('fail')
    expect(record.reward).toBe(0)
    expect(isBernoulliValid(record)).toBe(true)
  })

  it('accepts canonical one with a trailing newline', async () => {
    const record = await normalizeReward('1\n')
    expect(record.status).toBe('pass')
    expect(record.reward).toBe(1)
    expect(isBernoulliValid(record)).toBe(true)
  })
})
