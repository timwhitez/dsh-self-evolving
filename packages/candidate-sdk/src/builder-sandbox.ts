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
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { link, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
  /** Successor candidates use the identity-free behavior-intent schema. */
  manifestKind?: 'candidate' | 'v011-candidate-intent'
  /** Trusted test-only imports; never applied to production source. */
  testImportAllowlist?: ReadonlySet<string>
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
  /** Immutable source/bundle bytes consumed by the capsule packer. */
  sourceFiles: BuildArtifactFile[]
  bundleFiles: BuildArtifactFile[]
  /** Builder-materialized runtime package bytes; canonical source remains in sourceFiles. */
  runtimeSourceFiles?: BuildArtifactFile[]
  /** Exact runtime package identity materialized after canonical identity derivation. */
  runtimePackageName?: string
}

export interface BuildArtifactFile {
  path: string
  bytes: Uint8Array
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

async function snapshotTree(root: string): Promise<BuildArtifactFile[]> {
  const files: BuildArtifactFile[] = []
  async function walk(directory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else if (entry.isFile()) {
        files.push({
          path: absolute
            .slice(root.length + 1)
            .split('\\')
            .join('/'),
          bytes: new Uint8Array(await readFile(absolute)),
        })
      }
    }
  }
  await walk(root)
  return files
}

function execTsc(tscBin: string, projectDir: string): Promise<void> {
  return new Promise((resolveExec, rejectExec) => {
    execFile(tscBin, ['-b', '--force'], { cwd: projectDir }, (err, stdout, stderr) => {
      if (err) rejectExec(new Error(`tsc failed: ${stderr}\n${stdout}\n${err.message}`))
      else resolveExec()
    })
  })
}

async function processStartTicks(pid: number): Promise<string | null> {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8')
    const close = raw.lastIndexOf(') ')
    if (close === -1) return null
    return (
      raw
        .slice(close + 2)
        .trim()
        .split(/\s+/)[19] ?? null
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function acquireBuildLock(sourceRoot: string): Promise<() => Promise<void>> {
  const lockDir = join(tmpdir(), 'dsh-self-evolving-candidate-build-locks')
  await mkdir(lockDir, { recursive: true, mode: 0o700 })
  const key = createHash('sha256').update(resolve(sourceRoot)).digest('hex')
  const lockPath = join(lockDir, `${key}.lock`)
  const startTicks = await processStartTicks(process.pid)
  if (startTicks === null) throw new Error('builder lock: cannot verify current process identity')
  const record = JSON.stringify({ pid: process.pid, processStartTicks: startTicks }) + '\n'
  const deadline = Date.now() + 120_000

  /**
   * Publish the lock atomically: write the complete owner record to a unique
   * staging file, fsync it, then hard-link it into the lock path. A crash can
   * strand staging files (harmless, unique names) but can never leave an
   * empty or truncated lock at the final path (issue #38).
   */
  const tryAcquire = async (): Promise<boolean> => {
    const staging = `${lockPath}.acquire-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`
    try {
      const file = await open(staging, 'wx', 0o600)
      try {
        await file.writeFile(record)
        await file.sync()
      } finally {
        await file.close()
      }
      try {
        await link(staging, lockPath)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        return false
      }
    } finally {
      await rm(staging, { force: true })
    }
  }

  while (Date.now() < deadline) {
    if (await tryAcquire()) {
      return async () => {
        const current = await readFile(lockPath, 'utf8').catch(() => null)
        if (current !== record) throw new Error('builder lock: ownership changed before release')
        await rm(lockPath)
      }
    }
    const existing = await readFile(lockPath, 'utf8').catch(() => null)
    if (existing !== null && existing.trim() !== '') {
      try {
        const owner = JSON.parse(existing) as {
          pid?: number
          processStartTicks?: string
        }
        if (typeof owner.pid === 'number' && typeof owner.processStartTicks === 'string') {
          const ownerStart = await processStartTicks(owner.pid)
          if (ownerStart !== owner.processStartTicks) {
            const stalePath = `${lockPath}.stale-${createHash('sha256').update(existing).digest('hex').slice(0, 16)}`
            await rename(lockPath, stalePath).catch((renameError) => {
              if ((renameError as NodeJS.ErrnoException).code !== 'ENOENT') throw renameError
            })
            continue
          }
        }
      } catch (parseError) {
        if (!(parseError instanceof SyntaxError)) throw parseError
      }
    } else if (existing !== null) {
      // Empty lock file: a legacy crash between exclusive create and the
      // owner write. No complete owner record exists, so it is reclaimable.
      const stalePath = `${lockPath}.stale-empty-${Date.now()}`
      await rename(lockPath, stalePath).catch((renameError) => {
        if ((renameError as NodeJS.ErrnoException).code !== 'ENOENT') throw renameError
      })
      continue
    }
    await new Promise<void>((done) => setTimeout(done, 50))
  }
  throw new Error(`builder lock: timed out waiting for ${resolve(sourceRoot)}`)
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
  const immutableSourceFiles = await Promise.all(
    declared.map(async (file) => ({
      path: file.path,
      bytes: new Uint8Array(await readFile(file.absPath)),
    })),
  )

  // Step 2b: schema validation of candidate.json.
  const schemaValidation = await validateManifestFile(
    input.manifestKind ?? 'candidate',
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
  const productionFiles = codeFiles.filter((file) => !file.path.startsWith('tests/'))
  const testFiles = codeFiles.filter((file) => file.path.startsWith('tests/'))
  const productionScan = await scanPaths(productionFiles)
  const testScan = await scanPaths(testFiles, {
    extraImportAllowlist: input.testImportAllowlist ?? new Set<string>(),
  })
  const scan: ScanResult = {
    hits: [...productionScan.hits, ...testScan.hits],
    passed: productionScan.passed && testScan.passed,
  }
  if (!scan.passed) {
    const rejects = scan.hits.filter((h) => h.severity === 'reject')
    throw new Error(
      `policy scan rejected:\n${rejects.map((h) => `  ${h.path}:${h.line} ${h.rule} ${h.snippet}`).join('\n')}`,
    )
  }

  // Step 5: reproducible build — two clean builds must produce identical lib/.
  const releaseBuildLock = await acquireBuildLock(sourceRoot)
  let bundleHash: string
  let doubleBuildIdentical: boolean
  let build1: string
  let build2: string
  let immutableBundleFiles: BuildArtifactFile[]
  try {
    const libDir = join(sourceRoot, 'lib')
    await rm(libDir, { recursive: true, force: true })
    await execTsc(tscBin, sourceRoot)
    build1 = await hashTree(libDir)
    await rm(libDir, { recursive: true, force: true })
    await execTsc(tscBin, sourceRoot)
    build2 = await hashTree(libDir)
    immutableBundleFiles = await snapshotTree(libDir)
    bundleHash = build2
    doubleBuildIdentical = build1 === build2
  } finally {
    await releaseBuildLock()
  }
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
    sourceFiles: immutableSourceFiles,
    bundleFiles: immutableBundleFiles,
  }
}
