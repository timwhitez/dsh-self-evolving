import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv'
import addFormats from 'ajv-formats'

export const V011_PROTOCOL = 'dsh-self-evolving-candidate-tree-v2' as const

export type V011SchemaKind =
  | 'proposal'
  | 'analysis'
  | 'candidate-intent'
  | 'mechanism-outcome'
  | 'capability-catalog'
  | 'materialization-receipt'
  | 'admission-receipt'
  | 'migration-receipt'

const SCHEMAS: Record<V011SchemaKind, string> = {
  proposal: 'v011.proposal.schema.json',
  analysis: 'v011.analysis.schema.json',
  'candidate-intent': 'v011.candidate-intent.schema.json',
  'mechanism-outcome': 'v011.mechanism-outcome.schema.json',
  'capability-catalog': 'v011.capability-catalog.schema.json',
  'materialization-receipt': 'v011.materialization-receipt.schema.json',
  'admission-receipt': 'v011.admission-receipt.schema.json',
  'migration-receipt': 'v011.migration-receipt.schema.json',
}

const here = dirname(fileURLToPath(import.meta.url))
function schemaRoot(): string {
  const injected = process.env['DSH_SELF_EVOLVING_V011_SCHEMA_ROOT']
  return injected === undefined ? resolve(here, '..', '..', 'schemas') : resolve(injected)
}
const validators = new Map<V011SchemaKind, ValidateFunction>()
let citationSchema: object | undefined

export interface V011ValidationResult {
  valid: boolean
  errors: string[]
}

async function validator(kind: V011SchemaKind): Promise<ValidateFunction> {
  const current = validators.get(kind)
  if (current !== undefined) return current
  const ajv = new Ajv({ allErrors: true, strict: true })
  ;(addFormats as unknown as (instance: Ajv) => void)(ajv)
  citationSchema ??= JSON.parse(
    await readFile(resolve(schemaRoot(), 'v011.evidence-citation.schema.json'), 'utf8'),
  ) as object
  ajv.addSchema(citationSchema)
  const schema = JSON.parse(await readFile(resolve(schemaRoot(), SCHEMAS[kind]), 'utf8')) as object
  const compiled = ajv.compile(schema)
  validators.set(kind, compiled)
  return compiled
}

export async function validateV011(
  kind: V011SchemaKind,
  value: unknown,
): Promise<V011ValidationResult> {
  const compiled = await validator(kind)
  if (compiled(value)) return { valid: true, errors: [] }
  return {
    valid: false,
    errors: (compiled.errors ?? []).map(
      (error: ErrorObject) =>
        `${error.instancePath || '/'}: ${error.message ?? 'invalid'} ${JSON.stringify(error.params)}`,
    ),
  }
}

export async function assertV011(kind: V011SchemaKind, value: unknown): Promise<void> {
  const result = await validateV011(kind, value)
  if (!result.valid) throw new Error(`v0.1.1 ${kind} schema rejected:\n${result.errors.join('\n')}`)
}

/**
 * Canonical JSON for the V011 hash root (issue #218 hardening):
 *
 * - Keys sort by UTF-16 code unit, never `localeCompare` — identical output
 *   to the previous sort for every ASCII key set (all production schemas),
 *   and locale/ICU-independent for arbitrary keys.
 * - `undefined`-valued keys are SKIPPED, matching JSON.stringify semantics:
 *   an in-memory envelope now digests identically to its JSON round-trip
 *   (previously they diverged via a non-JSON `"key":undefined` emission).
 *   No production digest ever contained an undefined-valued key
 *   (exactOptionalPropertyTypes; JSON.parse cannot produce one).
 * - Non-plain-object leaves (Date/Map/class instances, typed arrays) are
 *   REJECTED instead of silently digesting as `{}` — their content was
 *   unbound. JSON-derived payloads are unaffected; a rejection is a
 *   fail-closed signal, not a compatibility break.
 *
 * Compatibility: verified byte-stable for the production shapes pinned in
 * contract-canonical.test.ts (capability catalogs, loader probe receipts,
 * admission fixed-replay digests, ASCII key permutations).
 */
export function canonicalV011(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalV011).join(',')}]`
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(
      'v0.1.1 canonicalization: non-plain-object leaf — content would be unbound',
    )
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalV011(child)}`)
    .join(',')}}`
}

/**
 * Digest of the schema file backing a validator kind. Rejection records pin
 * this so replay verification can distinguish schema/wording drift from
 * tampering (issue #203).
 */
export async function v011SchemaDigest(kind: V011SchemaKind): Promise<`sha256:${string}`> {
  const bytes = await readFile(resolve(schemaRoot(), SCHEMAS[kind]), 'utf8')
  return digestV011(bytes)
}

export function digestV011(value: string | Uint8Array | unknown): `sha256:${string}` {
  const bytes =
    typeof value === 'string' || value instanceof Uint8Array ? value : canonicalV011(value)
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export function reserveProposalId(input: {
  runId: string
  generation: number
  attempt: number
  parentDigest: string
  exportManifestDigest: string
  capabilityCatalogDigest: string
}): `p_${string}` {
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new Error('v0.1.1 reservation: generation must be positive')
  }
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1 || input.attempt > 3) {
    throw new Error('v0.1.1 reservation: attempt must be in 1..3')
  }
  const digest = createHash('sha256').update(canonicalV011(input)).digest('hex')
  return `p_${digest.slice(0, 32)}`
}

export interface EvidenceCitation {
  objectDigest: `sha256:${string}`
  mediaType: string
  locator:
    | { kind: 'json-pointer'; value: string }
    | { kind: 'jsonl-lines'; startLine: number; endLine: number }
  observation: string
}

export interface TreeOperation {
  op: 'add' | 'modify' | 'remove'
  path: string
}

export interface CapabilityRequest {
  capability: string
  tier: 'T0' | 'T1' | 'T2'
  motivation: string
  evidenceCitations: EvidenceCitation[]
}

export interface V011Proposal {
  schemaVersion: 2
  proposalId: `p_${string}`
  canonicalParentDigest: `sha256:${string}`
  evidenceExport: { manifestDigest: `sha256:${string}`; merkleRoot: `sha256:${string}` }
  donorCandidates: `sha256:${string}`[]
  analysisPath: 'analysis.json'
  hypothesis: string
  evidenceCitations: EvidenceCitation[]
  declaredOperations: TreeOperation[]
  mechanismAssertions: string[]
  preservationAssertions: string[]
  capabilityRequests: CapabilityRequest[]
}
