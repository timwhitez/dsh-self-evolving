/**
 * Calibration budget model + feasibility gate (spec 03 §2, spec 07 §7).
 *
 * Inputs: measured per-trial cost (USD) and wall-time (sec) from the
 * calibration pilot. Outputs: the frozen run budget
 *   B_eval, B_prop, k_sealed, concurrency, reserve
 * and a FEASIBLE / CALIBRATION_INFEASIBLE verdict.
 *
 * The model extrapolates the full-search cost from the calibration sample and
 * checks it against the $500 / 16h targets WITH a 20% reserve. If p90 cost >
 * $500 or p90 wall > 16h, the run is CALIBRATION_INFEASIBLE (fail-closed) — the
 * protocol is NOT silently shrunk to fit.
 */
export interface CalibrationSample {
  candidateId: string
  taskId: string
  attempt: number
  costUsd: number
  wallSec: number
  reward: 0 | 1
}

export interface BudgetTargets {
  maxCostUsd: number
  maxWallSec: number
  reserveFraction: number
}

export const DEFAULT_TARGETS: BudgetTargets = {
  maxCostUsd: 500,
  maxWallSec: 16 * 3600,
  reserveFraction: 0.2,
}

export interface FrozenBudget {
  /** Total development agent-task trial budget. */
  B_eval: number
  /** Proposal model budget in USD. */
  B_prop_usd: number
  /** Sealed attempts per task (baseline + candidate). */
  k_sealed: number
  /** Concurrency. */
  concurrency: number
  /** Reserve fraction. */
  reserveFraction: number
  /** Predicted p90 total cost (USD). */
  predictedP90CostUsd: number
  /** Predicted p90 total wall (sec). */
  predictedP90WallSec: number
  /** Feasibility verdict. */
  feasible: boolean
  /** Reason when infeasible. */
  reason: string | null
}

/**
 * Build the budget model from a calibration sample.
 *
 *   - per-trial cost p90 = percentile(samples.costUsd, 0.9)
 *   - per-trial wall p90 = percentile(samples.wallSec, 0.9)
 *   - predicted total cost = (B_eval + sealedTrials) * perTrialCostP90 * (1+reserve)
 *   - predicted total wall = (B_eval + sealedTrials) / concurrency * perTrialWallP90
 *
 * Default plan: K=80 candidates, q0=3 cold-start each, ~5 dev trials per
 * candidate average, 60 dev tasks, 29 sealed × 2 (baseline+candidate) × k_sealed.
 */
export function buildBudgetModel(
  samples: CalibrationSample[],
  opts: {
    K?: number
    k_sealed?: number
    concurrency?: number
    targets?: BudgetTargets
    B_prop_usd?: number
  } = {},
): FrozenBudget {
  const K = opts.K ?? 80
  const k_sealed = opts.k_sealed ?? 1
  const concurrency = opts.concurrency ?? 4
  const targets = opts.targets ?? DEFAULT_TARGETS
  const B_prop_usd = opts.B_prop_usd ?? 40

  const invalid = (reason: string): FrozenBudget => ({
    B_eval: 0,
    B_prop_usd,
    k_sealed,
    concurrency,
    reserveFraction: targets.reserveFraction,
    predictedP90CostUsd: Number.NaN,
    predictedP90WallSec: Number.NaN,
    feasible: false,
    reason,
  })

  // Every plan/target parameter must satisfy its explicit domain before any
  // arithmetic: NaN comparisons are false and negatives shrink predictions,
  // so malformed inputs would otherwise pass the upper-bound gate.
  if (!isPositiveSafeInteger(K)) return invalid('K must be a positive safe integer')
  if (!isPositiveSafeInteger(k_sealed)) {
    return invalid('k_sealed must be a positive safe integer')
  }
  if (!isPositiveSafeInteger(concurrency)) {
    return invalid('concurrency must be a positive safe integer')
  }
  if (!Number.isFinite(B_prop_usd) || B_prop_usd < 0) {
    return invalid('B_prop_usd must be finite and non-negative')
  }
  if (!Number.isFinite(targets.maxCostUsd) || targets.maxCostUsd <= 0) {
    return invalid('targets.maxCostUsd must be finite and positive')
  }
  if (!Number.isFinite(targets.maxWallSec) || targets.maxWallSec <= 0) {
    return invalid('targets.maxWallSec must be finite and positive')
  }
  if (
    !Number.isFinite(targets.reserveFraction) ||
    targets.reserveFraction < 0 ||
    targets.reserveFraction >= 1
  ) {
    return invalid('targets.reserveFraction must be finite and within [0, 1)')
  }

  if (samples.length === 0) {
    return {
      B_eval: 0,
      B_prop_usd,
      k_sealed,
      concurrency,
      reserveFraction: targets.reserveFraction,
      predictedP90CostUsd: 0,
      predictedP90WallSec: 0,
      feasible: false,
      reason: 'no calibration samples',
    }
  }

  for (const sample of samples) {
    if (
      typeof sample.candidateId !== 'string' ||
      sample.candidateId.length === 0 ||
      typeof sample.taskId !== 'string' ||
      sample.taskId.length === 0
    ) {
      return invalid('calibration samples must carry non-empty candidate/task identities')
    }
    if (!Number.isSafeInteger(sample.attempt) || sample.attempt < 0) {
      return invalid(`calibration sample attempt must be a non-negative integer: ${sample.taskId}`)
    }
    if (sample.reward !== 0 && sample.reward !== 1) {
      return invalid(`calibration sample reward must be binary: ${sample.taskId}`)
    }
    if (!Number.isFinite(sample.costUsd) || sample.costUsd < 0) {
      return invalid(`calibration sample costUsd must be finite and non-negative: ${sample.taskId}`)
    }
    if (!Number.isFinite(sample.wallSec) || sample.wallSec <= 0) {
      return invalid(`calibration sample wallSec must be finite and positive: ${sample.taskId}`)
    }
  }

  const costs = samples.map((s) => s.costUsd).sort((a, b) => a - b)
  const walls = samples.map((s) => s.wallSec).sort((a, b) => a - b)
  const perTrialCostP90 = percentile(costs, 0.9)
  const perTrialWallP90 = percentile(walls, 0.9)

  // Total ordinary dev trials: ~K candidates * (q0 cold-start + ~5 eval) + baseline.
  const devTrials = K * (3 + 5) + 60 * 2 // baseline on 60 dev tasks × 2
  const sealedTrials = 29 * 2 * k_sealed // baseline + candidate on 29 sealed
  const totalTrials = devTrials + sealedTrials
  const B_eval = devTrials

  const predictedP90CostUsd =
    totalTrials * perTrialCostP90 * (1 + targets.reserveFraction) + B_prop_usd
  const predictedP90WallSec = (totalTrials / concurrency) * perTrialWallP90

  let feasible = true
  let reason: string | null = null
  if (predictedP90CostUsd > targets.maxCostUsd) {
    feasible = false
    reason = `p90 cost $${predictedP90CostUsd.toFixed(2)} > $${targets.maxCostUsd}`
  }
  if (predictedP90WallSec > targets.maxWallSec) {
    feasible = false
    reason =
      (reason ? reason + '; ' : '') +
      `p90 wall ${predictedP90WallSec.toFixed(0)}s > ${targets.maxWallSec}s`
  }

  return {
    B_eval,
    B_prop_usd,
    k_sealed,
    concurrency,
    reserveFraction: targets.reserveFraction,
    predictedP90CostUsd,
    predictedP90WallSec,
    feasible,
    reason,
  }
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(p * (sortedAsc.length - 1))))
  return sortedAsc[idx]!
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}
