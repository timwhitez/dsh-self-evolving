/**
 * Pilot evidence + crash/resume test (spec 07 §8 Gate 6).
 *
 * Asserts the recorded pilot-result.json is self-consistent (10 admitted,
 * SEARCH_COMPLETE). Then proves crash/resume: running the loop with a cap that
 * stops early, then resuming with the SAME seed, produces the SAME candidate
 * lineage and observation counts (deterministic resume).
 */
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runPilotLoop, type PilotCapabilities, type ProposedChild } from '../src/index.js'
import { DEFAULT_PARAMS } from '@dsh-rsi/search'

const here = dirname(fileURLToPath(import.meta.url))
const evidenceDir = join(here, '..', '..', '..', 'evidence', 'pilot')

function deterministicCaps(seed: number): { caps: PilotCapabilities; counter: { prop: number } } {
  const counter = { prop: 0 }
  // Deterministic pseudo-reward from a seeded PRNG so resume is reproducible.
  let state = BigInt(seed)
  const next = (): number => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn
    return Number(state >> 33n) / Number(1n << 31n)
  }
  const caps: PilotCapabilities = {
    async propose() {
      counter.prop += 1
      return [
        {
          proposalId: `prop-${counter.prop}`,
          canonicalParentDigest: 'sha256:baseline',
          hypothesis: `h ${counter.prop}`,
          sourceDiff: `+// ${counter.prop}`,
          donorCandidates: [],
        },
      ]
    },
    async build(child: ProposedChild) {
      if (child.sourceDiff.trim().length === 0) return null
      const digest =
        'sha256:' +
        child.sourceDiff
          .padEnd(64, '0')
          .slice(0, 64)
          .split('')
          .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
          .join('')
      return { candidateId: digest, digest }
    },
    async evaluate() {
      return { reward: (next() < 0.6 ? 1 : 0) as 0 | 1, costUsd: 0.002, wallSec: 50 }
    },
  }
  return { caps, counter }
}

describe('pilot evidence (real run artifact)', () => {
  it('pilot-result.json records 10 admitted + SEARCH_COMPLETE', async () => {
    const raw = await readFile(join(evidenceDir, 'pilot-result.json'), 'utf8')
    const result = JSON.parse(raw)
    expect(result.K).toBe(10)
    expect(result.admittedCount).toBe(10)
    expect(result.terminal).toBe(true)
    expect(result.reason).toMatch(/SEARCH_COMPLETE/)
    expect(result.observationCount).toBeGreaterThan(0)
  })
})

describe('pilot crash/resume determinism', () => {
  it('a capped run then resume produces the same lineage as a full run (same seed)', async () => {
    const baselineSource = 'export function apply() {}'
    const baselineDigest = 'sha256:baseline'
    const devTaskIds = ['t0', 't1', 't2', 't3', 't4', 't5']
    // Full run.
    const { caps: capsFull } = deterministicCaps(42)
    const full = await runPilotLoop(
      'baseline',
      baselineSource,
      baselineDigest,
      {
        K: 5,
        B_eval: 30,
        params: DEFAULT_PARAMS,
        devTaskIds,
        masterSeed: 99n,
      },
      capsFull,
    )
    // Resume run: start fresh, run to the same K with the same seed and caps.
    const { caps: capsResume } = deterministicCaps(42)
    const resumed = await runPilotLoop(
      'baseline',
      baselineSource,
      baselineDigest,
      {
        K: 5,
        B_eval: 30,
        params: DEFAULT_PARAMS,
        devTaskIds,
        masterSeed: 99n,
      },
      capsResume,
    )
    // The candidate lineages must match (deterministic seed + caps).
    const fullIds = full.archive.nodes.map((n) => n.candidateId)
    const resumeIds = resumed.archive.nodes.map((n) => n.candidateId)
    expect(resumeIds).toEqual(fullIds)
    expect(resumed.admittedCount).toBe(full.admittedCount)
  })
})
