/**
 * Calibration evidence test — verifies the recorded calibration artifacts are
 * internally consistent (spec 07 §7: "baseline 波动/成本测量 + 可行性判定书面结论").
 *
 * This reads the real calibration evidence produced by scripts/run-calibration.ts
 * and asserts: the split commitment is well-formed, the samples are non-empty
 * with valid wall/cost, and the budget-model verdict is present. It does NOT
 * assert feasibility (that's a measurement, not a correctness property) — it
 * asserts the verdict is RECORDED and self-consistent.
 */
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type SplitCommitment, type CalibrationSample, buildBudgetModel } from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const evidenceDir = join(here, '..', '..', '..', 'evidence', 'calibration')

async function readJson(p: string): Promise<unknown> {
  return JSON.parse(await readFile(p, 'utf8'))
}

describe('calibration evidence (real pilot artifacts)', () => {
  it('the split commitment is a well-formed 48/12/29 Merkle commitment', async () => {
    const commitment = (await readJson(
      join(evidenceDir, 'split-commitment.json'),
    )) as SplitCommitment
    expect(commitment.sizes.devObserved).toBe(48)
    expect(commitment.sizes.devGuard).toBe(12)
    expect(commitment.sizes.sealed).toBe(29)
    expect(commitment.merkleRoot).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(commitment.seedCommitment).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('the calibration samples are non-empty with valid wall/cost', async () => {
    const raw = await readFile(join(evidenceDir, 'calibration-samples.jsonl'), 'utf8')
    const samples = raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as CalibrationSample)
    expect(samples.length).toBeGreaterThan(0)
    for (const s of samples) {
      expect(s.wallSec).toBeGreaterThan(0)
      expect(s.costUsd).toBeGreaterThanOrEqual(0)
      expect(s.reward === 0 || s.reward === 1).toBe(true)
      expect(s.taskId).toBeTruthy()
    }
  })

  it('the budget model verdict is recorded and self-consistent', async () => {
    const budget = await readJson(join(evidenceDir, 'budget-model.json'))
    expect(budget).toHaveProperty('feasible')
    expect(budget).toHaveProperty('B_eval')
    expect(budget).toHaveProperty('k_sealed')
    expect(budget).toHaveProperty('reserveFraction')
    expect((budget as { reserveFraction: number }).reserveFraction).toBe(0.2)
    // If infeasible, a reason MUST be present (honest reporting).
    if ((budget as { feasible: boolean }).feasible === false) {
      expect((budget as { reason: string }).reason).toBeTruthy()
    }
  })

  it('rebuilding the budget model from the recorded samples reproduces the verdict', async () => {
    const raw = await readFile(join(evidenceDir, 'calibration-samples.jsonl'), 'utf8')
    const samples = raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as CalibrationSample)
    const recorded = (await readJson(join(evidenceDir, 'budget-model.json'))) as ReturnType<
      typeof buildBudgetModel
    >
    const rebuilt = buildBudgetModel(samples, {
      K: 80,
      k_sealed: recorded.k_sealed,
      concurrency: recorded.concurrency,
      B_prop_usd: recorded.B_prop_usd,
    })
    expect(rebuilt.feasible).toBe(recorded.feasible)
    // p90 wall is deterministic from samples; cost includes the model-cost floor
    // added in run-calibration, so compare wall (deterministic) exactly.
    expect(rebuilt.predictedP90WallSec).toBeCloseTo(recorded.predictedP90WallSec, 1)
  })
})
