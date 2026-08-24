import { describe, expect, it } from 'vitest'
import { parseDshCliArguments } from '../src/arguments.js'

describe('dsh-self-evolving command argument schemas', () => {
  it('rejects a missing init value before the next recognized option', () => {
    expect(() =>
      parseDshCliArguments('init', [
        '--state-dir',
        '--run-id',
        'run-1',
      ]),
    ).toThrow(/missing required --state-dir/)
  })

  it('rejects duplicate, unknown, and positional arguments', () => {
    expect(() =>
      parseDshCliArguments('status', [
        '--state-dir',
        '/a',
        '--state-dir',
        '/b',
      ]),
    ).toThrow(/duplicate option --state-dir/)
    expect(() =>
      parseDshCliArguments('status', ['--state-dir', '/a', '--typo']),
    ).toThrow(/unknown option --typo/)
    expect(() =>
      parseDshCliArguments('status', ['--state-dir', '/a', 'extra']),
    ).toThrow(/unexpected positional argument/)
  })

  it('accepts inline values and the run-only crash flag', () => {
    const status = parseDshCliArguments('status', ['--state-dir=./state'])
    expect(status.value('--state-dir')).toBe('./state')

    const run = parseDshCliArguments('run', [
      '--state-dir',
      './state',
      '--inject-crash-after-first-candidate',
    ])
    expect(run.flag('--inject-crash-after-first-candidate')).toBe(true)
    expect(() =>
      parseDshCliArguments('resume', [
        '--state-dir',
        './state',
        '--inject-crash-after-first-candidate',
      ]),
    ).toThrow(/unknown option --inject-crash-after-first-candidate/)
  })

  it('passes an explicitly allowed negative budget to semantic validation', () => {
    const parsed = parseDshCliArguments('init', [
      '--run-id',
      'run-1',
      '--state-dir',
      './state',
      '--budget-usd',
      '-1',
    ])
    expect(parsed.value('--budget-usd')).toBe('-1')
  })

  it('rejects missing commands and unsupported commands before parsing options', () => {
    expect(() => parseDshCliArguments(undefined, [])).toThrow(/usage:/)
    expect(() => parseDshCliArguments('stats', ['--state-dir', '/a'])).toThrow(/usage:/)
  })
})
