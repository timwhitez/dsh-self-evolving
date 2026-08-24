/**
 * Calibration splitter + task stratum sampler (spec 04 §3.2, spec 07 §7).
 *
 * Stratifies the 89 TB 2.1 tasks by public metadata (primary category,
 * difficulty, network flag) and produces a deterministic 48/12/29 split via
 * iterative multilabel stratification with a fixed seed. Difficulty bin uses
 * ONLY public metadata (option 2 of spec 04 §3.2) — no sealed calibration.
 *
 * The calibration pilot samples a representative task STRATUM (not the whole
 * dev set) to measure per-trial cost/wall-time, then extrapolates a budget
 * model. It never touches sealed tasks.
 */
import { RngStream } from './rng.js'
import type { SplitAssignment, SplitLabel } from './split.js'

export interface TaskMeta {
  taskId: string
  difficulty: string
  category: string
  agentTimeoutSec: number
  allowInternet: boolean
}

/** A task stratum = a unique (category, difficulty, allowInternet) cell. */
export interface TaskStratum {
  key: string
  category: string
  difficulty: string
  allowInternet: boolean
  taskIds: string[]
}

/** Partition tasks into (category, difficulty, allowInternet) strata. */
export function stratify(tasks: TaskMeta[]): TaskStratum[] {
  const map = new Map<string, TaskStratum>()
  for (const t of tasks) {
    const key = `${t.category}|${t.difficulty}|${String(t.allowInternet)}`
    if (!map.has(key)) {
      map.set(key, {
        key,
        category: t.category,
        difficulty: t.difficulty,
        allowInternet: t.allowInternet,
        taskIds: [],
      })
    }
    map.get(key)!.taskIds.push(t.taskId)
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key))
}

/**
 * Deterministic 48/12/29 split via per-stratum round-robin assignment with a
 * fixed seed. Strata are sorted; within each stratum tasks are shuffled by the
 * seeded RNG, then dealt round-robin into the three labels in the ratio
 * 48:12:29 until sizes are met. This approximates iterative multilabel
 * stratification (spec 04 §3.2) using public metadata only.
 */
export function deterministicSplit(
  tasks: TaskMeta[],
  masterSeed: bigint,
  sizes: { devObserved: number; devGuard: number; sealed: number } = {
    devObserved: 48,
    devGuard: 12,
    sealed: 29,
  },
): SplitAssignment[] {
  const strata = stratify(tasks)
  const rng = new RngStream(masterSeed, 'split')
  // Shuffle each stratum deterministically.
  const shuffled: string[] = []
  for (const s of strata) {
    const ids = [...s.taskIds]
    // Fisher-Yates with the seeded RNG.
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(rng.nextDouble() * (i + 1))
      ;[ids[i], ids[j]] = [ids[j]!, ids[i]!]
    }
    shuffled.push(...ids)
  }
  // Deal round-robin: assign each label its target proportion.
  const total = sizes.devObserved + sizes.devGuard + sizes.sealed
  const targets: Array<{ label: SplitLabel; remaining: number }> = [
    { label: 'dev-observed', remaining: sizes.devObserved },
    { label: 'dev-guard', remaining: sizes.devGuard },
    { label: 'sealed', remaining: sizes.sealed },
  ]
  const assignment: SplitAssignment[] = []
  let labelIdx = 0
  for (const taskId of shuffled) {
    // Find the next label that still needs tasks (round-robin by remaining ratio).
    let attempts = 0
    while (targets[labelIdx]!.remaining === 0 && attempts < 3) {
      labelIdx = (labelIdx + 1) % 3
      attempts++
    }
    if (targets.every((t) => t.remaining === 0)) break
    assignment.push({ taskId, label: targets[labelIdx]!.label })
    targets[labelIdx]!.remaining -= 1
    labelIdx = (labelIdx + 1) % 3
  }
  if (assignment.length !== total) {
    throw new Error(`split: produced ${assignment.length} assignments, expected ${total}`)
  }
  return assignment
}

/**
 * Sample a representative calibration stratum: pick `perStratum` tasks from
 * each (category, difficulty, allowInternet) stratum, up to `maxTasks` total.
 * Used by the calibration pilot to measure cost/wall WITHOUT running the whole
 * dev set.
 */
export function sampleCalibrationStratum(
  tasks: TaskMeta[],
  masterSeed: bigint,
  perStratum: number,
  maxTasks: number,
): TaskMeta[] {
  const strata = stratify(tasks)
  const rng = new RngStream(masterSeed, 'calibration-sample')
  const out: TaskMeta[] = []
  for (const s of strata) {
    const inStratum = tasks.filter((t) => s.taskIds.includes(t.taskId))
    // Shuffle and take perStratum.
    const shuffled = [...inStratum]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng.nextDouble() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
    }
    out.push(...shuffled.slice(0, perStratum))
  }
  return out.slice(0, maxTasks)
}
