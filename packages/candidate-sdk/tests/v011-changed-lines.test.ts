/**
 * Order-aware changed-line containment contract (issue #54).
 *
 * The changed-line budget must upper-bound the real edit surface: reordering
 * existing lines changes behavior and must consume budget, not cost zero.
 */
import { describe, expect, it } from 'vitest'
import { changedLineCount } from '../src/index.js'

describe('changedLineCount', () => {
  it('unchanged files cost zero', () => {
    expect(changedLineCount('a\nb\nc\n', 'a\nb\nc\n')).toBe(0)
    expect(changedLineCount('', '')).toBe(0)
  })

  it('counts plain additions and removals', () => {
    expect(changedLineCount('a\nb\n', 'a\nb\nc\n')).toBe(1)
    expect(changedLineCount('a\nb\nc\n', 'a\nb\n')).toBe(1)
    expect(changedLineCount('a\nb\n', 'x\ny\n')).toBe(4)
  })

  it('charges reordered existing lines', () => {
    // Full reversal of three unique lines: LCS is 1, so 2 removals + 2 additions.
    expect(changedLineCount('setup()\nrun()\nteardown()\n', 'teardown()\nrun()\nsetup()\n')).toBe(4)
    // Swapping two adjacent lines: LCS is 3 of 4, so 1 removal + 1 addition.
    expect(changedLineCount('a\nb\nc\nd\n', 'a\nc\nb\nd\n')).toBe(2)
    // Block move: moving the tail to the front costs twice the moved block.
    expect(changedLineCount('a\nb\nc\nd\ne\n', 'd\ne\na\nb\nc\n')).toBe(4)
  })

  it('handles duplicate lines deterministically without multiset discounting beyond the LCS', () => {
    // Parent has two equal lines, child three: LCS matches both, one addition.
    expect(changedLineCount('x\nx\n', 'x\nx\nx\n')).toBe(1)
    // Duplicated lines split apart by insertion still match their positions.
    expect(changedLineCount('x\ny\nx\n', 'x\nx\ny\n')).toBe(2)
  })

  it('giant files fail closed with a total-line upper bound', () => {
    const big = `${'line\n'.repeat(6000)}`
    // 6001 x 6001 cells exceed the DP budget; the strict upper bound is the
    // total line count of both files (12002) which always over-counts any edit.
    expect(changedLineCount(big, big)).toBe(12002)
  })
})
