/**
 * Evaluation capsule packer (spec 02 §12).
 *
 * Produces a self-contained immutable capsule directory:
 *   capsule/
 *   ├── runtime/        # pinned DSH production closure or verified install manifest
 *   ├── candidate/      # compiled bundle (source + lib)
 *   ├── runner/         # stable ACP application overlay (cordis.patch.yml)
 *   ├── provenance.json # copy of provenance.lock relevant slice
 *   ├── sbom.spdx.json  # dependency SBOM
 *   ├── capsule.json    # capsule manifest
 *   └── SHA256SUMS      # sha256 of every file above
 *
 * The Harbor adapter verifies SHA256SUMS before unpack and again after. The
 * runtime user has read-only access to runtime/ and candidate/.
 */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { BuildReceipt } from './builder-sandbox.js'

export interface CapsuleInput {
  /** Where to write the capsule. */
  outDir: string
  /** Build receipt from the deterministic builder. */
  receipt: BuildReceipt
  /** Candidate source root (for copying the compiled bundle). */
  candidateSourceRoot: string
  /** Runner overlay content (the stable runner's final row restatement). */
  runnerOverlay: string
  /** Provenance slice (JSON string) to embed. */
  provenanceJson: string
  /** SBOM content (JSON string). */
  sbomJson: string
}

export interface CapsuleOutput {
  capsuleDir: string
  capsuleManifestPath: string
  sha256sumsPath: string
  capsuleHash: string
}

/** Recursively hash every regular file under root, writing `relpath  hash`. */
async function writeSha256sums(
  root: string,
  sumsPath: string,
): Promise<{ entries: Map<string, string>; hash: string }> {
  const entries: string[] = []
  const map = new Map<string, string>()
  async function walk(dir: string): Promise<void> {
    const names = await readdir(dir, { withFileTypes: true })
    for (const e of names) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) await walk(abs)
      else if (e.isFile()) {
        const content = await readFile(abs)
        const rel = relative(root, abs)
        const h = createHash('sha256').update(content).digest('hex')
        entries.push(`${h}  ${rel}`)
        map.set(rel, h)
      }
    }
  }
  await walk(root)
  entries.sort()
  const body = entries.join('\n') + '\n'
  await writeFile(sumsPath, body)
  const hash = createHash('sha256').update(body).digest('hex')
  return { entries: map, hash }
}

/** Copy a candidate's compiled bundle (src + lib + manifest files) into capsule/candidate. */
async function copyCandidate(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true })
  const items = [
    'src',
    'lib',
    'package.json',
    'candidate.json',
    'cordis.patch.yml',
    'tsconfig.json',
  ]
  for (const item of items) {
    const from = join(src, item)
    const st = await stat(from).catch(() => null)
    if (!st) continue
    if (st.isDirectory()) {
      await copyDir(from, join(dest, item))
    } else {
      await copyFile(from, join(dest, item))
    }
  }
}

async function copyDir(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true })
  const names = await readdir(src, { withFileTypes: true })
  for (const e of names) {
    const from = join(src, e.name)
    const to = join(dest, e.name)
    if (e.isDirectory()) await copyDir(from, to)
    else if (e.isFile()) await copyFile(from, to)
  }
}

/**
 * Pack a complete evaluation capsule. Returns paths and the SHA256SUMS hash.
 */
export async function packCapsule(input: CapsuleInput): Promise<CapsuleOutput> {
  const { outDir, receipt, candidateSourceRoot, runnerOverlay, provenanceJson, sbomJson } = input
  await mkdir(outDir, { recursive: true })

  // runtime/ — for Gate 1 we record an install-manifest reference; the pinned
  // production closure is materialized by the Harbor adapter at task time.
  const runtimeDir = join(outDir, 'runtime')
  await mkdir(runtimeDir, { recursive: true })
  await writeFile(
    join(runtimeDir, 'INSTALL.md'),
    '# Runtime\n\nResolved at task time from the pinned DSH provenance in provenance.json.\n',
  )

  // candidate/
  await copyCandidate(candidateSourceRoot, join(outDir, 'candidate'))

  // runner/
  const runnerDir = join(outDir, 'runner')
  await mkdir(runnerDir, { recursive: true })
  await writeFile(join(runnerDir, 'cordis.patch.yml'), runnerOverlay)

  // provenance.json, sbom.spdx.json
  await writeFile(join(outDir, 'provenance.json'), provenanceJson)
  await writeFile(join(outDir, 'sbom.spdx.json'), sbomJson)

  // SHA256SUMS (written last, covers everything except itself).
  const sumsPath = join(outDir, 'SHA256SUMS')
  const { hash } = await writeSha256sums(outDir, sumsPath)

  // capsule.json manifest (must be written AFTER SHA256SUMS so the sums can
  // record it; re-write sums to include capsule.json, then recompute).
  const capsuleManifest = {
    schemaVersion: 1,
    candidateId: receipt.candidateId,
    runtime: { kind: 'install-manifest', ref: 'runtime/INSTALL.md', hash: null },
    candidate: { bundleHash: receipt.bundleHash },
    runner: { overlay: 'runner/cordis.patch.yml' },
    provenance: { ref: 'provenance.json' },
    sbom: { ref: 'sbom.spdx.json' },
    sha256sums: { ref: 'SHA256SUMS', hash },
  }
  const manifestPath = join(outDir, 'capsule.json')
  await writeFile(manifestPath, JSON.stringify(capsuleManifest, null, 2) + '\n')

  // Recompute SHA256SUMS to include capsule.json.
  const finalSums = await writeSha256sums(outDir, sumsPath)
  return {
    capsuleDir: outDir,
    capsuleManifestPath: manifestPath,
    sha256sumsPath: sumsPath,
    capsuleHash: finalSums.hash,
  }
}
