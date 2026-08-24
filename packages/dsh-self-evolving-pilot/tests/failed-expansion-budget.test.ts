import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '@dsh-self-evolving/search'
import {
  initialPilotState,
  NO_ADMISSIBLE_CHILD,
  runPilotLoop,
  type PilotCapabilities,
  type PilotConfig,
} from '../src/index.js'

function config(): PilotConfig {
  return {
    protocolVersion: 1,
    K: 2,
    B_eval: 100,
    params: DEFAULT_PARAMS,
    devTaskIds: ['task-a'],
    masterSeed: 42n,
    maxConsecutiveExpansionFailures: 2,
  }
}

function evaluationResult() {
  return { reward: 1 as const, costUsd: 0.01, wallSec: 1 }
}

async function expectBoundedFailure(caps: PilotCapabilities, counters: { propose: number }) {
  const result = await runPilotLoop(
    'baseline',
    'baseline source',
    'sha256:baseline',
    config(),
    caps,
  )

  expect(result.terminal).toBe(true)
  expect(result.reason).toBe(NO_ADMISSIBLE_CHILD)
  expect(result.reason).not.toMatch(/ITERATION_CAP/)
  expect(result.expansionAttempts).toBe(2)
  expect(result.consecutiveExpansionFailures).toBe(2)
  expect(result.pendingExpansion).toBeNull()
  expect(counters.propose).toBe(2)
  return result
}

describe('failed expansion budget', () => {
  it('terminates explicitly when the proposer repeatedly returns no children', async () => {
    const counters = { propose: 0 }
    const caps: PilotCapabilities = {
      async propose() {
        counters.propose += 1
        return []
      },
      async build() {
        throw new Error('build should not be called for an empty proposal batch')
      },
      async evaluate() {
        return evaluationResult()
      },
    }

    await expectBoundedFailure(caps, counters)
  })

  it('terminates explicitly when every proposed child is rejected by the builder', async () => {
    const counters = { propose: 0 }
    const caps: PilotCapabilities = {
      async propose(parentDigest) {
        counters.propose += 1
        return [
          {
            proposalId: `rejected-${counters.propose}`,
            canonicalParentDigest: parentDigest,
            hypothesis: 'exercise the bounded all-build-rejected outcome',
            sourceDiff: '+export const rejected = true',
            donorCandidates: [],
          },
        ]
      },
      async build() {
        return null
      },
      async evaluate() {
        return evaluationResult()
      },
    }

    await expectBoundedFailure(caps, counters)
  })

  it('terminates explicitly when every built child is a duplicate', async () => {
    const counters = { propose: 0 }
    const caps: PilotCapabilities = {
      async propose(parentDigest) {
        counters.propose += 1
        return [
          {
            proposalId: `duplicate-${counters.propose}`,
            canonicalParentDigest: parentDigest,
            hypothesis: 'exercise the bounded all-duplicate outcome',
            sourceDiff: '+export const duplicate = true',
            donorCandidates: [],
          },
        ]
      },
      async build() {
        return {
          candidateId: 'duplicate',
          digest: 'sha256:baseline',
          source: 'duplicate source',
        }
      },
      async evaluate() {
        return evaluationResult()
      },
    }

    await expectBoundedFailure(caps, counters)
  })

  it('rejects a non-positive expansion failure bound before external work', async () => {
    let calls = 0
    const caps: PilotCapabilities = {
      async propose() {
        calls += 1
        return []
      },
      async build() {
        calls += 1
        return null
      },
      async evaluate() {
        calls += 1
        return evaluationResult()
      },
    }

    await expect(
      runPilotLoop(
        'baseline',
        'baseline source',
        'sha256:baseline',
        { ...config(), maxConsecutiveExpansionFailures: 0 },
        caps,
      ),
    ).rejects.toThrow(/positive safe integer/)
    expect(calls).toBe(0)
  })

  it('binds the frozen failure bound into resumable protocol state', async () => {
    const original = config()
    const state = initialPilotState('baseline', original, 'sha256:baseline', 'baseline source')
    let calls = 0
    const caps: PilotCapabilities = {
      async propose() {
        calls += 1
        return []
      },
      async build() {
        calls += 1
        return null
      },
      async evaluate() {
        calls += 1
        return evaluationResult()
      },
    }

    await expect(
      runPilotLoop(
        'baseline',
        'baseline source',
        'sha256:baseline',
        { ...original, maxConsecutiveExpansionFailures: 3 },
        caps,
        state,
      ),
    ).rejects.toThrow(/state does not match the frozen expansion failure policy/)
    expect(calls).toBe(0)
  })

  it('rejects an unversioned legacy state instead of silently resetting counters', async () => {
    const cfg = config()
    const current = initialPilotState('baseline', cfg, 'sha256:baseline', 'baseline source')
    const {
      protocolVersion: _protocolVersion,
      maxConsecutiveExpansionFailures: _frozenBound,
      ...legacy
    } = current
    let calls = 0
    const caps: PilotCapabilities = {
      async propose() {
        calls += 1
        return []
      },
      async build() {
        calls += 1
        return null
      },
      async evaluate() {
        calls += 1
        return evaluationResult()
      },
    }

    await expect(
      runPilotLoop(
        'baseline',
        'baseline source',
        'sha256:baseline',
        cfg,
        caps,
        legacy as unknown as Parameters<typeof runPilotLoop>[5],
      ),
    ).rejects.toThrow(/state does not match the frozen expansion failure policy/)
    expect(calls).toBe(0)
  })

  it('recovers the crash window after the terminal failure counter was committed', async () => {
    const cfg = config()
    const state = initialPilotState('baseline', cfg, 'sha256:baseline', 'baseline source')
    state.expansionAttempts = 2
    state.consecutiveExpansionFailures = 2
    let calls = 0
    const caps: PilotCapabilities = {
      async propose() {
        calls += 1
        return []
      },
      async build() {
        calls += 1
        return null
      },
      async evaluate() {
        calls += 1
        return evaluationResult()
      },
    }

    const recovered = await runPilotLoop(
      'baseline',
      'baseline source',
      'sha256:baseline',
      cfg,
      caps,
      state,
    )

    expect(recovered.reason).toBe(NO_ADMISSIBLE_CHILD)
    expect(calls).toBe(0)
  })

  it('matches uninterrupted state after resuming an interrupted expansion intent', async () => {
    const cfg = config()
    const emptyCounters = { propose: 0 }
    const emptyCaps: PilotCapabilities = {
      async propose() {
        emptyCounters.propose += 1
        return []
      },
      async build() {
        throw new Error('build should not be called')
      },
      async evaluate() {
        return evaluationResult()
      },
    }
    const uninterrupted = await expectBoundedFailure(emptyCaps, emptyCounters)

    const interrupted = initialPilotState('baseline', cfg, 'sha256:baseline', 'baseline source')
    let interruptedProposals = 0
    const crashCaps: PilotCapabilities = {
      async propose() {
        interruptedProposals += 1
        throw new Error('simulated process interruption')
      },
      async build() {
        throw new Error('build should not be called')
      },
      async evaluate() {
        return evaluationResult()
      },
    }
    await expect(
      runPilotLoop('baseline', 'baseline source', 'sha256:baseline', cfg, crashCaps, interrupted),
    ).rejects.toThrow(/simulated process interruption/)
    expect(interruptedProposals).toBe(1)
    expect(interrupted.expansionAttempts).toBe(1)
    expect(interrupted.consecutiveExpansionFailures).toBe(0)
    expect(interrupted.pendingExpansion).toMatchObject({
      attempt: 1,
      parentId: 'baseline',
      admittedCountBefore: 1,
    })

    const resumeCounters = { propose: 0 }
    const resumed = await runPilotLoop(
      'baseline',
      'baseline source',
      'sha256:baseline',
      cfg,
      {
        ...emptyCaps,
        async propose() {
          resumeCounters.propose += 1
          return []
        },
      },
      interrupted,
    )

    expect(resumeCounters.propose).toBe(1)
    expect(resumed).toEqual(uninterrupted)
  })

  it('resets the consecutive failure counter after an admitted child', async () => {
    const cfg = config()
    let proposals = 0
    const result = await runPilotLoop('baseline', 'baseline source', 'sha256:baseline', cfg, {
      async propose(parentDigest) {
        proposals += 1
        if (proposals === 1) return []
        return [
          {
            proposalId: 'accepted',
            canonicalParentDigest: parentDigest,
            hypothesis: 'recover after one failed expansion',
            sourceDiff: '+export const accepted = true',
            donorCandidates: [],
          },
        ]
      },
      async build() {
        return {
          candidateId: 'accepted',
          digest: 'sha256:accepted',
          source: 'accepted source',
        }
      },
      async evaluate() {
        return evaluationResult()
      },
    })

    expect(result.reason).toMatch(/^SEARCH_COMPLETE/)
    expect(result.expansionAttempts).toBe(2)
    expect(result.consecutiveExpansionFailures).toBe(0)
    expect(result.pendingExpansion).toBeNull()
  })
})
