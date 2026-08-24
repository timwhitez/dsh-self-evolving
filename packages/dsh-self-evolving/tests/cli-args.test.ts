import { describe, expect, it } from 'vitest'
import {
  parseCliArguments,
  parseStatusCliArguments,
  requireNoPositionals,
  stringOption,
} from '../src/index.js'

describe('strict CLI argument parser', () => {
  it('does not consume the next long option as a missing value', () => {
    expect(() => parseStatusCliArguments(['--state-dir', '--run-id', 'run-1'])).toThrow(
      /missing required --state-dir/,
    )
  })

  it('rejects duplicate options across separated and inline forms', () => {
    expect(() =>
      parseCliArguments(['--state-dir', '/a', '--state-dir=/b'], {
        '--state-dir': { kind: 'value' },
      }),
    ).toThrow(/duplicate option --state-dir/)
  })

  it('rejects unknown long and short options', () => {
    expect(() => parseCliArguments(['--unknown'], {})).toThrow(/unknown option --unknown/)
    expect(() => parseCliArguments(['-x'], {})).toThrow(/unknown option -x/)
  })

  it('supports inline values and an explicit single-dash value policy', () => {
    const inline = parseCliArguments(['--state-dir=./state'], {
      '--state-dir': { kind: 'value' },
    })
    expect(stringOption(inline, '--state-dir')).toBe('./state')

    const negative = parseCliArguments(['--budget-usd', '-1'], {
      '--budget-usd': { kind: 'value', allowLeadingDash: true },
    })
    expect(stringOption(negative, '--budget-usd')).toBe('-1')

    expect(() =>
      parseCliArguments(['--budget-usd', '-1'], {
        '--budget-usd': { kind: 'value' },
      }),
    ).toThrow(/missing required --budget-usd/)
  })

  it('rejects empty inline values and boolean assignments', () => {
    expect(() =>
      parseCliArguments(['--state-dir='], {
        '--state-dir': { kind: 'value' },
      }),
    ).toThrow(/missing required --state-dir/)
    expect(() =>
      parseCliArguments(['--verbose=true'], {
        '--verbose': { kind: 'boolean' },
      }),
    ).toThrow(/does not accept a value/)
  })

  it('preserves explicit positional termination for callers to validate', () => {
    const parsed = parseCliArguments(['--state-dir', '/state', '--', '--literal'], {
      '--state-dir': { kind: 'value' },
    })
    expect(parsed.positionals).toEqual(['--literal'])
    expect(() => requireNoPositionals(parsed.positionals)).toThrow(/unexpected positional/)
  })
})

describe('status CLI schema', () => {
  it('requires exactly one state directory and run id', () => {
    expect(parseStatusCliArguments(['--state-dir=/state', '--run-id', 'run-1'])).toEqual({
      stateDir: '/state',
      runId: 'run-1',
    })
    expect(() =>
      parseStatusCliArguments(['--state-dir', '/state', '--run-id', 'run-1', '--run-id', 'run-2']),
    ).toThrow(/duplicate option --run-id/)
  })
})
