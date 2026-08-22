import { describe, expect, it } from 'vitest'
import { parseInitProfile } from '../src/init-profile.js'

describe('init profile validation', () => {
  it('uses stable-demo only when the option is omitted or explicitly selected', () => {
    expect(parseInitProfile(undefined)).toBe('stable-demo')
    expect(parseInitProfile('stable-demo')).toBe('stable-demo')
  })

  it('accepts the v0.1.1 profile', () => {
    expect(parseInitProfile('v011-stable-demo')).toBe('v011-stable-demo')
  })

  it('rejects unsupported and misspelled profiles', () => {
    expect(() => parseInitProfile('v011-stable-dem')).toThrow(/unsupported profile/)
    expect(() => parseInitProfile('')).toThrow(/unsupported profile/)
  })
})
