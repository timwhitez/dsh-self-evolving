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
    // Pinned BEFORE the hardening with the localeCompare-based sorter. These
    // key sets order identically under both sorts, so their digests must
    // never move. (The splitReveal key set is the one production shape that
    // DID move — see the divergence-documented test below.)
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

  it('pins the splitReveal shape whose commitment digest intentionally moved (issue #218)', () => {
    const sha256 = (character: string) => `sha256:${character.repeat(64)}`
    const splitReveal = {
      commitmentVerified: true,
      merkleRoot: sha256('1'),
      revealReceiptHash: sha256('2'),
      revealCount: 1,
      preLockSealedAccessCount: 0,
      revealedTaskIds: ['task-060', 'task-061'],
      revealedAssignment: [
        { taskId: 'task-000', label: 'dev-observed' },
        { taskId: 'task-060', label: 'sealed' },
      ],
      commitment: {
        seedCommitment: sha256('3'),
        taskInventoryDigest: sha256('4'),
        sizes: { devObserved: 48, devGuard: 12, sealed: 29 },
      },
      inventoryTaskIds: ['task-000', 'task-060'],
    }
    // This key set is the ONE production shape where the localeCompare and
    // code-unit orders differ ('revealReceiptHash' vs 'revealed*'): its
    // canonical form INTENTIONALLY moved with the #218 hardening. Old
    // (localeCompare) digest of this payload:
    //   sha256:2e3971f0f82c9d2a31da615fc7e13eb924489233f469632bce3629bacdd36d0e
    // No recorded gate8 evidenceCommitment predates this change (the gate8
    // evidence status is BLOCKED_NOT_STARTED), so nothing archived diverges.
    expect(digestV011(canonicalV011(splitReveal))).toBe(
      'sha256:d1bc29a8334f0bbea55b5b3e8fff8fd2217ff2658313cfa9357501b2005f26f0',
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

describe('capability catalog order (issue #234)', () => {
  it('sorts capability rows bytewise and pins the moved mixed-case digest', async () => {
    const { freezeCapabilityCatalog } = await import('../src/v011/capability.js')
    const sha256 = (character: string) =>
      `sha256:${character.repeat(64)}` as `sha256:${string}`
    const catalog = {
      schemaVersion: 1 as const,
      protocol: 'dsh-self-evolving-candidate-tree-v2',
      dshCommit: 'a'.repeat(40),
      capabilities: [
        { id: 'b-cap', tier: 'T1' as const, kind: 'tool' as const, signature: 'x', enabled: true, fixtureDigest: sha256('1') },
        { id: 'A-cap', tier: 'T2' as const, kind: 'service' as const, signature: 'y', enabled: false, fixtureDigest: null },
        { id: 'a_cap', tier: 'T1' as const, kind: 'package-export' as const, signature: 'z', enabled: false, fixtureDigest: null },
        { id: 'Z9', tier: 'T1' as const, kind: 'event' as const, signature: 'w', enabled: false, fixtureDigest: null },
      ],
    }
    const frozen = await freezeCapabilityCatalog(catalog)
    expect(frozen.catalog.capabilities.map((row) => row.id)).toEqual([
      'A-cap',
      'Z9',
      'a_cap',
      'b-cap',
    ])
    // Mixed-case ids are the divergence case: under the previous
    // localeCompare row order this catalog digested as
    //   sha256:34b1a3b1506add67894a84d2df3857b8aa2f19220dc186ba597eeb0a207bb601
    // The bytewise order intentionally moved it. The PRODUCTION id set
    // (agent/request, candidate-internal-composition, systemPrompt,
    // tools/pre-execute, tools/result) orders identically under both, so no
    // recorded catalog digest changes.
    expect(frozen.digest).toBe(
      'sha256:63857175e4fdf301fabea0ebbe5749c13ecab7f69ad1dcecc4c9196a4effc25b',
    )
  })
})
