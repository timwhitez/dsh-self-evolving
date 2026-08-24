import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '@dsh-self-evolving/search'
import {
  initialPilotState,
  runPilotLoop,
  type PilotCapabilities,
  type PilotConfig,
} from '../src/index.js'

const config: PilotConfig = {
  protocolVersion: 1,
  K: 3,
  B_eval: 1,
  params: DEFAULT_PARAMS,
  devTaskIds: ['task-a'],
  masterSeed: 42n,
  maxConsecutiveExpansionFailures: 3,
}

describe('pilot evaluation scheduling', () => {
  it('uses node Thompson sampling after every candidate completes cold start', async () => {
    const state = initialPilotState('baseline', config)
    state.archive.nodes = [
      {
        candidateId: 'baseline',
        digest: 'sha256:baseline',
        source: 'baseline source',
        canonicalParent: null,
        donorCandidates: [],
        s: 0,
        f: 1_000,
      },
      {
        candidateId: 'strong-child',
        digest: 'sha256:strong-child',
        source: 'strong child source',
        canonicalParent: 'baseline',
        donorCandidates: [],
        s: 1_000,
        f: 0,
      },
    ]
    state.admittedCount = 2

    const evaluated: string[] = []
    const caps: PilotCapabilities = {
      async propose() {
        throw new Error('proposal should not be called')
      },
      async build() {
        throw new Error('build should not be called')
      },
      async evaluate(candidateId) {
        evaluated.push(candidateId)
        return { reward: 1, costUsd: 0.01, wallSec: 1 }
      },
    }

    const result = await runPilotLoop(
      'baseline',
      'baseline source',
      'sha256:baseline',
      config,
      caps,
      state,
    )

    expect(evaluated).toEqual(['strong-child'])
    expect(result.archive.nodes[0]?.s).toBe(0)
    expect(result.archive.nodes[1]?.s).toBe(1_001)
  })

  it('still prioritizes a node that has not completed q0', async () => {
    const state = initialPilotState('baseline', config)
    state.archive.nodes = [
      {
        candidateId: 'cold-child',
        digest: 'sha256:cold-child',
        source: 'cold child source',
        canonicalParent: 'baseline',
        donorCandidates: [],
        s: 0,
        f: 0,
      },
      {
        candidateId: 'warm-child',
        digest: 'sha256:warm-child',
        source: 'warm child source',
        canonicalParent: 'baseline',
        donorCandidates: [],
        s: 1_000,
        f: 0,
      },
    ]
    state.admittedCount = 2

    const evaluated: string[] = []
    const caps: PilotCapabilities = {
      async propose() {
        throw new Error('proposal should not be called')
      },
      async build() {
        throw new Error('build should not be called')
      },
      async evaluate(candidateId) {
        evaluated.push(candidateId)
        return { reward: 1, costUsd: 0.01, wallSec: 1 }
      },
    }

    await runPilotLoop('baseline', 'baseline source', 'sha256:baseline', config, caps, state)

    expect(evaluated).toEqual(['cold-child'])
  })

  it('excludes a stronger node after it exhausts the frozen task inventory', async () => {
    const state = initialPilotState('baseline', config, 'sha256:baseline', 'baseline source')
    state.archive.nodes = [
      {
        candidateId: 'exhausted-strong',
        digest: 'sha256:exhausted-strong',
        source: 'exhausted source',
        canonicalParent: null,
        donorCandidates: [],
        s: 1_000,
        f: 0,
      },
      {
        candidateId: 'eligible-weak',
        digest: 'sha256:eligible-weak',
        source: 'eligible source',
        canonicalParent: null,
        donorCandidates: [],
        s: 0,
        f: 1_000,
      },
    ]
    state.archive.observations = [
      {
        candidateId: 'exhausted-strong',
        taskId: 'task-a',
        attempt: 0,
        reward: 1,
        costUsd: 0.01,
        wallSec: 1,
      },
    ]
    state.admittedCount = 2

    const evaluated: string[] = []
    const caps: PilotCapabilities = {
      async propose() {
        throw new Error('proposal should not be called')
      },
      async build() {
        throw new Error('build should not be called')
      },
      async evaluate(candidateId) {
        evaluated.push(candidateId)
        return { reward: 0, costUsd: 0.01, wallSec: 1 }
      },
    }

    await runPilotLoop('baseline', 'baseline source', 'sha256:baseline', config, caps, state)

    expect(evaluated).toEqual(['eligible-weak'])
  })

  it('stops instead of reusing a task when no node remains eligible', async () => {
    const state = initialPilotState('baseline', config, 'sha256:baseline', 'baseline source')
    state.archive.nodes[0]!.s = 1
    state.archive.observations = [
      {
        candidateId: 'baseline',
        taskId: 'task-a',
        attempt: 0,
        reward: 1,
        costUsd: 0.01,
        wallSec: 1,
      },
    ]
    const caps: PilotCapabilities = {
      async propose() {
        throw new Error('proposal should not be called')
      },
      async build() {
        throw new Error('build should not be called')
      },
      async evaluate() {
        throw new Error('evaluation should not be called')
      },
    }

    const result = await runPilotLoop(
      'baseline',
      'baseline source',
      'sha256:baseline',
      config,
      caps,
      state,
    )

    expect(result.reason).toBe('NO_ELIGIBLE_EVALUATION_NODE')
    expect(result.B_evalRemaining).toBe(1)
  })

  it('produces the same fixed-seed trace across an interrupted resume without task reuse', async () => {
    const traceConfig: PilotConfig = {
      ...config,
      B_eval: 4,
      devTaskIds: ['task-a', 'task-b', 'task-c', 'task-d'],
      masterSeed: 19n,
    }
    const createState = () => {
      const state = initialPilotState('baseline', traceConfig, 'sha256:baseline', 'baseline source')
      state.archive.nodes.push({
        candidateId: 'child',
        digest: 'sha256:child',
        source: 'child source',
        canonicalParent: 'baseline',
        donorCandidates: [],
        s: 1,
        f: 0,
      })
      state.archive.nodes[0]!.s = 1
      state.admittedCount = 2
      return state
    }
    const run = async (state: ReturnType<typeof createState>, budget: number) => {
      const trace: string[] = []
      const caps: PilotCapabilities = {
        async propose() {
          throw new Error('proposal should not be called')
        },
        async build() {
          throw new Error('build should not be called')
        },
        async evaluate(candidateId, taskId) {
          trace.push(`${candidateId}:${taskId}`)
          return { reward: 0, costUsd: 0.01, wallSec: 1 }
        },
      }
      state.B_evalRemaining = budget
      state.terminal = false
      state.reason = null
      await runPilotLoop('baseline', 'baseline source', 'sha256:baseline', traceConfig, caps, state)
      return trace
    }

    const uninterrupted = await run(createState(), 4)
    const resumedState = createState()
    const resumed = [...(await run(resumedState, 2)), ...(await run(resumedState, 2))]

    expect(uninterrupted).toEqual([
      'child:task-a',
      'child:task-b',
      'baseline:task-a',
      'child:task-c',
    ])
    expect(resumed).toEqual(uninterrupted)
    expect(new Set(uninterrupted)).toHaveLength(uninterrupted.length)
  })
})
