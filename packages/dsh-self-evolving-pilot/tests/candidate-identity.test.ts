import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '@dsh-self-evolving/search'
import { runPilotLoop, type PilotCapabilities, type PilotConfig } from '../src/index.js'

const config: PilotConfig = {
  K: 3,
  B_eval: 100,
  params: DEFAULT_PARAMS,
  devTaskIds: ['task-a', 'task-b', 'task-c'],
  masterSeed: 42n,
}

describe('pilot candidate identity', () => {
  it('evaluates admitted candidate IDs while deduplicating and proposing by digest', async () => {
    let buildCount = 0
    const evaluatedIds: string[] = []
    const proposedParentDigests: string[] = []
    const caps: PilotCapabilities = {
      async propose(parentDigest) {
        proposedParentDigests.push(parentDigest)
        return [
          {
            proposalId: `proposal-${buildCount + 1}`,
            canonicalParentDigest: parentDigest,
            hypothesis: 'keep admitted identity separate from canonical content identity',
            sourceDiff: '+export const changed = true',
            donorCandidates: [],
          },
        ]
      },
      async build() {
        buildCount += 1
        return {
          candidateId: `candidate-${buildCount}`,
          digest: `sha256:content-${buildCount}`,
        }
      },
      async evaluate(candidateId) {
        evaluatedIds.push(candidateId)
        return { reward: 1, costUsd: 0.01, wallSec: 1 }
      },
    }

    const state = await runPilotLoop(
      'baseline-id',
      'baseline source',
      'sha256:baseline-content',
      config,
      caps,
    )

    expect(state.archive.nodes).toContainEqual(
      expect.objectContaining({
        candidateId: 'candidate-1',
        digest: 'sha256:content-1',
      }),
    )
    expect(evaluatedIds).toContain('candidate-1')
    expect(evaluatedIds).not.toContain('sha256:content-1')
    expect(proposedParentDigests).toContain('sha256:baseline-content')
    expect(proposedParentDigests.every((value) => value.startsWith('sha256:'))).toBe(true)
  })
})
