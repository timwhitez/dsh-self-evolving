import { describe, expect, it } from 'vitest'
import { mapNormalizedStatus } from '../src/index.js'

describe('real normalizer status mapping', () => {
  it.each(['pass', 'fail', 'invalid'] as const)('preserves lowercase %s', (status) => {
    expect(mapNormalizedStatus(status)).toBe(status)
  })

  it('rejects unknown casing instead of silently converting it', () => {
    expect(() => mapNormalizedStatus('PASS')).toThrow('unknown normalized status')
  })
})
