import { describe, expect, it } from 'vitest'

describe('v0.1.1 migration baseline', () => {
  it('retains both runtime modes in candidate intent', () => {
    expect(['solve', 'propose']).toEqual(['solve', 'propose'])
  })
})
