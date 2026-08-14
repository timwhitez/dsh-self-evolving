import { describe, expect, it } from 'vitest'
import { selectEfficientObservedTasks, selectFailureSeekingObservedTasks } from '../src/index.js'

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

  it('freezes v0.1.1 failure discovery by public difficulty, timeout, then task id', () => {
    expect(
      selectFailureSeekingObservedTasks(
        ['medium', 'hard-slow', 'easy', 'hard-fast-b', 'hard-fast-a'],
        [
          { taskId: 'easy', difficulty: 'easy', agentTimeoutSec: 300 },
          { taskId: 'medium', difficulty: 'medium', agentTimeoutSec: 300 },
          { taskId: 'hard-slow', difficulty: 'hard', agentTimeoutSec: 1800 },
          { taskId: 'hard-fast-b', difficulty: 'hard', agentTimeoutSec: 900 },
          { taskId: 'hard-fast-a', difficulty: 'hard', agentTimeoutSec: 900 },
        ],
      ),
    ).toEqual(['hard-fast-a', 'hard-fast-b', 'hard-slow', 'medium', 'easy'])
  })
})
