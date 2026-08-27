/**
 * Canonicalizer contract (issue #218): the V011 hash root must be
 * environment-independent, must not silently unbind content, and must keep
 * byte-stable digests for every production payload shape.
 */
import { describe, expect, it } from 'vitest'
import { canonicalV011, digestV011 } from '../src/index.js'

const sha = (character: string) => `sha256:${character.repeat(64)}`

describe('canonicalV011 (issue #218)', () => {
  it('keeps byte-stable digests for the production payload shapes', () => {
    // Pinned BEFORE the hardening with the localeCompare-based sorter; every
    // production key set orders identically under code-unit sorting, so these
    // digests must never move.
    expect(
      digestV011(canonicalV011({ b: 1, a: 2, c: { z: 'x', y: 3 } })),
    ).toBe('sha256:2404ab67f81ea007ec105d6213cfb8d54970e61587cb65633adc2690b0c94515')
    expect(digestV011(canonicalV011([3, 1, { q: null, p: 's' }]))).toBe(
      'sha256:a393560fca81b46b9258961081fbf5d7b9a57ccb820f111b39a5913aeec09025',
    )
    expect(
      digestV011(
        canonicalV011({
          candidateId: sha('a'),
          mode: 'solve',
          schemaVersion: 1,
          replayDigest: sha('b'),
          promptSections: [],
          componentInventory: [],
        }),
      ),
    ).toBe('sha256:b249dfc3180d4fec2c41fb5cce8887c799f1eb9a37b8bf29de67a0a6898f3445')
    expect(
      digestV011(canonicalV011({ solve: sha('c'), propose: sha('d') })),
    ).toBe('sha256:af59c1680f1a2568c893b5534d139d35c6c5ee983410030125b37ddf69b6ae0c')
    expect(digestV011('plain string value')).toBe(
      'sha256:caaad2395bebdc8898ccd2b82b2106d1efd6057cbad7b0c5b71b13291947a34f',
    )
    expect(digestV011(new Uint8Array([1, 2, 3, 4]))).toBe(
      'sha256:9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a',
    )
  })

  it('sorts non-ASCII keys deterministically by UTF-16 code unit', () => {
    const keys = ['z', '\u00e9', 'a', '\u4e2d']
    const canonical = canonicalV011({
      z: 1,
      '\u00e9': 2,
      a: 3,
      '\u4e2d': 4,
    })
    // Code-unit order: 'a'(97) < 'z'(122) < '\u00e9'(233) < '\u4e2d'(20013) —
    // localeCompare could disagree; the canonical form must not.
    expect(canonical).toBe('{"a":3,"z":1,"\u00e9":2,"\u4e2d":4}')
    void keys
  })

  it('rejects non-plain-object leaves instead of digesting them as {}', () => {
    expect(() => canonicalV011({ at: new Date(0) })).toThrow(/non-plain-object leaf/)
    expect(() => canonicalV011({ at: new Map() })).toThrow(/non-plain-object leaf/)
    expect(() => canonicalV011({ at: new Uint8Array([1]) })).toThrow(/non-plain-object leaf/)
    class Boxed {
      value = 1
    }
    expect(() => canonicalV011({ at: new Boxed() })).toThrow(/non-plain-object leaf/)
    // Two records differing only in rejected-leaf content can never collide.
    expect(() => canonicalV011([{ d: new Date(0) }, { d: new Date(1) }])).toThrow(
      /non-plain-object leaf/,
    )
  })

  it('skips undefined-valued keys so in-memory digests equal JSON round-trips', () => {
    const withUndefined: Record<string, unknown> = { a: 1, b: undefined, c: null }
    const roundTrip = JSON.parse(JSON.stringify(withUndefined))
    expect(canonicalV011(withUndefined)).toBe(canonicalV011(roundTrip))
    expect(canonicalV011(withUndefined)).toBe('{"a":1,"c":null}')
  })

  it('treats null-prototype objects as plain (JSON.parse-compatible)', () => {
    const nullProto = Object.create(null)
    nullProto['b'] = 1
    nullProto['a'] = 2
    expect(canonicalV011(nullProto)).toBe('{"a":2,"b":1}')
  })
})
