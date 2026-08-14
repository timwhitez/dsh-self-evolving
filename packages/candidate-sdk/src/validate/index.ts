/**
 * Manifest validators (spec 02 §6, §11 step 2 Schema).
 *
 * Loads the versioned JSON Schemas from schemas/ and compiles them with ajv.
 * The proposer drafts the candidate manifest; the builder RE-validates and
 * never trusts the proposer's self-assigned hashes — it recomputes them.
 */
import { Ajv, type ErrorObject } from 'ajv'
import addFormats from 'ajv-formats'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ajv-formats v3 default export is callable at runtime; the bundled .d.ts does
// not always express that, so we cast through the module namespace.
const addAllFormats = addFormats as unknown as (ajv: Ajv) => void

const here = dirname(fileURLToPath(import.meta.url))
// From lib/validate/ up to repo root, then schemas/.
const schemasRoot = resolve(here, '..', '..', '..', '..', 'schemas')

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

export type ManifestKind = 'candidate' | 'v011-candidate-intent' | 'build' | 'capsule'

const SCHEMA_FILES: Record<ManifestKind, string> = {
  candidate: 'candidate.manifest.schema.json',
  'v011-candidate-intent': 'v011.candidate-intent.schema.json',
  build: 'build.manifest.schema.json',
  capsule: 'capsule.manifest.schema.json',
}

const ajv = new Ajv({ allErrors: true, strict: true })
addAllFormats(ajv)

type ValidateFn = (data: unknown) => boolean
const compiledCache = new Map<ManifestKind, ValidateFn>()

async function getValidator(
  kind: ManifestKind,
): Promise<{ validate: ValidateFn; errors: ErrorObject[] | null }> {
  const cached = compiledCache.get(kind)
  if (cached) {
    return {
      validate: cached,
      errors: (cached as ValidateFn & { errors?: ErrorObject[] }).errors ?? null,
    }
  }
  const schemaPath = resolve(schemasRoot, SCHEMA_FILES[kind])
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'))
  const compiled = ajv.compile(schema) as ValidateFn & { errors?: ErrorObject[] }
  compiledCache.set(kind, compiled)
  return { validate: compiled, errors: compiled.errors ?? null }
}

/** Validate a manifest object against its schema. */
export async function validateManifest(
  kind: ManifestKind,
  manifest: unknown,
): Promise<ValidationResult> {
  const { validate } = await getValidator(kind)
  const valid = validate(manifest)
  if (valid) return { valid: true, errors: [] }
  const validateFn = validate as ValidateFn & { errors?: ErrorObject[] }
  const errors = (validateFn.errors ?? []).map(
    (e: ErrorObject) =>
      `${e.instancePath || '/'}: ${e.message ?? 'invalid'}${e.params ? ' ' + JSON.stringify(e.params) : ''}`,
  )
  return { valid: false, errors }
}

/** Validate a manifest file on disk. */
export async function validateManifestFile(
  kind: ManifestKind,
  absPath: string,
): Promise<ValidationResult> {
  const raw = JSON.parse(await readFile(absPath, 'utf8'))
  return validateManifest(kind, raw)
}
