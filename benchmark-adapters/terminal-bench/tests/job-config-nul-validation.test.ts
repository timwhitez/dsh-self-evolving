import { describe, expect, it } from 'vitest'
import { buildJobConfig, type JobConfigInput } from '../src/index.js'

function input(agentEnv: Record<string, string>): JobConfigInput {
  return {
    jobName: 'nul-validation',
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
    verifier: { timeoutSec: 60, agentTimeoutSec: 60 },
    idempotencyKey: 'job-key',
    jobsDir: '/jobs',
    agentEnv,
  }
}

describe('Harbor JobConfig NUL validation', () => {
  it('rejects an actual NUL byte in an agent environment value', () => {
    expect(() => buildJobConfig(input({ EXAMPLE: 'left\0right' }))).toThrow(
      /agent env EXAMPLE contains NUL/,
    )
  })

  it('allows the harmless literal backslash-u text', () => {
    const literal = String.raw`left\u0000right`
    const result = buildJobConfig(input({ EXAMPLE: literal }))

    expect(result.agents[0]?.env?.EXAMPLE).toBe(literal)
  })
})
