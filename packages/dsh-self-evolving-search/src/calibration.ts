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

const SPLIT_LABELS: readonly SplitLabel[] = ['dev-observed', 'dev-guard', 'sealed']
type LabelCounts = Record<SplitLabel, number>

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1
}

function isProtocolText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0)!
      return codePoint <= 0x1f || codePoint === 0x7f
    })
  )
}

function validateTasks(tasks: TaskMeta[]): void {
  if (!Array.isArray(tasks)) throw new Error('split: tasks must be an array')
  const taskIds = new Set<string>()
  for (const [index, task] of tasks.entries()) {
    if (typeof task !== 'object' || task === null) {
      throw new Error(`split: task ${index} must be an object`)
    }
    if (!isProtocolText(task.taskId)) throw new Error(`split: task ${index} has invalid taskId`)
    if (taskIds.has(task.taskId)) throw new Error(`split: duplicate taskId ${task.taskId}`)
    taskIds.add(task.taskId)
    if (!isProtocolText(task.category)) {
      throw new Error(`split: task ${task.taskId} has invalid category`)
    }
    if (!isProtocolText(task.difficulty)) {
      throw new Error(`split: task ${task.taskId} has invalid difficulty`)
    }
    if (!Number.isSafeInteger(task.agentTimeoutSec) || task.agentTimeoutSec <= 0) {
      throw new Error(`split: task ${task.taskId} has invalid timeout`)
    }
    if (typeof task.allowInternet !== 'boolean') {
      throw new Error(`split: task ${task.taskId} has invalid network flag`)
    }
  }
}

/** Partition tasks into (category, difficulty, allowInternet) strata. */
export function stratify(tasks: TaskMeta[]): TaskStratum[] {
  validateTasks(tasks)
  const map = new Map<string, TaskStratum>()
  for (const t of tasks) {
    const key = JSON.stringify([t.category, t.difficulty, t.allowInternet])
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
  const strata = [...map.values()].sort((a, b) => compareText(a.key, b.key))
  for (const stratum of strata) stratum.taskIds.sort(compareText)
  return strata
}

interface RoundedStratum {
  stratum: TaskStratum
  floors: LabelCounts
  remainders: Record<SplitLabel, bigint>
  tieRanks: Record<SplitLabel, bigint>
  masks: number[]
}

interface AllocationState {
  used: LabelCounts
  remainderScore: bigint
  tieScore: bigint
  signature: string
  masks: number[]
}

function validatedTargetCounts(
  taskCount: number,
  sizes: { devObserved: number; devGuard: number; sealed: number },
): LabelCounts {
  const counts: LabelCounts = {
    'dev-observed': sizes.devObserved,
    'dev-guard': sizes.devGuard,
    sealed: sizes.sealed,
  }
  for (const label of SPLIT_LABELS) {
    if (!Number.isSafeInteger(counts[label]) || counts[label] < 0) {
      throw new Error(`split: ${label} size must be a non-negative safe integer`)
    }
  }
  const total = SPLIT_LABELS.reduce((sum, label) => sum + BigInt(counts[label]), 0n)
  if (total !== BigInt(taskCount)) {
    throw new Error(`split: received ${taskCount} tasks, expected exactly ${total}`)
  }
  return counts
}

function masksWithCardinality(eligibleMask: number, count: number): number[] {
  const masks: number[] = []
  for (let mask = 0; mask < 1 << SPLIT_LABELS.length; mask += 1) {
    if ((mask & ~eligibleMask) !== 0) continue
    let bits = 0
    for (let index = 0; index < SPLIT_LABELS.length; index += 1) {
      if ((mask & (1 << index)) !== 0) bits += 1
    }
    if (bits === count) masks.push(mask)
  }
  return masks
}

function stateKey(counts: LabelCounts): string {
  return SPLIT_LABELS.map((label) => counts[label]).join(',')
}

function isBetterState(candidate: AllocationState, current: AllocationState | undefined): boolean {
  if (current === undefined) return true
  if (candidate.remainderScore !== current.remainderScore) {
    return candidate.remainderScore > current.remainderScore
  }
  if (candidate.tieScore !== current.tieScore) return candidate.tieScore > current.tieScore
  return candidate.signature < current.signature
}

/**
 * Controlled-round the complete stratum × label ideal matrix. Every cell is
 * floor/ceil of its one frozen global ideal, row/column totals remain exact,
 * and the globally minimum L1-error matrix wins. Seeded ranks break equal
 * optima; the canonical matrix signature is the final total-order fallback.
 */
function allocateGlobalQuotas(
  strata: TaskStratum[],
  targets: LabelCounts,
  total: number,
  masterSeed: bigint,
): LabelCounts[] {
  if (total === 0) return []
  const totalBig = BigInt(total)
  const columnFloors: LabelCounts = { 'dev-observed': 0, 'dev-guard': 0, sealed: 0 }
  const plans: RoundedStratum[] = strata.map((stratum) => {
    const floors: LabelCounts = { 'dev-observed': 0, 'dev-guard': 0, sealed: 0 }
    const remainders = {} as Record<SplitLabel, bigint>
    const tieRanks = {} as Record<SplitLabel, bigint>
    let floorSum = 0
    let eligibleMask = 0
    for (const [labelIndex, label] of SPLIT_LABELS.entries()) {
      const numerator = BigInt(stratum.taskIds.length) * BigInt(targets[label])
      const floor = Number(numerator / totalBig)
      const remainder = numerator % totalBig
      floors[label] = floor
      remainders[label] = remainder
      columnFloors[label] += floor
      floorSum += floor
      if (remainder > 0n) eligibleMask |= 1 << labelIndex
      tieRanks[label] = new RngStream(
        masterSeed,
        JSON.stringify(['split-quota-tie-v1', stratum.key, label]),
      ).nextU64()
    }
    const extraCount = stratum.taskIds.length - floorSum
    const masks = masksWithCardinality(eligibleMask, extraCount)
    if (masks.length === 0) {
      throw new Error(`split: no controlled-rounding choice for stratum ${stratum.key}`)
    }
    return { stratum, floors, remainders, tieRanks, masks }
  })

  const requiredExtras: LabelCounts = {
    'dev-observed': targets['dev-observed'] - columnFloors['dev-observed'],
    'dev-guard': targets['dev-guard'] - columnFloors['dev-guard'],
    sealed: targets.sealed - columnFloors.sealed,
  }
  let states = new Map<string, AllocationState>()
  const empty: LabelCounts = { 'dev-observed': 0, 'dev-guard': 0, sealed: 0 }
  states.set(stateKey(empty), {
    used: empty,
    remainderScore: 0n,
    tieScore: 0n,
    signature: '',
    masks: [],
  })

  for (const plan of plans) {
    const next = new Map<string, AllocationState>()
    for (const state of states.values()) {
      for (const mask of plan.masks) {
        const used: LabelCounts = { ...state.used }
        let remainderScore = state.remainderScore
        let tieScore = state.tieScore
        let feasible = true
        for (const [labelIndex, label] of SPLIT_LABELS.entries()) {
          if ((mask & (1 << labelIndex)) === 0) continue
          used[label] += 1
          if (used[label] > requiredExtras[label]) {
            feasible = false
            break
          }
          remainderScore += plan.remainders[label]
          tieScore += plan.tieRanks[label]
        }
        if (!feasible) continue
        const candidate: AllocationState = {
          used,
          remainderScore,
          tieScore,
          signature: state.signature + mask.toString(16),
          masks: [...state.masks, mask],
        }
        const key = stateKey(used)
        const current = next.get(key)
        if (isBetterState(candidate, current)) next.set(key, candidate)
      }
    }
    states = next
  }

  const winner = states.get(stateKey(requiredExtras))
  if (winner === undefined || winner.masks.length !== plans.length) {
    throw new Error('split: global controlled rounding did not converge')
  }
  return plans.map((plan, planIndex) => {
    const quota: LabelCounts = { ...plan.floors }
    const mask = winner.masks[planIndex]!
    for (const [labelIndex, label] of SPLIT_LABELS.entries()) {
      if ((mask & (1 << labelIndex)) !== 0) quota[label] += 1
    }
    return quota
  })
}

/**
 * Deterministic globally quota-aware split using public metadata only.
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
  const targets = validatedTargetCounts(tasks.length, sizes)
  const quotas = allocateGlobalQuotas(strata, targets, tasks.length, masterSeed)
  const assignment: SplitAssignment[] = []
  for (const [stratumIndex, stratum] of strata.entries()) {
    const ids = [...stratum.taskIds]
    const rng = new RngStream(masterSeed, JSON.stringify(['split-task-order-v1', stratum.key]))
    shuffleInPlace(ids, rng)
    const quota = quotas[stratumIndex]!
    let offset = 0
    for (const label of SPLIT_LABELS) {
      const end = offset + quota[label]
      for (const taskId of ids.slice(offset, end)) assignment.push({ taskId, label })
      offset = end
    }
    if (offset !== ids.length) throw new Error(`split: stratum ${stratum.key} was not exhausted`)
  }
  const actual: LabelCounts = { 'dev-observed': 0, 'dev-guard': 0, sealed: 0 }
  for (const row of assignment) actual[row.label] += 1
  if (
    assignment.length !== tasks.length ||
    SPLIT_LABELS.some((label) => actual[label] !== targets[label])
  ) {
    throw new Error('split: global assignment did not meet the exact target margins')
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
