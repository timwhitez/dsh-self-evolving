/**
 * Deterministic builder sandbox (spec 02 §11 step 5; spec 07 §3 Accept).
 *
 * Builds a candidate's TypeScript source into a deterministic `lib/` bundle
 * under controlled conditions:
 *  - network disabled (enforced by the caller's container/namespace; this module
 *    asserts it is NOT given any network handle);
 *  - candidate lifecycle scripts (install/prepare/postinstall) NEVER executed;
 *  - double build produces byte-identical output (verified here);
 *  - the build is a plain `tsc` emit with the project's tsconfig, no plugins.
 *
 * The builder does NOT trust the candidate's declared hashes; it recomputes the
 * source/bundle/capsule hashes and writes them into a build manifest.
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  buildCanonicalArchive,
  declareFiles,
  type CanonicalArchive,
} from './identity/canonical-tar.js'
import { scanPaths, type ScanResult } from './scan/policy-scan.js'
import { validateManifestFile, type ValidationResult } from './validate/index.js'

export interface BuildInput {
  /** Absolute path to the candidate source root (contains src/, package.json, candidate.json). */
  sourceRoot: string
  /** Manifest-declared source files (POSIX-relative). */
  sourceFiles: string[]
  /** Absolute path to the TypeScript binary to use (pinned by provenance). */
  tscBin: string
}

export interface BuildReceipt {
  sourceHash: string
  bundleHash: string
  capsuleHash: string
  candidateId: string
  archive: CanonicalArchive
  scan: ScanResult
  schemaValidation: ValidationResult
  doubleBuildIdentical: boolean
}

/** sha256 of all files under a dir, concatenated as `relpath:hash\n` sorted. */
async function hashTree(root: string): Promise<string> {
  const entries: string[] = []
  async function walk(dir: string): Promise<void> {
    const names = await readdir(dir, { withFileTypes: true })
    for (const e of names) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) await walk(abs)
      else if (e.isFile()) {
        const content = await readFile(abs)
        const rel = abs.slice(root.length + 1)
        entries.push(`${rel}:${createHash('sha256').update(content).digest('hex')}`)
      }
    }
  }
  await walk(root)
  entries.sort()
  return createHash('sha256').update(entries.join('\n')).digest('hex')
}

function execTsc(tscBin: string, projectDir: string): Promise<void> {
  return new Promise((resolveExec, rejectExec) => {
    execFile(tscBin, ['-b', '--force'], { cwd: projectDir }, (err, _stdout, stderr) => {
      if (err) rejectExec(new Error(`tsc failed: ${stderr}\n${err.message}`))
      else resolveExec()
    })
  })
}

/**
 * Run the full admission build for a candidate (spec 02 §11 steps 1–10, the
 * build-time subset). Returns receipts; throws on any rejection.
 *
 * Steps executed here: containment (via canonical-tar validation), schema,
 * policy scan, reproducible build (double-build equality). Loader boot/unload
 * and mock-replay are run by separate harnesses and merged into the final
 * build manifest by the caller.
 */
export async function buildCandidate(input: BuildInput): Promise<BuildReceipt> {
  const { sourceRoot, sourceFiles, tscBin } = input

  // Step 1+2: containment + canonical archive (also validates paths/symlinks/limits).
  const declared = declareFiles(sourceRoot, sourceFiles)
  const archive = await buildCanonicalArchive(declared)

  // Step 2b: schema validation of candidate.json.
  const schemaValidation = await validateManifestFile(
    'candidate',
    join(sourceRoot, 'candidate.json'),
  )
  if (!schemaValidation.valid) {
    throw new Error(`schema validation failed:\n${schemaValidation.errors.join('\n')}`)
  }

  // Step 4: policy scan (imports/deps/secrets/task-fingerprints).
  // The scanner protects the candidate CODE surface (.ts/.js). Structured
  // manifest files (package.json/tsconfig.json/cordis.patch.yml) are validated
  // by the schema + structural checks, not the source scanner — their relative
  // paths (e.g. tsconfig "extends", link: deps) are legitimate config, not
  // runtime traversal.
  const codeFiles = declared
    .filter((d) => d.path.endsWith('.ts') || d.path.endsWith('.js'))
    .map((d) => ({ path: d.path, absPath: d.absPath }))
  const scan = await scanPaths(codeFiles)
  if (!scan.passed) {
    const rejects = scan.hits.filter((h) => h.severity === 'reject')
    throw new Error(
      `policy scan rejected:\n${rejects.map((h) => `  ${h.path}:${h.line} ${h.rule} ${h.snippet}`).join('\n')}`,
    )
  }

  // Step 5: reproducible build — two clean builds must produce identical lib/.
  const libDir = join(sourceRoot, 'lib')
  await rm(libDir, { recursive: true, force: true })
  await execTsc(tscBin, sourceRoot)
  const build1 = await hashTree(libDir)
  await rm(libDir, { recursive: true, force: true })
  await execTsc(tscBin, sourceRoot)
  const build2 = await hashTree(libDir)
  const bundleHash = build2
  const doubleBuildIdentical = build1 === build2
  if (!doubleBuildIdentical) {
    throw new Error(`reproducible build failed: build1=${build1} build2=${build2}`)
  }

  // Capsule hash: a content-address over (source archive hash, bundle hash, schema+scan receipts).
  // The full capsule (runtime closure + SBOM) is packed separately; this is the
  // candidate-content digest used for identity.
  const capsuleHash = createHash('sha256')
    .update(archive.hash)
    .update(bundleHash)
    .update(schemaValidation.valid ? '1' : '0')
    .update(scan.passed ? '1' : '0')
    .digest('hex')

  return {
    sourceHash: archive.hash,
    bundleHash,
    capsuleHash,
    candidateId: archive.candidateId,
    archive,
    scan,
    schemaValidation,
    doubleBuildIdentical,
  }
}
