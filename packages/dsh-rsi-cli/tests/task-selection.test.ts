import { describe, expect, it } from 'vitest'
import { selectEfficientObservedTasks } from '../src/index.js'

describe('outcome-blind efficient task selection', () => {
  it('sorts only the published observed inventory by timeout then task id', () => {
    expect(
      selectEfficientObservedTasks(
        ['slow', 'fast-b', 'fast-a'],
        [
          { taskId: 'slow', agentTimeoutSec: 3600 },
          { taskId: 'fast-b', agentTimeoutSec: 900 },
          { taskId: 'sealed-x', agentTimeoutSec: 1 },
          { taskId: 'fast-a', agentTimeoutSec: 900 },
        ],
      ),
    ).toEqual(['fast-a', 'fast-b', 'slow'])
  })

  it('fails closed when an observed task has no valid inventory timeout', () => {
    expect(() => selectEfficientObservedTasks(['missing'], [])).toThrow('invalid inventory task')
  })
})
