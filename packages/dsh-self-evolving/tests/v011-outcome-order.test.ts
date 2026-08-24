import { describe, expect, it } from 'vitest'

import { deriveMechanismOutcome, type OutcomeTrial } from '../src/index.js'

function digest(fill: string): `sha256:${string}` {
  return `sha256:${fill.repeat(64)}`
}

const baseInput = {
  proposalDigest: digest('1'),
  hypothesis: 'paired trials must be deterministic',
  candidateDigest: digest('2'),
  targetClusterSlug: 'cluster-a',
  targetTaskHandle: 'task-a',
}

function trial(
  fill: string,
  role: OutcomeTrial['role'],
  status: OutcomeTrial['status'],
  taskId = 'task-a',
  attemptIndex = 0,
): OutcomeTrial {
  return {
    ref: digest(fill),
    role,
    status,
    reward: status === 'pass' ? 1 : status === 'fail' ? 0 : null,
    taskId,
    attemptIndex,
  }
}

describe('mechanism outcome trial pairing', () => {
  it('is byte-identical under permutation of complete semantic pairs', async () => {
    const trials = [
      trial('3', 'target-baseline', 'fail', 'task-a', 0),
      trial('4', 'target-child', 'pass', 'task-a', 0),
      trial('5', 'target-baseline', 'fail', 'task-a', 1),
      trial('6', 'target-child', 'pass', 'task-a', 1),
      trial('7', 'preservation-baseline', 'pass', 'guard-a', 0),
      trial('8', 'preservation-child', 'pass', 'guard-a', 0),
    ]
    const forward = await deriveMechanismOutcome({ ...baseInput, trials })
    const reverse = await deriveMechanismOutcome({ ...baseInput, trials: [...trials].reverse() })
    expect(forward).toEqual(reverse)
    expect(forward.status).toBe('TARGET_IMPROVED')
    expect(forward.singleTrialObservable).toBe(false)
  })

  it('accepts one exact target task/attempt pair', async () => {
    const record = await deriveMechanismOutcome({
      ...baseInput,
      trials: [trial('3', 'target-baseline', 'fail'), trial('4', 'target-child', 'pass')],
    })
    expect(record.status).toBe('TARGET_IMPROVED')
    expect(record.singleTrialObservable).toBe(true)
  })

  it.each([
    ['missing child', [trial('3', 'target-baseline', 'fail')]],
    [
      'duplicate baseline',
      [
        trial('3', 'target-baseline', 'fail'),
        trial('4', 'target-baseline', 'fail'),
        trial('5', 'target-child', 'pass'),
      ],
    ],
    [
      'duplicate semantic pair',
      [
        trial('3', 'target-baseline', 'fail'),
        trial('4', 'target-child', 'pass'),
        trial('5', 'target-baseline', 'fail', 'task-a', 0),
        trial('6', 'target-child', 'pass', 'task-a', 0),
      ],
    ],
    [
      'duplicate evidence ref',
      [trial('3', 'target-baseline', 'fail'), trial('3', 'target-child', 'pass')],
    ],
  ] as const)('classifies %s as invalid trials', async (_name, trials) => {
    const record = await deriveMechanismOutcome({ ...baseInput, trials: [...trials] })
    expect(record.status).toBe('INVALID_TRIALS')
    expect(record.singleTrialObservable).toBe(false)
  })

  it('keeps invalid evidence fail-closed instead of treating it as a failed baseline', async () => {
    const record = await deriveMechanismOutcome({
      ...baseInput,
      trials: [trial('3', 'target-baseline', 'invalid'), trial('4', 'target-child', 'pass')],
    })
    expect(record.status).toBe('INVALID_TRIALS')
    expect(record.singleTrialObservable).toBe(false)
  })

  it('rejects target rows for a different task handle', async () => {
    const record = await deriveMechanismOutcome({
      ...baseInput,
      trials: [
        trial('3', 'target-baseline', 'fail', 'other-task'),
        trial('4', 'target-child', 'pass', 'other-task'),
      ],
    })
    expect(record.status).toBe('INVALID_TRIALS')
  })

  it('derives preservation regression only from matched pairs', async () => {
    const record = await deriveMechanismOutcome({
      ...baseInput,
      trials: [
        trial('3', 'target-baseline', 'fail'),
        trial('4', 'target-child', 'pass'),
        trial('5', 'preservation-baseline', 'pass', 'guard-a'),
        trial('6', 'preservation-child', 'pass', 'guard-a'),
        trial('7', 'preservation-baseline', 'fail', 'guard-b'),
        trial('8', 'preservation-child', 'fail', 'guard-b'),
      ],
    })
    expect(record.status).toBe('TARGET_IMPROVED')
  })

  it('commits semantic pair identity into the idempotency key', async () => {
    const original = [
      trial('3', 'target-baseline', 'fail', 'task-a', 0),
      trial('4', 'target-child', 'pass', 'task-a', 0),
      trial('5', 'target-baseline', 'pass', 'task-a', 1),
      trial('6', 'target-child', 'pass', 'task-a', 1),
    ]
    const rePaired = original.map((entry) => ({
      ...entry,
      attemptIndex:
        entry.ref === digest('4') ? 1 : entry.ref === digest('6') ? 0 : entry.attemptIndex,
    }))
    const first = await deriveMechanismOutcome({ ...baseInput, trials: original })
    const second = await deriveMechanismOutcome({ ...baseInput, trials: rePaired })
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey)
  })

  it('keeps duplicate evidence deterministic and schema-valid', async () => {
    const trials = [
      trial('3', 'target-baseline', 'fail'),
      trial('3', 'target-child', 'pass'),
    ]
    const first = await deriveMechanismOutcome({ ...baseInput, trials })
    const second = await deriveMechanismOutcome({ ...baseInput, trials: [...trials].reverse() })
    expect(first).toEqual(second)
    expect(first.status).toBe('INVALID_TRIALS')
    expect(first.trialRefs).toEqual([digest('3')])
  })

  it('binds all output-distinguishing metadata into the idempotency key', async () => {
    const trials = [trial('3', 'target-baseline', 'fail'), trial('4', 'target-child', 'pass')]
    const original = await deriveMechanismOutcome({ ...baseInput, trials })
    const changedHypothesis = await deriveMechanismOutcome({
      ...baseInput,
      hypothesis: 'different hypothesis',
      trials,
    })
    const changedCluster = await deriveMechanismOutcome({
      ...baseInput,
      targetClusterSlug: 'cluster-b',
      trials,
    })
    expect(changedHypothesis.idempotencyKey).not.toBe(original.idempotencyKey)
    expect(changedCluster.idempotencyKey).not.toBe(original.idempotencyKey)
  })
})
