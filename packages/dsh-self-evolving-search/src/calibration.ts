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

function shuffleInPlace<T>(values: T[], rng: RngStream): void {
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(rng.nextDouble() * (i + 1))
    ;[values[i], values[j]] = [values[j]!, values[i]!]
  }
}

/**
 * Sample a representative calibration set under a global cap. Strata are first
 * placed in a deterministic seeded order, their tasks are shuffled, and then
 * sampling proceeds in rounds so every selected stratum contributes its first
 * task before any stratum contributes a second. The cap therefore cannot turn
 * into a lexicographic-prefix filter. Strata preserve category, difficulty,
 * and network policy as independent public metadata dimensions.
 */
export function sampleCalibrationStratum(
  tasks: TaskMeta[],
  masterSeed: bigint,
  perStratum: number,
  maxTasks: number,
): TaskMeta[] {
  if (!Number.isSafeInteger(perStratum) || perStratum < 0) {
    throw new Error('calibration sample: perStratum must be a non-negative integer')
  }
  if (!Number.isSafeInteger(maxTasks) || maxTasks < 0) {
    throw new Error('calibration sample: maxTasks must be a non-negative integer')
  }

  const rng = new RngStream(masterSeed, 'calibration-sample')
  const orderedStrata = [...stratify(tasks)]
  shuffleInPlace(orderedStrata, rng)
  const byId = new Map(tasks.map((task) => [task.taskId, task]))
  const candidates = orderedStrata.map((stratum) => {
    const rows = stratum.taskIds.map((taskId) => {
      const task = byId.get(taskId)
      if (task === undefined) throw new Error(`calibration sample: missing task ${taskId}`)
      return task
    })
    shuffleInPlace(rows, rng)
    return rows.slice(0, perStratum)
  })

  const out: TaskMeta[] = []
  for (let round = 0; round < perStratum && out.length < maxTasks; round += 1) {
    for (const rows of candidates) {
      const task = rows[round]
      if (task !== undefined) out.push(task)
      if (out.length === maxTasks) break
    }
  }
  return out
}
