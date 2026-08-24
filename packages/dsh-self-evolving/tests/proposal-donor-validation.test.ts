import { describe, expect, it } from 'vitest'
import { validateProposalBatch } from '../src/index.js'

const parentDigest = `sha256:${'a'.repeat(64)}`

describe('proposal donor validation', () => {
  it('rejects the whole child when any donor digest is malformed', () => {
    const child = {
      proposalId: 'malformed-donor',
      canonicalParentDigest: parentDigest,
      donorCandidates: [`sha256:${'b'.repeat(64)}`, 'not-a-digest'],
      hypothesis: 'Use donor evidence while preserving the canonical parent boundary',
      evidenceRefs: ['evidence://dev/trace'],
      mechanismTests: ['covers donor-derived behavior'],
      preservationTests: ['preserves unrelated behavior'],
      sourceDiff: '+export const changed = true',
    }

    const result = validateProposalBatch({ parentDigest, children: [child] })

    expect(result.accepted).toEqual([])
    expect(result.rejected).toEqual([
      { proposalId: child.proposalId, reason: 'malformed donor not-a-digest' },
    ])
  })
})
