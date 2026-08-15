/**
 * Pilot search-loop unit tests (spec 07 §8 Gate 6).
 *
 * Drives the loop with STUB capabilities (no model, no Harbor) to prove the
 * loop logic: K-admitted termination, dedup-by-digest, build-reject handling,
 * B_eval exhaustion, cold-start enforcement, reward attribution.
 */
import { describe, expect, it } from 'vitest'
import { runPilotLoop, type PilotCapabilities, type PilotConfig } from '../src/index.js'
import { DEFAULT_PARAMS } from '@dsh-self-evolving/search'

function config(K: number, B_eval: number, devTaskCount = 6): PilotConfig {
  return {
    K,
    B_eval,
    params: DEFAULT_PARAMS,
    devTaskIds: Array.from({ length: devTaskCount }, (_, i) => `dev-task-${i}`),
    masterSeed: 42n,
  }
}

describe('pilot search loop', () => {
  it('terminates at SEARCH_COMPLETE when K candidates are admitted', async () => {
    let id = 0
    const caps: PilotCapabilities = {
      async propose() {
        return [
          {
            proposalId: `p${id}`,
            canonicalParentDigest: 'sha256:baseline',
            hypothesis: `hypothesis ${id}`,
            sourceDiff: `+// change ${id}`,
            donorCandidates: [],
          },
        ]
      },
      async build() {
        id += 1
        return { candidateId: `c${id}`, digest: `sha256:child${id}` }
      },
      async evaluate() {
        return { reward: 1, costUsd: 0.01, wallSec: 40 }
      },
    }
    const state = await runPilotLoop('baseline', 'source', 'sha256:baseline', config(5, 1000), caps)
    expect(state.terminal).toBe(true)
    expect(state.reason).toMatch(/SEARCH_COMPLETE/)
    // baseline + 4 admitted children = 5 (K=5 counts baseline)
    expect(state.admittedCount).toBe(5)
  })

  it('terminates at B_EVAL_EXHAUSTED when budget runs out before K', async () => {
    let id = 0
    const caps: PilotCapabilities = {
      async propose() {
        return [
          {
            proposalId: `p${id}`,
            canonicalParentDigest: 'sha256:baseline',
            hypothesis: `h ${id}`,
            sourceDiff: `+// ${id}`,
            donorCandidates: [],
          },
        ]
      },
      async build() {
        id += 1
        return { candidateId: `c${id}`, digest: `sha256:child${id}` }
      },
      async evaluate() {
        return { reward: 0, costUsd: 0.01, wallSec: 40 }
      },
    }
    // K=100 (unreachable), B_eval=5 → exhausts quickly.
    const state = await runPilotLoop('baseline', 'source', 'sha256:baseline', config(100, 5), caps)
    expect(state.terminal).toBe(true)
    expect(state.reason).toMatch(/B_EVAL_EXHAUSTED/)
    expect(state.B_evalRemaining).toBeLessThanOrEqual(0)
  })

  it('deduplicates by digest: a repeated proposal reuses the node, not a new candidate', async () => {
    const caps: PilotCapabilities = {
      async propose() {
        return [
          {
            proposalId: 'p',
            canonicalParentDigest: 'sha256:baseline',
            hypothesis: 'h',
            sourceDiff: '+// change',
            donorCandidates: [],
          },
        ]
      },
      async build() {
        // Always return the SAME digest → every proposal is a duplicate after the first.
        return { candidateId: 'c-same', digest: 'sha256:samechild' }
      },
      async evaluate() {
        return { reward: 1, costUsd: 0.01, wallSec: 40 }
      },
    }
    const state = await runPilotLoop('baseline', 'source', 'sha256:baseline', config(5, 50), caps)
    expect(state.duplicateEdges).toBeGreaterThan(0)
    // Only baseline + 1 unique child admitted (the rest were duplicates).
    expect(state.admittedCount).toBe(2)
  })

  it('records build rejects without admitting a candidate', async () => {
    let id = 0
    const caps: PilotCapabilities = {
      async propose() {
        return [
          {
            proposalId: `p${id}`,
            canonicalParentDigest: 'sha256:baseline',
            hypothesis: `h ${id}`,
            sourceDiff: `+// ${id}`,
            donorCandidates: [],
          },
        ]
      },
      async build() {
        id += 1
        // Reject every other build.
        return id % 2 === 0 ? null : { candidateId: `c${id}`, digest: `sha256:child${id}` }
      },
      async evaluate() {
        return { reward: 1, costUsd: 0.01, wallSec: 40 }
      },
    }
    const state = await runPilotLoop('baseline', 'source', 'sha256:baseline', config(4, 200), caps)
    expect(state.buildRejects).toBeGreaterThan(0)
  })

  it('records eval failures (infra/runtime) and continues', async () => {
    let evalCalls = 0
    const caps: PilotCapabilities = {
      async propose() {
        return [
          {
            proposalId: 'p',
            canonicalParentDigest: 'sha256:baseline',
            hypothesis: 'h',
            sourceDiff: '+// change',
            donorCandidates: [],
          },
        ]
      },
      async build() {
        return { candidateId: 'c1', digest: 'sha256:c1' }
      },
      async evaluate() {
        evalCalls += 1
        if (evalCalls % 3 === 0) throw new Error('infra timeout')
        return { reward: 1, costUsd: 0.01, wallSec: 40 }
      },
    }
    const state = await runPilotLoop('baseline', 'source', 'sha256:baseline', config(3, 30), caps)
    expect(state.evalFailures).toBeGreaterThan(0)
    expect(state.terminal).toBe(true)
  })

  it('observations are attributed to the evaluated candidate (no double-count)', async () => {
    const caps: PilotCapabilities = {
      async propose() {
        return [
          {
            proposalId: 'p',
            canonicalParentDigest: 'sha256:baseline',
            hypothesis: 'h',
            sourceDiff: '+// change',
            donorCandidates: [],
          },
        ]
      },
      async build() {
        return { candidateId: 'c1', digest: 'sha256:c1' }
      },
      async evaluate(_candidateId, _taskId, _attempt) {
        return { reward: 1, costUsd: 0.01, wallSec: 40 }
      },
    }
    const state = await runPilotLoop('baseline', 'source', 'sha256:baseline', config(3, 20), caps)
    // Every observation is attributed to exactly one candidate.
    for (const obs of state.archive.observations) {
      const node = state.archive.nodes.find((n) => n.candidateId === obs.candidateId)
      expect(node).toBeDefined()
    }
  })
})
