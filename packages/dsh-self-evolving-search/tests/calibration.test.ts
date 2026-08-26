/**
 * Calibration splitter + budget model tests (spec 04 §3, spec 07 §7).
 */
import { describe, expect, it } from 'vitest'
import {
  stratify,
  deterministicSplit,
  sampleCalibrationStratum,
  buildBudgetModel,
  DEFAULT_TARGETS,
  type TaskMeta,
  type CalibrationSample,
} from '../src/index.js'
import { commitSplit, verifySplit, SPLIT_SIZES } from '../src/index.js'

function fakeTasks(n: number): TaskMeta[] {
  const cats = ['software-engineering', 'system-administration', 'data-science', 'security']
  const diffs = ['easy', 'medium', 'hard']
  const out: TaskMeta[] = []
  for (let i = 0; i < n; i++) {
    out.push({
      taskId: `task-${i}`,
      category: cats[i % cats.length]!,
      difficulty: diffs[i % diffs.length]!,
      agentTimeoutSec: 900,
      allowInternet: true,
    })
  }
  return out
}

describe('calibration splitter (spec 04 §3)', () => {
  it('stratifies by (category, difficulty, allowInternet)', () => {
    const strata = stratify(fakeTasks(12))
    expect(strata.length).toBeGreaterThan(0)
    for (const s of strata) {
      expect(s.taskIds.length).toBeGreaterThan(0)
      expect(s.key).toBe(JSON.stringify([s.category, s.difficulty, s.allowInternet]))
    }
  })

  it('keeps otherwise identical online and offline tasks in separate strata', () => {
    const common = {
      category: 'software-engineering',
      difficulty: 'hard',
      agentTimeoutSec: 900,
    }
    const strata = stratify([
      { ...common, taskId: 'offline', allowInternet: false },
      { ...common, taskId: 'online', allowInternet: true },
    ])

    expect(strata).toHaveLength(2)
    expect(strata.map((stratum) => stratum.allowInternet)).toEqual([false, true])
    expect(strata.map((stratum) => stratum.taskIds)).toEqual([['offline'], ['online']])
  })

  it('deterministicSplit produces exactly 48/12/29 for 89 tasks', () => {
    const tasks = fakeTasks(89)
    const assignment = deterministicSplit(tasks, 0xc0ffeen)
    const counts = { 'dev-observed': 0, 'dev-guard': 0, sealed: 0 }
    for (const a of assignment) counts[a.label] += 1
    expect(counts['dev-observed']).toBe(SPLIT_SIZES.devObserved)
    expect(counts['dev-guard']).toBe(SPLIT_SIZES.devGuard)
    expect(counts.sealed).toBe(SPLIT_SIZES.sealed)
  })

  it('deterministicSplit is reproducible for the same seed', () => {
    const tasks = fakeTasks(89)
    const a = deterministicSplit(tasks, 42n)
    const b = deterministicSplit(tasks, 42n)
    expect(a).toEqual(b)
  })

  it('the split commitment verifies against its assignment', () => {
    const tasks = fakeTasks(89)
    const assignment = deterministicSplit(tasks, 7n)
    const inventory = tasks.map((task) => task.taskId)
    const commitment = commitSplit(assignment, `sha256:${'0'.repeat(64)}`, inventory, SPLIT_SIZES)
    expect(verifySplit(commitment, assignment, inventory)).toBe(true)
  })

  it('sampleCalibrationStratum respects perStratum + maxTasks', () => {
    const tasks = fakeTasks(89)
    const sample = sampleCalibrationStratum(tasks, 1n, 1, 8)
    expect(sample.length).toBeLessThanOrEqual(8)
    // Each stratum contributes at most 1 task.
    const strataSeen = new Set(
      sample.map((t) => `${t.category}|${t.difficulty}|${String(t.allowInternet)}`),
    )
    expect(strataSeen.size).toBe(sample.length)
  })
})

describe('budget model + CALIBRATION_INFEASIBLE gate (spec 07 §7)', () => {
  function samples(costUsd: number, wallSec: number, n: number): CalibrationSample[] {
    return Array.from({ length: n }, (_, i) => ({
      candidateId: 'baseline',
      taskId: `t${i}`,
      attempt: 0,
      costUsd,
      wallSec,
      reward: i % 2 === 0 ? 1 : 0,
    }))
  }

  it('predicts feasible when cost/wall are well under targets', () => {
    const budget = buildBudgetModel(samples(0.05, 60, 20))
    expect(budget.feasible).toBe(true)
    expect(budget.predictedP90CostUsd).toBeLessThan(500)
    expect(budget.predictedP90WallSec).toBeLessThan(16 * 3600)
    expect(budget.B_eval).toBeGreaterThan(0)
    expect(budget.k_sealed).toBe(1)
    expect(budget.reserveFraction).toBe(0.2)
  })

  it('flags CALIBRATION_INFEASIBLE when cost exceeds $500', () => {
    const budget = buildBudgetModel(samples(0.8, 60, 20))
    expect(budget.feasible).toBe(false)
    expect(budget.reason).toMatch(/p90 cost/)
  })

  it('flags CALIBRATION_INFEASIBLE when wall exceeds 16h', () => {
    const budget = buildBudgetModel(samples(0.01, 3600, 20))
    expect(budget.feasible).toBe(false)
    expect(budget.reason).toMatch(/p90 wall/)
  })

  it('returns infeasible with a reason when there are no samples', () => {
    const budget = buildBudgetModel([])
    expect(budget.feasible).toBe(false)
    expect(budget.reason).toMatch(/no calibration samples/)
  })

  it('rejects NaN, infinite and negative calibration inputs', () => {
    const nanSamples = samples(0.05, 60, 20).map((sample, index) =>
      index === 0 ? { ...sample, costUsd: Number.NaN, wallSec: Number.NaN } : sample,
    )
    expect(buildBudgetModel(nanSamples).feasible).toBe(false)

    for (const bad of [
      { ...samples(0.05, 60, 20)[0]!, costUsd: -1 },
      { ...samples(0.05, 60, 20)[0]!, wallSec: 0 },
      { ...samples(0.05, 60, 20)[0]!, wallSec: -5 },
      { ...samples(0.05, 60, 20)[0]!, costUsd: Number.POSITIVE_INFINITY },
      { ...samples(0.05, 60, 20)[0]!, reward: 0.5 },
      { ...samples(0.05, 60, 20)[0]!, attempt: -1 },
      { ...samples(0.05, 60, 20)[0]!, candidateId: '' },
      { ...samples(0.05, 60, 20)[0]!, taskId: '' },
    ]) {
      const budget = buildBudgetModel([...samples(0.05, 60, 20).slice(1), bad])
      expect(budget.feasible).toBe(false)
      expect(budget.reason).toMatch(/must be|binary|non-negative integer|non-empty/)
    }
  })

  it('rejects invalid plan parameters and targets', () => {
    const valid = samples(0.05, 60, 20)
    expect(buildBudgetModel(valid, { K: Number.NaN }).reason).toMatch(/K must be/)
    expect(buildBudgetModel(valid, { K: -1 }).reason).toMatch(/K must be/)
    expect(buildBudgetModel(valid, { k_sealed: 0 }).reason).toMatch(/k_sealed must be/)
    expect(buildBudgetModel(valid, { concurrency: 0 }).reason).toMatch(/concurrency must be/)
    expect(buildBudgetModel(valid, { B_prop_usd: -1 }).reason).toMatch(/B_prop_usd must be/)
    expect(buildBudgetModel(valid, { B_prop_usd: Number.NaN }).reason).toMatch(/B_prop_usd must be/)
    expect(
      buildBudgetModel(valid, { targets: { ...DEFAULT_TARGETS, maxCostUsd: 0 } }).reason,
    ).toMatch(/maxCostUsd must be/)
    expect(
      buildBudgetModel(valid, {
        targets: { ...DEFAULT_TARGETS, maxWallSec: Number.POSITIVE_INFINITY },
      }).reason,
    ).toMatch(/maxWallSec must be/)
    for (const reserveFraction of [-0.1, 1, Number.NaN]) {
      expect(
        buildBudgetModel(valid, { targets: { ...DEFAULT_TARGETS, reserveFraction } }).reason,
      ).toMatch(/reserveFraction must be/)
    }
  })
})
