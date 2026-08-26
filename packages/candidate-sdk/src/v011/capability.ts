import { readFile } from 'node:fs/promises'
import { assertV011, canonicalV011, digestV011 } from './contract.js'
import type { V011_PROTOCOL } from './contract.js'

export type CapabilityTier = 'T0' | 'T1' | 'T2' | 'T3'

export interface ExactCapability {
  id: string
  tier: CapabilityTier
  kind: 'package-export' | 'service' | 'event' | 'tool' | 'composition'
  signature: string
  enabled: boolean
  fixtureDigest: `sha256:${string}` | null
}

export interface CapabilityCatalog {
  schemaVersion: 1
  protocol: typeof V011_PROTOCOL
  dshCommit: string
  capabilities: ExactCapability[]
}

export interface FrozenCapabilityCatalog {
  catalog: CapabilityCatalog
  digest: `sha256:${string}`
}

export async function freezeCapabilityCatalog(
  catalog: CapabilityCatalog,
): Promise<FrozenCapabilityCatalog> {
  const normalized: CapabilityCatalog = {
    ...catalog,
    capabilities: [...catalog.capabilities].sort((left, right) => left.id.localeCompare(right.id)),
  }
  await assertV011('capability-catalog', normalized)
  const ids = normalized.capabilities.map((row) => row.id)
  if (new Set(ids).size !== ids.length)
    throw new Error('v0.1.1 catalog: duplicate exact capability')
  for (const capability of normalized.capabilities) {
    if (capability.tier === 'T3' && capability.enabled) {
      throw new Error(`v0.1.1 catalog: privileged capability cannot be enabled: ${capability.id}`)
    }
    if (capability.enabled && capability.fixtureDigest === null) {
      throw new Error(`v0.1.1 catalog: enabled capability lacks fixture receipt: ${capability.id}`)
    }
  }
  return { catalog: normalized, digest: digestV011(canonicalV011(normalized)) }
}

export interface RuntimeCapabilityBindings {
  requiredServices: ExactCapability[]
  optionalServices: ExactCapability[]
  newTools: ExactCapability[]
}

/**
 * Resolve a candidate's runtime intent against the frozen catalog.
 *
 * Every intent field must resolve to an *enabled* catalog entry of the exact
 * semantic kind: services for required/optional services and tools for new
 * tool names. A same-ID capability of a different kind (issue #81) fails
 * closed instead of silently satisfying a service/tool contract.
 */
export function assertRuntimeIntentAgainstCatalog(
  intent: { requiredServices: string[]; optionalServices: string[]; newToolNames: string[] },
  frozen: FrozenCapabilityCatalog,
): RuntimeCapabilityBindings {
  const byId = new Map(frozen.catalog.capabilities.map((row) => [row.id, row]))
  const resolve = (ids: string[], kind: 'service' | 'tool', field: string): ExactCapability[] =>
    ids.map((id) => {
      const row = byId.get(id)
      if (row === undefined) {
        throw new Error(`v0.1.1 catalog: candidate requests unavailable capability ${id}`)
      }
      if (!row.enabled) {
        throw new Error(`v0.1.1 catalog: candidate requests disabled capability ${id}`)
      }
      if (row.kind !== kind) {
        throw new Error(`v0.1.1 catalog: ${field} ${id} is a ${row.kind}, not a ${kind}`)
      }
      return row
    })
  return {
    requiredServices: resolve(intent.requiredServices, 'service', 'requiredServices'),
    optionalServices: resolve(intent.optionalServices, 'service', 'optionalServices'),
    newTools: resolve(intent.newToolNames, 'tool', 'newToolNames'),
  }
}

export async function fixtureDigest(path: string): Promise<`sha256:${string}`> {
  return digestV011(await readFile(path))
}
