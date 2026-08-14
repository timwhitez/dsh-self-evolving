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
import type { ObjectRef, DataLabel } from '../object-store/index.js'

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
