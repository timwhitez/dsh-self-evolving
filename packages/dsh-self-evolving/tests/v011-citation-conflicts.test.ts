import { describe, expect, it } from 'vitest'
import type { EvidenceCitation } from '@dsh-self-evolving/candidate-sdk'
import { deduplicateEvidenceCitations } from '../src/proposal/v011-materializer.js'

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`
}

function citation(overrides: Partial<EvidenceCitation> = {}): EvidenceCitation {
  return {
    objectDigest: digest('a'),
    mediaType: 'application/json',
    locator: { kind: 'json-pointer', value: '/result' },
    observation: 'the result reports a verifier failure',
    ...overrides,
  }
}

describe('v0.1.1 evidence citation deduplication', () => {
  it('collapses only byte-identical duplicate claims', () => {
    const original = citation()
    const duplicate = citation()

    expect(deduplicateEvidenceCitations([original, duplicate])).toEqual([original])
  })

  it('rejects a conflicting media type at the same immutable location', () => {
    expect(() =>
      deduplicateEvidenceCitations([
        citation(),
        citation({ mediaType: 'application/vnd.dsh-self-evolving.trajectory+json' }),
      ]),
    ).toThrow(/conflicting evidence citation/)
  })

  it('rejects a conflicting observation at the same immutable location', () => {
    expect(() =>
      deduplicateEvidenceCitations([
        citation(),
        citation({ observation: 'the same bytes instead prove success' }),
      ]),
    ).toThrow(/conflicting evidence citation/)
  })

  it('keeps distinct locations from the same object', () => {
    const first = citation()
    const second = citation({
      locator: { kind: 'json-pointer', value: '/other' },
      observation: 'the other field records additional context',
    })

    expect(deduplicateEvidenceCitations([first, second])).toEqual([first, second])
  })

  it('uses canonical locator encoding rather than object insertion order', () => {
    const first = citation({
      locator: { kind: 'jsonl-lines', startLine: 1, endLine: 2 },
    })
    const sameLocatorDifferentConstruction = citation({
      locator: { endLine: 2, startLine: 1, kind: 'jsonl-lines' },
    })

    expect(
      deduplicateEvidenceCitations([first, sameLocatorDifferentConstruction]),
    ).toEqual([first])
  })
})
