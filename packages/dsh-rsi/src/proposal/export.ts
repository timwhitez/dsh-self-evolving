/**
 * Label-filtered evidence export (spec 06 §11, spec 05 §5.2).
 *
 * Export takes (principal, purpose, query) and materializes a read-only,
 * action-scoped directory containing only objects whose label is in the
 * principal's allowed set. It produces a manifest with a Merkle root over the
 * included objects AND a guard/sealed canary ABSENCE receipt proving no
 * GUARDED/SEALED object leaked into a proposer view.
 *
 * The proposer cannot self-serve files from evidence/runs — it only sees this
 * filtered export.
 */
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, open, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  readRefBytes,
  type ObjectStore,
  type ObjectRef,
  type DataLabel,
} from '../object-store/index.js'

export interface ExportEntry {
  digest: string
  label: DataLabel
  mediaType: string
}

export interface ExportManifest {
  exportId: string
  principal: string
  purpose: string
  allowedLabels: DataLabel[]
  objects: ExportEntry[]
  createdFromStateHash: string | null
  merkleRoot: string
  /** Receipt proving no disallowed-label object was included. */
  canaryAbsenceReceipt: {
    checked: number
    excluded: number
    /** sha256 of the list of excluded digests (audit trail). */
    excludedHash: string
  }
}

/**
 * Build an export manifest from a candidate object set, filtering by label.
 * GUARDED and SEALED objects are NEVER included in a proposer export.
 */
export function buildExport(input: {
  exportId: string
  principal: string
  purpose: string
  allowedLabels: DataLabel[]
  objects: ObjectRef[]
  createdFromStateHash: string | null
}): ExportManifest {
  const allowed = new Set(input.allowedLabels)
  const included: ExportEntry[] = []
  const excluded: string[] = []
  for (const obj of input.objects) {
    if (allowed.has(obj.label)) {
      included.push({ digest: obj.digest, label: obj.label, mediaType: obj.mediaType })
    } else {
      excluded.push(obj.digest)
    }
  }
  // Deterministic order for a stable Merkle root.
  included.sort((a, b) => a.digest.localeCompare(b.digest))
  excluded.sort()
  const merkleRoot = merkle(included.map((e) => e.digest))
  const excludedHash = createHash('sha256').update(excluded.join('\n')).digest('hex')
  return {
    exportId: input.exportId,
    principal: input.principal,
    purpose: input.purpose,
    allowedLabels: input.allowedLabels,
    objects: included,
    createdFromStateHash: input.createdFromStateHash,
    merkleRoot,
    canaryAbsenceReceipt: {
      checked: input.objects.length,
      excluded: excluded.length,
      excludedHash,
    },
  }
}

/** Verify a manifest's Merkle root matches its objects (tamper-evidence). */
export function verifyExport(manifest: ExportManifest): boolean {
  const recomputed = merkle([...manifest.objects].map((o) => o.digest).sort())
  return recomputed === manifest.merkleRoot
}

/** Simple Merkle root over sha256 leaves with a domain separator. */
function merkle(leaves: string[]): string {
  if (leaves.length === 0) return createHash('sha256').update('empty').digest('hex')
  let layer = leaves.map((l) =>
    createHash('sha256')
      .update('leaf:' + l)
      .digest('hex'),
  )
  while (layer.length > 1) {
    const next: string[] = []
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i]!
      const right = layer[i + 1] ?? left
      next.push(
        createHash('sha256')
          .update(left + right)
          .digest('hex'),
      )
    }
    layer = next
  }
  return 'sha256:' + layer[0]!
}

/**
 * Canary absence check: scan a blob of text (e.g. a proposer transcript) for a
 * set of guard/sealed canary tokens. Returns the list of leaked canaries
 * (empty = clean). A non-empty result is an information-flow incident.
 */
export function scanForCanaryLeaks(
  text: string,
  canaries: { id: string; token: string }[],
): string[] {
  const leaked: string[] = []
  for (const c of canaries) {
    if (text.includes(c.token)) leaked.push(c.id)
  }
  return leaked
}

export interface MaterializeProposerExportInput {
  store: ObjectStore
  outDir: string
  exportId: string
  principal: `proposer:${string}`
  objects: ObjectRef[]
  createdFromStateHash: string | null
}

/**
 * Materialize one atomic, read-only proposer view. Label policy is fixed here,
 * not supplied by the proposer. Full immutable refs are checked against the
 * store before any bytes are published into the view.
 */
export async function materializeProposerExport(
  input: MaterializeProposerExportInput,
): Promise<ExportManifest> {
  if (!input.principal.startsWith('proposer:') || input.principal.length <= 'proposer:'.length) {
    throw new Error('proposal export: action-scoped proposer principal required')
  }
  const output = resolve(input.outDir)
  if ((await stat(output).catch(() => null)) !== null) {
    throw new Error(`proposal export: destination already exists: ${output}`)
  }
  await mkdir(dirname(output), { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(join(dirname(output), '.proposal-export-'))
  try {
    const manifest = buildExport({
      exportId: input.exportId,
      principal: input.principal,
      purpose: 'candidate-expansion',
      allowedLabels: ['PUBLIC_SPEC', 'DEV_OBSERVED'],
      objects: input.objects,
      createdFromStateHash: input.createdFromStateHash,
    })
    const objectDir = join(staging, 'objects')
    await mkdir(objectDir, { mode: 0o700 })
    const refs = new Map(input.objects.map((ref) => [ref.digest, ref]))
    for (const entry of manifest.objects) {
      const ref = refs.get(entry.digest)
      if (ref === undefined) throw new Error(`proposal export: missing ref ${entry.digest}`)
      const bytes = await readRefBytes(input.store, ref)
      const file = await open(join(objectDir, entry.digest), 'wx', 0o400)
      try {
        await file.writeFile(bytes)
        await file.sync()
      } finally {
        await file.close()
      }
    }
    const manifestFile = await open(join(staging, 'manifest.json'), 'wx', 0o400)
    try {
      await manifestFile.writeFile(JSON.stringify(manifest, null, 2) + '\n')
      await manifestFile.sync()
    } finally {
      await manifestFile.close()
    }
    await chmod(objectDir, 0o500)
    await chmod(staging, 0o500)
    await rename(staging, output)
    return manifest
  } catch (error) {
    await chmod(staging, 0o700).catch(() => {})
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}
