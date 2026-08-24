import { describe, expect, it } from 'vitest'
import {
  deterministicSplit,
  stratify,
  type SplitAssignment,
  type SplitLabel,
  type TaskMeta,
} from '../src/index.js'

const LABELS: readonly SplitLabel[] = ['dev-observed', 'dev-guard', 'sealed']

function tasksForStrata(sizes: number[]): TaskMeta[] {
  return sizes.flatMap((size, stratum) =>
    Array.from({ length: size }, (_, index) => ({
      taskId: `stratum-${String(stratum).padStart(3, '0')}-task-${String(index).padStart(3, '0')}`,
      category: `category-${String(stratum).padStart(3, '0')}`,
      difficulty: stratum % 2 === 0 ? 'medium' : 'hard',
      agentTimeoutSec: 900,
      allowInternet: stratum % 3 === 0,
    })),
  )
}

function targetForLabel(
  sizes: { devObserved: number; devGuard: number; sealed: number },
  label: SplitLabel,
): number {
  if (label === 'dev-observed') return sizes.devObserved
  if (label === 'dev-guard') return sizes.devGuard
  return sizes.sealed
}

function assertControlledRounding(
  tasks: TaskMeta[],
  assignments: SplitAssignment[],
  sizes: { devObserved: number; devGuard: number; sealed: number },
): void {
  const byTask = new Map(assignments.map((row) => [row.taskId, row.label]))
  expect(byTask.size).toBe(tasks.length)
  const totals = { 'dev-observed': 0, 'dev-guard': 0, sealed: 0 }
  for (const row of assignments) totals[row.label] += 1
  expect(totals).toEqual({
    'dev-observed': sizes.devObserved,
    'dev-guard': sizes.devGuard,
    sealed: sizes.sealed,
  })

  for (const stratum of stratify(tasks)) {
    for (const label of LABELS) {
      const count = stratum.taskIds.filter((taskId) => byTask.get(taskId) === label).length
      const numerator = stratum.taskIds.length * targetForLabel(sizes, label)
      const floor = Math.floor(numerator / tasks.length)
      const ceil = Math.ceil(numerator / tasks.length)
      expect(count, `${stratum.key} / ${label}`).toBeGreaterThanOrEqual(floor)
      expect(count, `${stratum.key} / ${label}`).toBeLessThanOrEqual(ceil)
    }
  }
}

describe('globally quota-aware deterministic split', () => {
  it('does not starve the late size-two stratum in the original greedy counterexample', () => {
    const tasks = tasksForStrata([1, 1, 1, 2, 1])
    const sizes = { devObserved: 1, devGuard: 1, sealed: 4 }
    const assignments = deterministicSplit(tasks, 3n, sizes)

    assertControlledRounding(tasks, assignments, sizes)
    const lateIds = new Set(
      tasks.filter((task) => task.category === 'category-003').map((task) => task.taskId),
    )
    expect(
      assignments.filter((row) => lateIds.has(row.taskId) && row.label === 'sealed'),
    ).toHaveLength(1)
  })

  it('controlled-rounds uneven, non-divisible and many-small-strata matrices', () => {
    const fixtures = [
      { strata: [1, 1, 1, 1, 2, 3, 5, 8], sizes: [10, 3, 9] as const },
      { strata: [...Array<number>(24).fill(1), 7, 13], sizes: [20, 5, 19] as const },
      { strata: [2, 3, 4, 5, 6, 7, 8], sizes: [19, 4, 12] as const },
    ]
    for (const [fixtureIndex, fixture] of fixtures.entries()) {
      const tasks = tasksForStrata(fixture.strata)
      const sizes = {
        devObserved: fixture.sizes[0],
        devGuard: fixture.sizes[1],
        sealed: fixture.sizes[2],
      }
      for (const seed of [0n, 1n, 3n, 0xffffffffffffffffn]) {
        assertControlledRounding(
          tasks,
          deterministicSplit(tasks, seed + BigInt(fixtureIndex), sizes),
          sizes,
        )
      }
    }
  })

  it('is invariant to task and stratum input enumeration for one frozen seed', () => {
    const tasks = tasksForStrata([1, 4, 2, 7, 3, 6, 5])
    const sizes = { devObserved: 15, devGuard: 4, sealed: 9 }
    const canonical = deterministicSplit(tasks, 42n, sizes)
    const reversed = deterministicSplit([...tasks].reverse(), 42n, sizes)
    const interleaved = deterministicSplit(
      tasks
        .filter((_, index) => index % 2 === 0)
        .concat(tasks.filter((_, index) => index % 2 === 1)),
      42n,
      sizes,
    )

    expect(reversed).toEqual(canonical)
    expect(interleaved).toEqual(canonical)
  })

  it('keeps delimiter-bearing metadata tuples as distinct canonical strata', () => {
    const tasks: TaskMeta[] = [
      {
        taskId: 'first',
        category: 'a|b',
        difficulty: 'c',
        agentTimeoutSec: 900,
        allowInternet: false,
      },
      {
        taskId: 'second',
        category: 'a',
        difficulty: 'b|c',
        agentTimeoutSec: 900,
        allowInternet: false,
      },
    ]

    expect(stratify(tasks)).toHaveLength(2)
    expect(deterministicSplit(tasks, 7n, { devObserved: 1, devGuard: 0, sealed: 1 })).toHaveLength(
      2,
    )
  })

  it('rejects ambiguous tasks and invalid global margins before allocation', () => {
    const tasks = tasksForStrata([2])
    expect(() => deterministicSplit(tasks, 1n, { devObserved: 1, devGuard: 0, sealed: 0 })).toThrow(
      /expected exactly 1/,
    )
    expect(() =>
      deterministicSplit(tasks, 1n, { devObserved: 1.5, devGuard: 0, sealed: 0.5 }),
    ).toThrow(/non-negative safe integer/)
    expect(() => deterministicSplit([tasks[0]!, tasks[0]!], 1n)).toThrow(/duplicate taskId/)
  })
})
