import { describe, expect, it } from 'vitest'
import {
  buildDevelopmentPools,
  STABLE_DEMO_TRIAL_PLAN,
  sampleLowConsumptionPanel,
  type BaselineTaskOutcome,
} from '../src/index.js'

const outcomes: BaselineTaskOutcome[] = [
  { taskId: 'fail-a', reward: 0, stratum: 'hard|sysadmin' },
  { taskId: 'fail-b', reward: 0, stratum: 'hard|security' },
  { taskId: 'fail-c', reward: 0, stratum: 'medium|software' },
  { taskId: 'pass-a', reward: 1, stratum: 'easy|software' },
  { taskId: 'pass-b', reward: 1, stratum: 'medium|sysadmin' },
]

describe('low-consumption development panel', () => {
  it('freezes a 15-trial v0.1 stable-demo envelope', () => {
    const parts = Object.entries(STABLE_DEMO_TRIAL_PLAN)
      .filter(([key]) => key !== 'total')
      .reduce((sum, [, count]) => sum + count, 0)
    expect(parts).toBe(15)
    expect(STABLE_DEMO_TRIAL_PLAN.total).toBe(parts)
  })

  it('selects one frozen baseline failure for ordinary candidate screening', () => {
    const panel = sampleLowConsumptionPanel(outcomes, {
      candidateId: 'candidate-a',
      masterSeed: 42n,
    })
    expect(panel.taskIds).toHaveLength(1)
    expect(panel.failureTaskIds).toHaveLength(1)
    expect(panel.regressionTaskIds).toHaveLength(0)
    expect(panel.taskIds).toEqual([...panel.failureTaskIds, ...panel.regressionTaskIds])
  })

  it('supports the default 1/0 request with exactly one failure and no passes', () => {
    const panel = sampleLowConsumptionPanel(
      [{ taskId: 'only-failure', reward: 0, stratum: 'hard|security' }],
      { candidateId: 'candidate-minimal', masterSeed: 7n },
    )
    expect(panel.failureTaskIds).toEqual(['only-failure'])
    expect(panel.regressionTaskIds).toEqual([])
  })

  it('supports a 1/1 request with exactly one task in each pool', () => {
    const panel = sampleLowConsumptionPanel(
      [
        { taskId: 'only-failure', reward: 0, stratum: 'hard|security' },
        { taskId: 'only-pass', reward: 1, stratum: 'easy|software' },
      ],
      {
        candidateId: 'candidate-boundary',
        masterSeed: 7n,
        failureTasks: 1,
        regressionTasks: 1,
      },
    )
    expect(panel.failureTaskIds).toEqual(['only-failure'])
    expect(panel.regressionTaskIds).toEqual(['only-pass'])
  })

  it('is deterministic per candidate and varies its stream across candidates', () => {
    const first = sampleLowConsumptionPanel(outcomes, {
      candidateId: 'candidate-a',
      masterSeed: 42n,
    })
    const replay = sampleLowConsumptionPanel(outcomes, {
      candidateId: 'candidate-a',
      masterSeed: 42n,
    })
    const other = sampleLowConsumptionPanel(outcomes, {
      candidateId: 'candidate-b',
      masterSeed: 42n,
    })
    expect(replay).toEqual(first)
    expect(other.selectionStream).not.toBe(first.selectionStream)
  })

  it('fails closed only when the requested pool sizes cannot be satisfied', () => {
    expect(() =>
      sampleLowConsumptionPanel(
        [
          { taskId: 'fail-a', reward: 0, stratum: 'hard' },
          { taskId: 'pass-a', reward: 1, stratum: 'easy' },
        ],
        { candidateId: 'candidate-a', masterSeed: 42n, failureTasks: 2, regressionTasks: 1 },
      ),
    ).toThrow(/at least 2 baseline-failed/)
    expect(() =>
      sampleLowConsumptionPanel(
        [{ taskId: 'fail-a', reward: 0, stratum: 'hard' }],
        { candidateId: 'candidate-a', masterSeed: 42n, failureTasks: 1, regressionTasks: 1 },
      ),
    ).toThrow(/at least 1 baseline-passed/)
  })

  it('builds valid empty-sided pools without imposing a panel size', () => {
    expect(buildDevelopmentPools(outcomes.filter((row) => row.reward === 0))).toEqual({
      failed: outcomes.filter((row) => row.reward === 0),
      passed: [],
    })
  })

  it('rejects duplicate task outcomes instead of outcome-dependent resampling', () => {
    expect(() => buildDevelopmentPools([...outcomes, outcomes[0]!])).toThrow(
      /duplicate baseline task/,
    )
  })
})
