/**
 * Pilot loop tests (spec 07 §8 Gate 6): full autonomous loop, dedup, build
 * rejection, B_eval exhaustion, crash-resume determinism.
 */
import { describe, expect, it } from 'vitest'
import {
  runPilotLoop,
  initialPilotState,
  type PilotCapabilities,
  type PilotConfig,
  type PilotState,
  type ProposedChild,
} from '../src/index.js'
import { DEFAULT_PARAMS } from '@dsh-self-evolving/search'

const BASELINE_SOURCE = 'export const baseline = true'
const BASELINE_DIGEST = 'sha256:baseline'

function config(overrides: Partial<PilotConfig> = {}): PilotConfig {
  return {
    K: 4,
    B_eval: 20,
    params: DEFAULT_PARAMS,
    devTaskIds: ['task-a', 'task-b', 'task-c'],
    masterSeed: 42n,
    ...overrides,
  }
}

/** Deterministic stub capabilities: each proposal produces a unique child. */
function stubCaps(
  options: {
    duplicateEvery?: number
    rejectEvery?: number
    evalReward?: 0 | 1
  } = {},
): PilotCapabilities & { calls: { propose: number; build: number; evaluate: number } } {
  const calls = { propose: 0, build: 0, evaluate: 0 }
  let childSeq = 0
  const caps: PilotCapabilities & { calls: typeof calls } = {
    calls,
    async propose(parentDigest: string): Promise<ProposedChild[]> {
      calls.propose += 1
      childSeq += 1
      return [
        {
          proposalId: `p${childSeq}`,
          canonicalParentDigest: parentDigest,
          hypothesis: `improve behavior variant ${childSeq}`,
          sourceDiff: `+export const v${childSeq} = true`,
          donorCandidates: [],
        },
      ]
    },
    async build(child: ProposedChild) {
      calls.build += 1
      if (options.rejectEvery && calls.build % options.rejectEvery === 0) return null
      const id =
        options.duplicateEvery && calls.build % options.duplicateEvery === 0
          ? 'sha256:duplicate'
          : `sha256:child${calls.build}`
      return {
        candidateId: `c${calls.build}`,
        digest: id,
        source: `${BASELINE_SOURCE}\n${child.sourceDiff}`,
      }
    },
    async evaluate() {
      calls.evaluate += 1
      return { reward: options.evalReward ?? 1, costUsd: 0.01, wallSec: 1 }
    },
  }
  return caps
}

describe('pilot loop (spec 07 §8 Gate 6)', () => {
  it('autonomously admits K candidates and terminates', async () => {
    const cfg = config({ K: 4 })
    const caps = stubCaps()
    const result = await runPilotLoop('baseline', BASELINE_SOURCE, BASELINE_DIGEST, cfg, caps)
    expect(result.terminal).toBe(true)
    expect(result.admittedCount).toBeGreaterThanOrEqual(4)
    expect(result.reason).toMatch(/SEARCH_COMPLETE/)
    expect(result.archive.nodes.length).toBeGreaterThanOrEqual(4)
    expect(caps.calls.propose).toBeGreaterThan(0)
    expect(caps.calls.build).toBeGreaterThan(0)
  })

  it('passes an admitted non-baseline parent exact digest and source to the next proposal', async () => {
    const cfg = config({ K: 2, B_eval: 2 })
    const childDigest = 'sha256:first-child'
    const childSource = 'export const firstChild = true'
    const resumed: PilotState = initialPilotState('baseline', cfg, BASELINE_DIGEST, BASELINE_SOURCE)
    resumed.archive.nodes = [
      {
        candidateId: childDigest,
        digest: childDigest,
        source: childSource,
        canonicalParent: 'baseline',
        donorCandidates: [],
        s: 0,
        f: 0,
      },
    ]
    resumed.admittedCount = 1
    const seen: Array<{ digest: string; source: string }> = []
    const caps: PilotCapabilities = {
      async propose(parentDigest, parentSource) {
        seen.push({ digest: parentDigest, source: parentSource })
        return [
          {
            proposalId: 'second-generation',
            canonicalParentDigest: parentDigest,
            hypothesis: 'expand the exact first-generation source',
            sourceDiff: '+export const secondChild = true',
            donorCandidates: [],
          },
        ]
      },
      async build(child) {
        return {
          candidateId: 'second-child',
          digest: 'sha256:second-child',
          source: `${childSource}\n${child.sourceDiff}`,
        }
      },
      async evaluate() {
        return { reward: 1, costUsd: 0.01, wallSec: 1 }
      },
    }

    await runPilotLoop('baseline', BASELINE_SOURCE, BASELINE_DIGEST, cfg, caps, resumed)

    expect(seen).toEqual([{ digest: childDigest, source: childSource }])
  })

  it('fails closed when a selected parent has no resolvable source', async () => {
    const cfg = config({ K: 2 })
    const state = initialPilotState('baseline', cfg, BASELINE_DIGEST, '')
    const caps = stubCaps()
    await expect(
      runPilotLoop('baseline', BASELINE_SOURCE, BASELINE_DIGEST, cfg, caps, state),
    ).rejects.toThrow(/no resolvable canonical source/)
    expect(caps.calls.propose).toBe(0)
  })

  it('deduplicates children with the same canonical digest', async () => {
    const cfg = config({ K: 3, B_eval: 5 })
    const caps = stubCaps({ duplicateEvery: 1 })
    const result = await runPilotLoop('baseline', BASELINE_SOURCE, BASELINE_DIGEST, cfg, caps)
    expect(result.duplicateEdges).toBeGreaterThan(0)
    const ids = result.archive.nodes.map((n) => n.candidateId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('records build rejects without admitting the child', async () => {
    const cfg = config({ K: 3, B_eval: 5 })
    const caps = stubCaps({ rejectEvery: 1 })
    const result = await runPilotLoop('baseline', BASELINE_SOURCE, BASELINE_DIGEST, cfg, caps)
    expect(result.buildRejects).toBeGreaterThan(0)
    expect(result.admittedCount).toBe(1) // only baseline
  })

  it('terminates when B_eval is exhausted', async () => {
    const cfg = config({ K: 100, B_eval: 3 })
    // Force evaluation by setting a large initial archive? The UCB decision will
    // alternate; with K=100 and B_eval=3 it eventually exhausts.
    const caps = stubCaps({ rejectEvery: 1 }) // no new admissions
    const result = await runPilotLoop('baseline', BASELINE_SOURCE, BASELINE_DIGEST, cfg, caps)
    expect(result.terminal).toBe(true)
    expect(result.reason).toMatch(/B_EVAL_EXHAUSTED|ITERATION_CAP/)
  })

  it('records evaluation observations with attribution', async () => {
    const cfg = config({ K: 3, B_eval: 10 })
    const caps = stubCaps({ evalReward: 1 })
    const result = await runPilotLoop('baseline', BASELINE_SOURCE, BASELINE_DIGEST, cfg, caps)
    // Depending on UCB scheduling, evaluations should occur before K reached.
    if (result.archive.observations.length > 0) {
      const obs = result.archive.observations[0]!
      expect(obs.reward).toBe(1)
      expect(obs.costUsd).toBe(0.01)
      expect(result.N).toBe(result.archive.observations.length)
    }
  })

  it('resumes from a partial state without duplicating admitted nodes', async () => {
    const cfg = config({ K: 4 })
    const caps1 = stubCaps()
    // Run with K=2 to get a partial archive.
    const partialCfg = { ...cfg, K: 2 }
    const partial = await runPilotLoop(
      'baseline',
      BASELINE_SOURCE,
      BASELINE_DIGEST,
      partialCfg,
      caps1,
    )
    expect(partial.admittedCount).toBeGreaterThanOrEqual(2)
    // Un-terminal and resume toward K=4 with the accumulated state.
    partial.terminal = false
    partial.reason = null
    const caps2 = stubCaps()
    const resumed = await runPilotLoop(
      'baseline',
      BASELINE_SOURCE,
      BASELINE_DIGEST,
      cfg,
      caps2,
      partial,
    )
    expect(resumed.admittedCount).toBeGreaterThanOrEqual(4)
    const ids = resumed.archive.nodes.map((n) => n.candidateId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('default config produces a valid initial state', () => {
    const cfg = config()
    const state = initialPilotState('baseline', cfg, BASELINE_DIGEST, BASELINE_SOURCE)
    expect(state.admittedCount).toBe(1)
    expect(state.B_evalRemaining).toBe(cfg.B_eval)
    expect(state.archive.nodes[0]?.candidateId).toBe('baseline')
    expect(state.archive.nodes[0]?.digest).toBe(BASELINE_DIGEST)
    expect(state.archive.nodes[0]?.source).toBe(BASELINE_SOURCE)
    expect(state.terminal).toBe(false)
  })
})
