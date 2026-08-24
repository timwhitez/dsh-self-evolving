import { describe, expect, it } from 'vitest'
import { buildJobConfig, type JobConfigInput } from '../src/index.js'

function validInput(): JobConfigInput {
  return {
    jobName: 'numeric-validation',
    registryEntry: {
      id: 'candidate-a',
      name: 'Candidate A',
      version: '1.0.0',
      description: 'fixture',
      distribution: {
        binary: {
          'linux-x86_64': {
            archive: 'https://example.invalid/candidate.tar.gz',
            cmd: './candidate',
            checksum: 'a'.repeat(64),
          },
        },
      },
    },
    modelName: 'provider/model',
    tasks: [{ taskId: 'task-a', path: '/tasks/task-a' }],
    nAttempts: 1,
    nConcurrentTrials: 1,
    verifier: { timeoutSec: 1, agentTimeoutSec: 1 },
    idempotencyKey: 'job-key',
    jobsDir: '/jobs',
  }
}

type NumericField =
  'nAttempts' | 'nConcurrentTrials' | 'verifier.timeoutSec' | 'verifier.agentTimeoutSec'

function withNumericField(field: NumericField, value: number): JobConfigInput {
  const input = validInput()
  if (field === 'nAttempts') input.nAttempts = value
  else if (field === 'nConcurrentTrials') input.nConcurrentTrials = value
  else if (field === 'verifier.timeoutSec') input.verifier.timeoutSec = value
  else input.verifier.agentTimeoutSec = value
  return input
}

describe('Harbor JobConfig numeric validation', () => {
  const invalidValues = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]
  const fields: NumericField[] = [
    'nAttempts',
    'nConcurrentTrials',
    'verifier.timeoutSec',
    'verifier.agentTimeoutSec',
  ]

  for (const field of fields) {
    for (const value of invalidValues) {
      it(`rejects ${field}=${String(value)}`, () => {
        expect(() => buildJobConfig(withNumericField(field, value))).toThrow(
          new RegExp(field.replace('.', '\\.')),
        )
      })
    }
  }

  it('accepts the minimum valid boundary and preserves it in the output', () => {
    const result = buildJobConfig(validInput())
    expect(result.n_attempts).toBe(1)
    expect(result.n_concurrent_trials).toBe(1)
    expect(result.metadata['dsh-self-evolving']).toEqual(
      expect.objectContaining({
        agent_timeout_sec: 1,
        verifier_timeout_sec: 1,
      }),
    )
  })
})
