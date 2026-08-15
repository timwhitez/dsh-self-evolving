import { RngStream } from './rng.js'

export interface BaselineTaskOutcome {
  taskId: string
  reward: 0 | 1
  stratum: string
}

export interface DevelopmentPools {
  failed: BaselineTaskOutcome[]
  passed: BaselineTaskOutcome[]
}

export interface LowConsumptionPanel {
  candidateId: string
  selectionStream: string
  taskIds: string[]
  failureTaskIds: string[]
  regressionTaskIds: string[]
}

/** Maximum solver-trial envelope for the v0.1 stable-iteration proof. */
export const STABLE_DEMO_TRIAL_PLAN = Object.freeze({
  baselineFailureDiscoveryMax: 12,
  candidateIterations: 3,
  total: 15,
})

export function buildDevelopmentPools(outcomes: BaselineTaskOutcome[]): DevelopmentPools {
  const seen = new Set<string>()
  for (const row of outcomes) {
    if (!row.taskId || !row.stratum || (row.reward !== 0 && row.reward !== 1)) {
      throw new Error('invalid baseline task outcome')
    }
    if (seen.has(row.taskId)) throw new Error(`duplicate baseline task outcome: ${row.taskId}`)
    seen.add(row.taskId)
  }
  const failed = outcomes.filter((row) => row.reward === 0).sort(byTaskId)
  const passed = outcomes.filter((row) => row.reward === 1).sort(byTaskId)
  if (failed.length < 2)
    throw new Error('low-consumption panel requires at least 2 baseline-failed tasks')
  if (passed.length < 1)
    throw new Error('low-consumption panel requires at least 1 baseline-passed task')
  return { failed, passed }
}

export function sampleLowConsumptionPanel(
  outcomes: BaselineTaskOutcome[],
  options: {
    candidateId: string
    masterSeed: bigint
    failureTasks?: number
    regressionTasks?: number
  },
): LowConsumptionPanel {
  const failureTasks = options.failureTasks ?? 1
  const regressionTasks = options.regressionTasks ?? 0
  if (!options.candidateId) throw new Error('candidateId is required')
  if (!Number.isSafeInteger(failureTasks) || failureTasks < 1) {
    throw new Error('failureTasks must be a positive safe integer')
  }
  if (!Number.isSafeInteger(regressionTasks) || regressionTasks < 0) {
    throw new Error('regressionTasks must be a non-negative safe integer')
  }
  const pools = buildDevelopmentPools(outcomes)
  if (pools.failed.length < failureTasks) {
    throw new Error(`low-consumption panel requires at least ${failureTasks} baseline-failed tasks`)
  }
  if (pools.passed.length < regressionTasks) {
    throw new Error(
      `low-consumption panel requires at least ${regressionTasks} baseline-passed tasks`,
    )
  }
  const selectionStream = `development-panel/${options.candidateId}`
  const failureTaskIds = sampleWithoutReplacement(
    pools.failed.map((row) => row.taskId),
    failureTasks,
    new RngStream(options.masterSeed, `${selectionStream}/failed`),
  )
  const regressionTaskIds = sampleWithoutReplacement(
    pools.passed.map((row) => row.taskId),
    regressionTasks,
    new RngStream(options.masterSeed, `${selectionStream}/passed`),
  )
  return {
    candidateId: options.candidateId,
    selectionStream,
    taskIds: [...failureTaskIds, ...regressionTaskIds],
    failureTaskIds,
    regressionTaskIds,
  }
}

function byTaskId(a: BaselineTaskOutcome, b: BaselineTaskOutcome): number {
  return a.taskId.localeCompare(b.taskId)
}

function sampleWithoutReplacement(values: string[], count: number, rng: RngStream): string[] {
  const pool = [...values]
  for (let index = pool.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(rng.nextDouble() * (index + 1))
    ;[pool[index], pool[swapIndex]] = [pool[swapIndex]!, pool[index]!]
  }
  return pool.slice(0, count)
}
