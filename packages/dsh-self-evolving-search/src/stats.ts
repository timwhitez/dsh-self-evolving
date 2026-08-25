/**
 * Paired cluster-bootstrap statistics + report generator (spec 04 §5).
 *
 * The primary metric is the paired Pass@1 lift of the locked candidate over the
 * baseline on the 29 sealed tasks, per task:
 *   delta_t = pass(candidate, t) - pass(baseline, t)
 *   Delta = mean_t(delta_t)
 * Promotion requires Delta >= 5pp AND the 95% CI lower bound > 0.
 *
 * The CI uses a paired cluster-bootstrap (resample tasks, not trials) with a
 * FIXED seed and a FIXED analysis container, so the result is reproducible and
 * pre-registered. The bootstrap never sees guard/intermediate data.
 */
import { RngStream } from './rng.js'

export const MAX_BOOTSTRAP_RESAMPLES = 1_000_000

export interface PairedTrial {
  taskId: string
  /** Baseline reward on this task (mean of k attempts, or the single attempt). */
  baselineReward: number
  /** Candidate reward on this task. */
  candidateReward: number
}

export interface BootstrapResult {
  /** Mean paired lift (candidate - baseline) over tasks. */
  delta: number
  /** Bootstrap estimate of the standard error. */
  stderr: number
  /** 95% CI [lower, upper] (percentile method). */
  ci95: [number, number]
  /** Number of bootstrap resamples. */
  nResamples: number
  /** Whether Delta >= 5pp AND CI lower > 0. */
  promoted: boolean
}

/**
 * Compute the paired cluster-bootstrap CI over per-task deltas.
 * Resamples TASKS (clusters) with replacement, not individual trials, preserving
 * the paired structure.
 */
export function pairedBootstrapCi(
  trials: PairedTrial[],
  opts: { nResamples?: number; masterSeed?: bigint; minLift?: number } = {},
): BootstrapResult {
  const nResamples = opts.nResamples ?? 10_000
  const masterSeed = opts.masterSeed ?? 0x5eed1234n
  const minLift = opts.minLift ?? 0.05
  if (
    !Number.isSafeInteger(nResamples) ||
    nResamples < 1 ||
    nResamples > MAX_BOOTSTRAP_RESAMPLES
  ) {
    throw new Error(
      `bootstrap: nResamples must be a safe integer from 1 through ${MAX_BOOTSTRAP_RESAMPLES}`,
    )
  }
  if (trials.length === 0) {
    return { delta: 0, stderr: 0, ci95: [0, 0], nResamples, promoted: false }
  }
  const deltas = trials.map((t) => t.candidateReward - t.baselineReward)
  const delta = mean(deltas)
  const rng = new RngStream(masterSeed, 'bootstrap')
  const bootMeans: number[] = []
  for (let i = 0; i < nResamples; i++) {
    let sum = 0
    for (let j = 0; j < trials.length; j++) {
      const idx = Math.floor(rng.nextDouble() * trials.length)
      sum += deltas[idx]!
    }
    bootMeans.push(sum / trials.length)
  }
  bootMeans.sort((a, b) => a - b)
  const lower = percentile(bootMeans, 0.025)
  const upper = percentile(bootMeans, 0.975)
  const stderr = Math.sqrt(variance(bootMeans))
  const promoted = delta >= minLift && lower > 0
  return { delta, stderr, ci95: [lower, upper], nResamples, promoted }
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function variance(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return xs.reduce((acc, x) => acc + (x - m) * (x - m), 0) / (xs.length - 1)
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(p * (sortedAsc.length - 1))))
  return sortedAsc[idx]!
}

/** Assign the exact promotion state including CI uncertainty (spec 07 §10). */
export type PromotionState = 'SEALED_PROMOTED' | 'PROMISING_NOT_CONFIRMED' | 'SEALED_REJECTED'

export function classifyPromotion(result: BootstrapResult, minLift: number = 0.05): PromotionState {
  const { delta, ci95 } = result
  if (delta >= minLift && ci95[0] > 0) return 'SEALED_PROMOTED'
  if (delta > 0) return 'PROMISING_NOT_CONFIRMED'
  return 'SEALED_REJECTED'
}
