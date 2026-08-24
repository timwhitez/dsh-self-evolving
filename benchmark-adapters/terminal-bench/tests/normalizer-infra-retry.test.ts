import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeTrial, type InfraClass } from '../src/index.js'

const roots: string[] = []
const CANDIDATE = 'c_infra_retry'

async function makeTrial(
  exceptionInfo: { type?: string; classification?: string },
  reward: number | null,
  includeTrajectory = false,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-infra-normalizer-'))
  roots.push(dir)
  await writeFile(
    join(dir, 'result.json'),
    JSON.stringify({
      verifier_result: reward === null ? { rewards: {} } : { rewards: { reward } },
      exception_info: exceptionInfo,
    }),
  )
  await writeFile(
    join(dir, 'attribution.json'),
    JSON.stringify({ candidate_id: CANDIDATE, task_id: 'infra-task', attempt_index: 0 }),
  )
  if (includeTrajectory) {
    await mkdir(join(dir, 'agent'), { recursive: true })
    await writeFile(join(dir, 'agent', 'trajectory.json'), JSON.stringify({ steps: [] }))
  }
  return dir
}

async function normalize(
  dir: string,
  expectedCandidateId = CANDIDATE,
  expectedAttemptIndex = 0,
  taskId = 'infra-task',
) {
  return normalizeTrial({
    trialDir: dir,
    expectedCandidateId,
    expectedAttemptIndex,
    taskId,
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('infrastructure retry classification', () => {
  const registeredCases: Array<{
    exceptionInfo: { type?: string; classification?: string }
    expected: Exclude<InfraClass, null>
  }> = [
    { exceptionInfo: { type: 'DockerBuildError' }, expected: 'docker-build-error' },
    {
      exceptionInfo: { classification: 'NETWORK_PULL_ERROR' },
      expected: 'network-pull-error',
    },
    { exceptionInfo: { classification: 'oom-crash' }, expected: 'oom-crash' },
  ]

  it.each(registeredCases)(
    'keeps $expected retry-eligible without reward or agent evidence',
    async ({ exceptionInfo, expected }) => {
      const record = await normalize(await makeTrial(exceptionInfo, null))

      expect(record.status).toBe('invalid')
      expect(record.reason).toMatch(/reward missing/)
      expect(record.infraClass).toBe(expected)
      expect(record.retryEligible).toBe(true)
    },
  )

  it('allows an OOM retry with valid partial agent evidence', async () => {
    const record = await normalize(await makeTrial({ classification: 'oom-crash' }, null, true))

    expect(record.status).toBe('invalid')
    expect(record.reason).toMatch(/reward missing/)
    expect(record.infraClass).toBe('oom-crash')
    expect(record.retryEligible).toBe(true)
  })

  it('rejects a pre-agent class after agent evidence exists', async () => {
    const record = await normalize(
      await makeTrial({ classification: 'docker-build-error' }, null, true),
    )

    expect(record.status).toBe('invalid')
    expect(record.infraClass).toBeNull()
    expect(record.retryEligible).toBe(false)
  })

  it.each([0, 1])('rejects stale exception metadata with reward %s', async (reward) => {
    const record = await normalize(
      await makeTrial({ classification: 'network-pull-error' }, reward, true),
    )

    expect(record.status).toBe(reward === 1 ? 'pass' : 'fail')
    expect(record.infraClass).toBeNull()
    expect(record.retryEligible).toBe(false)
  })

  it('rejects similar but unregistered exception names', async () => {
    const record = await normalize(await makeTrial({ classification: 'network-timeout' }, null))

    expect(record.status).toBe('invalid')
    expect(record.infraClass).toBeNull()
    expect(record.retryEligible).toBe(false)
  })

  it('rejects a candidate attribution mismatch', async () => {
    const record = await normalize(
      await makeTrial({ classification: 'docker-build-error' }, null),
      'c_other',
    )

    expect(record.reason).toMatch(/candidate_id mismatch/)
    expect(record.retryEligible).toBe(false)
  })

  it('rejects an attempt attribution mismatch', async () => {
    const record = await normalize(
      await makeTrial({ classification: 'docker-build-error' }, null),
      CANDIDATE,
      1,
    )

    expect(record.reason).toMatch(/attempt_index mismatch/)
    expect(record.retryEligible).toBe(false)
  })

  it('rejects a task attribution mismatch', async () => {
    const record = await normalize(
      await makeTrial({ classification: 'docker-build-error' }, null),
      CANDIDATE,
      0,
      'other-task',
    )

    expect(record.reason).toMatch(/task_id mismatch/)
    expect(record.retryEligible).toBe(false)
  })

  it('rejects missing attribution', async () => {
    const dir = await makeTrial({ classification: 'docker-build-error' }, null)
    await rm(join(dir, 'attribution.json'))

    const record = await normalize(dir)

    expect(record.reason).toBe('attribution.json missing')
    expect(record.retryEligible).toBe(false)
  })

  it('rejects malformed attribution', async () => {
    const dir = await makeTrial({ classification: 'docker-build-error' }, null)
    await writeFile(join(dir, 'attribution.json'), '{not-json')

    const record = await normalize(dir)

    expect(record.reason).toMatch(/invalid or extended schema/)
    expect(record.retryEligible).toBe(false)
  })

  it('rejects extended attribution schemas', async () => {
    const dir = await makeTrial({ classification: 'docker-build-error' }, null)
    await writeFile(
      join(dir, 'attribution.json'),
      JSON.stringify({
        candidate_id: CANDIDATE,
        task_id: 'infra-task',
        attempt_index: 0,
        extra: true,
      }),
    )

    const record = await normalize(dir)

    expect(record.reason).toMatch(/invalid or extended schema/)
    expect(record.retryEligible).toBe(false)
  })

  it('rejects conflicting registered exception fields', async () => {
    const dir = await makeTrial({ classification: 'oom-crash', type: 'DockerBuildError' }, null)
    const record = await normalize(dir)

    expect(record.reason).toMatch(/conflicting registered infrastructure classes/)
    expect(record.infraClass).toBeNull()
    expect(record.retryEligible).toBe(false)
  })

  it('treats classification as authoritative when it is present', async () => {
    const dir = await makeTrial({ classification: 'unknown-class', type: 'DockerBuildError' }, null)
    const record = await normalize(dir)

    expect(record.infraClass).toBeNull()
    expect(record.retryEligible).toBe(false)
  })

  it('rejects malformed ACP JSONL evidence', async () => {
    const dir = await makeTrial({ classification: 'oom-crash' }, null)
    await mkdir(join(dir, 'agent'))
    await writeFile(join(dir, 'agent', 'acp-events.jsonl'), '{not-json\n')

    const record = await normalize(dir)

    expect(record.reason).toMatch(/ACP events are not valid object JSONL/)
    expect(record.retryEligible).toBe(false)
  })

  it('rejects ambiguous trajectory aliases', async () => {
    const dir = await makeTrial({ classification: 'oom-crash' }, null, true)
    await writeFile(join(dir, 'trajectory.json'), JSON.stringify({ steps: [] }))

    const record = await normalize(dir)

    expect(record.reason).toMatch(/trajectory is ambiguous/)
    expect(record.retryEligible).toBe(false)
  })

  it('does not accept a hard-linked result artifact', async () => {
    const dir = await makeTrial({ classification: 'docker-build-error' }, null)
    await writeFile(join(dir, 'linked-result.json'), '{}')
    await rm(join(dir, 'result.json'))
    await link(join(dir, 'linked-result.json'), join(dir, 'result.json'))

    const record = await normalize(dir)

    expect(record.reason).toMatch(/result.json is not one stable regular file/)
    expect(record.retryEligible).toBe(false)
  })

  it('does not follow a symlinked result artifact', async () => {
    const dir = await makeTrial({ classification: 'docker-build-error' }, null)
    await writeFile(join(dir, 'linked-result.json'), '{}')
    await rm(join(dir, 'result.json'))
    await symlink('linked-result.json', join(dir, 'result.json'))

    const record = await normalize(dir)

    expect(record.reason).toMatch(/result.json is not readable/)
    expect(record.retryEligible).toBe(false)
  })

  it('does not follow a symlinked agent directory', async () => {
    const dir = await makeTrial({ classification: 'docker-build-error' }, null)
    await mkdir(join(dir, 'real-agent'))
    await symlink('real-agent', join(dir, 'agent'))

    const record = await normalize(dir)

    expect(record.reason).toMatch(/agent evidence directory is not a real directory/)
    expect(record.retryEligible).toBe(false)
  })

  it('rejects a symlinked trial directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-infra-link-'))
    roots.push(root)
    const real = join(root, 'real')
    const linked = join(root, 'linked')
    await mkdir(real)
    await symlink('real', linked)

    await expect(normalize(linked)).rejects.toThrow(/trial directory missing or not a directory/)
  })
})
