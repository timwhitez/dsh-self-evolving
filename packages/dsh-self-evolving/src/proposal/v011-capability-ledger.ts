import {
  canonicalV011,
  digestV011,
  type CapabilityRequest,
  type FrozenCapabilityCatalog,
} from '@dsh-self-evolving/candidate-sdk'

export interface CapabilityLedgerEntry {
  capability: string
  requestedTier: 'T0' | 'T1' | 'T2'
  count: number
  motivations: string[]
  proposalDigests: `sha256:${string}`[]
  disposition: 'PENDING' | 'DENIED' | 'IGNORED' | 'ENABLED_NEXT_LINEAGE'
}

export interface CapabilityRequestLedger {
  schemaVersion: 1
  currentCatalogDigest: `sha256:${string}`
  entries: CapabilityLedgerEntry[]
  ledgerDigest: `sha256:${string}`
}

/** Canonical protocol order: unsigned UTF-8 bytes, independent of ICU/locale. */
function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

export function aggregateCapabilityRequests(input: {
  currentCatalog: FrozenCapabilityCatalog
  proposals: Array<{ proposalDigest: `sha256:${string}`; requests: CapabilityRequest[] }>
}): CapabilityRequestLedger {
  const groups = new Map<string, CapabilityLedgerEntry>()
  for (const proposal of input.proposals) {
    for (const request of proposal.requests) {
      const key = `${request.capability}\0${request.tier}`
      const entry = groups.get(key) ?? {
        capability: request.capability,
        requestedTier: request.tier,
        count: 0,
        motivations: [],
        proposalDigests: [],
        disposition: 'PENDING' as const,
      }
      entry.count += 1
      if (!entry.motivations.includes(request.motivation)) {
        entry.motivations.push(request.motivation)
      }
      if (!entry.proposalDigests.includes(proposal.proposalDigest)) {
        entry.proposalDigests.push(proposal.proposalDigest)
      }
      groups.set(key, entry)
    }
  }
  const entries = [...groups.values()]
    .map((entry) => ({
      ...entry,
      motivations: [...entry.motivations].sort(compareUtf8),
      proposalDigests: [...entry.proposalDigests].sort(compareUtf8),
    }))
    .sort(
      (left, right) =>
        compareUtf8(left.capability, right.capability) ||
        compareUtf8(left.requestedTier, right.requestedTier),
    )
  const body = {
    schemaVersion: 1 as const,
    currentCatalogDigest: input.currentCatalog.digest,
    entries,
  }
  return { ...body, ledgerDigest: digestV011(canonicalV011(body)) }
}

export function assertCapabilityRequestsDoNotWidenCurrentLineage(input: {
  before: FrozenCapabilityCatalog
  afterRequestProcessing: FrozenCapabilityCatalog
}): void {
  if (input.before.digest !== input.afterRequestProcessing.digest) {
    throw new Error('v0.1.1 capability request illegally changed the current catalog')
  }
}
