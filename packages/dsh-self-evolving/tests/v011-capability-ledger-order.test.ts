import { describe, expect, it } from 'vitest'
import {
  V011_PROTOCOL,
  type CapabilityRequest,
  type FrozenCapabilityCatalog,
} from '@dsh-self-evolving/candidate-sdk'
import { aggregateCapabilityRequests } from '../src/proposal/v011-capability-ledger.js'

const currentCatalog: FrozenCapabilityCatalog = {
  catalog: {
    schemaVersion: 1,
    protocol: V011_PROTOCOL,
    dshCommit: 'fixture',
    capabilities: [],
  },
  digest: `sha256:${'a'.repeat(64)}`,
}

function request(
  capability: string,
  tier: CapabilityRequest['tier'],
  motivation: string,
): CapabilityRequest {
  return {
    capability,
    tier,
    motivation,
    evidenceCitations: [],
  }
}

const proposals = [
  {
    proposalDigest: `sha256:${'3'.repeat(64)}` as const,
    requests: [
      request('i-capability', 'T2', 'z-motivation'),
      request('shared-capability', 'T2', 'later tier'),
    ],
  },
  {
    proposalDigest: `sha256:${'1'.repeat(64)}` as const,
    requests: [
      request('I-capability', 'T1', 'upper-case capability'),
      request('shared-capability', 'T0', 'earlier tier'),
    ],
  },
  {
    proposalDigest: `sha256:${'2'.repeat(64)}` as const,
    requests: [
      request('shared-capability', 'T2', 'A-motivation'),
      request('é-capability', 'T0', 'non-ASCII capability'),
    ],
  },
]

function permutations<T>(values: T[]): T[][] {
  if (values.length <= 1) return [values]
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((rest) => [
      value,
      ...rest,
    ]),
  )
}

describe('capability request ledger canonical ordering', () => {
  it('produces identical canonical bytes and digest for every proposal permutation', () => {
    const expected = aggregateCapabilityRequests({ currentCatalog, proposals })

    for (const proposalOrder of permutations(proposals)) {
      const actual = aggregateCapabilityRequests({
        currentCatalog,
        proposals: proposalOrder.map((proposal) => ({
          ...proposal,
          requests: [...proposal.requests].reverse(),
        })),
      })
      expect(actual).toEqual(expected)
      expect(JSON.stringify(actual)).toBe(JSON.stringify(expected))
      expect(actual.ledgerDigest).toBe(expected.ledgerDigest)
    }
  })

  it('orders the complete tuple and nested strings by unsigned UTF-8 bytes', () => {
    const ledger = aggregateCapabilityRequests({ currentCatalog, proposals })

    expect(ledger.entries.map((entry) => `${entry.capability}:${entry.requestedTier}`)).toEqual([
      'I-capability:T1',
      'i-capability:T2',
      'shared-capability:T0',
      'shared-capability:T2',
      'é-capability:T0',
    ])
    const repeated = ledger.entries.find(
      (entry) => entry.capability === 'shared-capability' && entry.requestedTier === 'T2',
    )
    expect(repeated?.motivations).toEqual(['A-motivation', 'later tier'])
    expect(repeated?.proposalDigests).toEqual([
      `sha256:${'2'.repeat(64)}`,
      `sha256:${'3'.repeat(64)}`,
    ])
  })

  it('totally orders distinct strings whose UTF-8 replacement bytes collide', () => {
    const first = {
      proposalDigest: `sha256:${'1'.repeat(64)}` as const,
      requests: [request('shared-capability', 'T1', '\ud800')],
    }
    const second = {
      proposalDigest: `sha256:${'2'.repeat(64)}` as const,
      requests: [request('shared-capability', 'T1', '\ud801')],
    }

    const forward = aggregateCapabilityRequests({
      currentCatalog,
      proposals: [first, second],
    })
    const reverse = aggregateCapabilityRequests({
      currentCatalog,
      proposals: [second, first],
    })

    expect(forward).toEqual(reverse)
    expect(forward.ledgerDigest).toBe(reverse.ledgerDigest)
    expect(forward.entries[0]?.motivations).toEqual(['\ud800', '\ud801'])
  })
})
