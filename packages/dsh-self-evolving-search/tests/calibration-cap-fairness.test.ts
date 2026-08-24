import { describe, expect, it } from 'vitest'
import { sampleCalibrationStratum, type TaskMeta } from '../src/index.js'

function oneTaskStrata(): TaskMeta[] {
  return Array.from({ length: 10 }, (_, index) => ({
    taskId: `task-${index}`,
    category: `category-${String(index).padStart(2, '0')}`,
    difficulty: 'medium',
    agentTimeoutSec: 900,
    allowInternet: false,
  }))
}

describe('calibration sampling under a global cap', () => {
  it('uses seeded stratum selection instead of a lexicographic prefix', () => {
    const tasks = oneTaskStrata()
    const first = sampleCalibrationStratum(tasks, 5n, 1, 3).map((task) => task.taskId)
    const replay = sampleCalibrationStratum(tasks, 5n, 1, 3).map((task) => task.taskId)

    expect(first).toEqual(['task-9', 'task-6', 'task-0'])
    expect(replay).toEqual(first)
    expect(first).not.toEqual(['task-0', 'task-1', 'task-2'])
  })

  it('takes one item from each selected stratum before taking a second', () => {
    const tasks = Array.from({ length: 4 }, (_, stratum) =>
      Array.from({ length: 2 }, (_, index) => ({
        taskId: `s${stratum}-${index}`,
        category: `category-${stratum}`,
        difficulty: 'medium',
        agentTimeoutSec: 900,
        allowInternet: false,
      })),
    ).flat()

    const sample = sampleCalibrationStratum(tasks, 11n, 2, 4)
    expect(new Set(sample.map((task) => task.category)).size).toBe(4)
  })
})
