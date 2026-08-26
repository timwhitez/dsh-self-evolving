/**
 * Handle-quiescence counting contract (issues #40 / #119).
 *
 * Leak detection must be count-aware: a second handle of a constructor that
 * already existed in the baseline is still a leak, and decreasing counts must
 * not mask increases of other types.
 */
import { describe, expect, it } from 'vitest'
import { leakedHandleDelta } from '../src/index.js'

describe('leakedHandleDelta', () => {
  it('reports nothing when counts match the baseline', () => {
    const baseline = new Map([
      ['Socket', 2],
      ['Timeout', 1],
    ])
    const current = new Map([
      ['Socket', 2],
      ['Timeout', 1],
    ])
    expect(leakedHandleDelta(baseline, current)).toEqual([])
  })

  it('detects additional handles of an already-present constructor', () => {
    const baseline = new Map([
      ['Socket', 1],
      ['WriteStream', 2],
    ])
    const current = new Map([
      ['Socket', 2], // the vitest-IPC-style bypass from issue #119
      ['WriteStream', 2],
    ])
    expect(leakedHandleDelta(baseline, current)).toEqual(['Socket(+1)'])
  })

  it('detects new constructor types and multiple deltas', () => {
    const baseline = new Map([['Socket', 1]])
    const current = new Map([
      ['Socket', 3],
      ['ChildProcess', 1],
      ['WriteStream', 1],
    ])
    expect(leakedHandleDelta(baseline, current)).toEqual([
      'ChildProcess(+1)',
      'Socket(+2)',
      'WriteStream(+1)',
    ])
  })

  it('does not flag counts that only decreased', () => {
    const baseline = new Map([
      ['Socket', 4],
      ['Timeout', 2],
    ])
    const current = new Map([['Socket', 1]])
    expect(leakedHandleDelta(baseline, current)).toEqual([])
  })

  it('an empty baseline flags every current handle', () => {
    expect(leakedHandleDelta(new Map(), new Map([['Timeout', 2]]))).toEqual(['Timeout(+2)'])
  })
})
