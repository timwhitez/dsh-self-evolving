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
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { type CanonicalArchive } from './identity/canonical-tar.js'
import {
  CANDIDATE_BUILD_RESOURCE_POLICY_V1,
  type ResourceDomainReceipt,
} from './resource-domain.js'
import { spawnResourceBoundSandbox } from './resource-sandbox.js'
import { scanPaths, type ScanResult } from './scan/policy-scan.js'
import { freezeDeclaredSource, type FrozenCandidateSource } from './source-snapshot.js'
import { validateManifest, type ValidationResult } from './validate/index.js'

export interface BuildInput {
  /** Absolute path to the candidate source root (contains src/, package.json, candidate.json). */
  sourceRoot: string
  /** Manifest-declared source files (POSIX-relative). */
  sourceFiles: string[]
  /** Absolute path to the TypeScript binary to use (pinned by provenance). */
  tscBin: string
  /** Trusted repository/toolchain root. Derived from tscBin for legacy callers. */
  toolchainRoot?: string
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
  buildResources: [ResourceDomainReceipt, ResourceDomainReceipt]
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

/** sha256 of `relpath:hash\n` entries sorted by path. */
function hashArtifacts(files: BuildArtifactFile[]): string {
  const entries = files.map(
    (file) => `${file.path}:${createHash('sha256').update(file.bytes).digest('hex')}`,
  )
  entries.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
  return createHash('sha256').update(entries.join('\n')).digest('hex')
}

const TRUSTED_DECLARED_TSCONFIG = {
  extends: '../../tsconfig.json',
  compilerOptions: {
    outDir: 'lib',
    rootDir: 'src',
    composite: true,
    tsBuildInfoFile: 'lib/.tsbuildinfo',
  },
  include: ['src'],
}

function decodeUtf8(bytes: Uint8Array, context: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (cause) {
    throw new Error(`${context}: invalid UTF-8`, { cause })
  }
}

function frozenFile(source: FrozenCandidateSource, path: string): BuildArtifactFile {
  const file = source.files.find((entry) => entry.path === path)
  if (file === undefined) throw new Error(`source snapshot: mandatory file missing: ${path}`)
  return file
}

function validateDeclaredTsconfig(source: FrozenCandidateSource): void {
  const file = frozenFile(source, 'tsconfig.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeUtf8(file.bytes, 'trusted TypeScript configuration')) as unknown
  } catch (cause) {
    throw new Error('trusted TypeScript configuration: invalid JSON', { cause })
  }
  if (!isDeepStrictEqual(parsed, TRUSTED_DECLARED_TSCONFIG)) {
    throw new Error(
      'trusted TypeScript configuration: candidate tsconfig must match the inert declared contract exactly',
    )
  }
}

function trustedCompilerConfig(): Record<string, unknown> {
  return {
    compilerOptions: {
      target: 'ES2023',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      lib: ['ES2023'],
      declaration: true,
      declarationMap: true,
      sourceMap: true,
      strict: true,
      noImplicitOverride: true,
      noUncheckedIndexedAccess: true,
      noFallthroughCasesInSwitch: true,
      exactOptionalPropertyTypes: true,
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      isolatedModules: true,
      verbatimModuleSyntax: false,
      incremental: false,
      composite: false,
      types: [],
      rootDir: '/workspace/source/src',
      outDir: '/output/lib',
    },
    include: ['/workspace/source/src/**/*.ts'],
  }
}

async function execTrustedTsc(input: {
  sourceRoot: string
  configPath: string
  toolchainRoot: string
  tscBin: string
}): Promise<{ files: BuildArtifactFile[]; resource: ResourceDomainReceipt }> {
  const toolchainRoot = resolve(input.toolchainRoot)
  const typescriptRoot = await realpath(join(toolchainRoot, 'node_modules', 'typescript'))
  if (resolve(input.tscBin) !== join(toolchainRoot, 'node_modules', '.bin', 'tsc')) {
    throw new Error('trusted TypeScript configuration: tscBin does not match pinned toolchain')
  }
  const dshRoot = await realpath(join(toolchainRoot, 'deepseek-harness'))
  const hostNode = await realpath(process.execPath)
  const sandboxNode = hostNode === '/usr/bin/node' ? '/usr/bin/node' : '/sandbox-bin/node'
  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-all',
    '--hostname',
    'dsh-candidate-builder',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--ro-bind',
    '/usr',
    '/usr',
    ...(hostNode === '/usr/bin/node'
      ? []
      : ['--dir', '/sandbox-bin', '--ro-bind', hostNode, sandboxNode]),
    '--ro-bind',
    '/bin',
    '/bin',
    '--ro-bind',
    '/lib',
    '/lib',
    '--ro-bind',
    '/lib64',
    '/lib64',
    '--dir',
    '/workspace',
    '--dir',
    '/workspace/node_modules',
    '--dir',
    '/workspace/node_modules/@deepseek-ai',
    '--ro-bind',
    input.sourceRoot,
    '/workspace/source',
    '--ro-bind',
    dshRoot,
    '/dsh',
    '--symlink',
    '/dsh/vendor/cordis',
    '/workspace/node_modules/@deepseek-ai/cordis',
    '--symlink',
    '/dsh/vendor/schemastery',
    '/workspace/node_modules/@deepseek-ai/schemastery',
    '--symlink',
    '/dsh/vendor/cosmokit',
    '/workspace/node_modules/@deepseek-ai/cosmokit',
    '--symlink',
    '/dsh/packages/core/system-prompt',
    '/workspace/node_modules/@deepseek-ai/dsh-system-prompt',
    '--symlink',
    '/dsh/packages/core/tools',
    '/workspace/node_modules/@deepseek-ai/dsh-tools',
    '--dir',
    '/toolchain',
    '--ro-bind',
    typescriptRoot,
    '/toolchain/typescript',
    '--dir',
    '/build',
    '--ro-bind',
    input.configPath,
    '/build/tsconfig.json',
    '--dir',
    '/output',
    '--dir',
    '/tmp',
    '--clearenv',
    '--setenv',
    'PATH',
    '/usr/bin:/bin',
    '--setenv',
    'HOME',
    '/tmp',
    '--setenv',
    'SOURCE_DATE_EPOCH',
    '0',
    '--setenv',
    'TZ',
    'UTC',
    '--chdir',
    '/workspace/source',
  ]
  const sandbox = await spawnResourceBoundSandbox({
    bwrapArgs: args,
    sandboxNode,
    targetCommand: sandboxNode,
    targetArgs: ['/toolchain/typescript/bin/tsc', '--project', '/build/tsconfig.json'],
    mounts: [
      { path: '/tmp', maxBytes: 16 * 1024 * 1024, maxFiles: 128, exportFiles: false },
      { path: '/dev/shm', maxBytes: 16 * 1024 * 1024, maxFiles: 128, exportFiles: false },
      { path: '/output', maxBytes: 96 * 1024 * 1024, maxFiles: 256, exportFiles: true },
    ],
    policy: CANDIDATE_BUILD_RESOURCE_POLICY_V1,
  })
  sandbox.child.stdin.destroy()
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let outputBytes = 0
  const collect = (target: Buffer[]) => (chunk: Buffer) => {
    outputBytes += chunk.byteLength
    if (outputBytes > 2 * 1024 * 1024) {
      void sandbox.kill('OUTPUT_LIMIT')
      return
    }
    target.push(chunk)
  }
  sandbox.child.stdout.on('data', collect(stdout))
  sandbox.child.stderr.on('data', collect(stderr))
  const timer = setTimeout(() => void sandbox.kill('WALL_TIME_LIMIT'), 120_000)
  let result
  try {
    result = await sandbox.finish()
  } finally {
    clearTimeout(timer)
  }
  if (result.exitCode !== 0 || result.resource.terminationCause !== 'COMPLETED') {
    throw new Error(
      `trusted TypeScript compiler failed (${result.exitCode ?? result.signal}; ${result.resource.terminationCause}): ${Buffer.concat(stderr).toString('utf8')}\n${Buffer.concat(stdout).toString('utf8')}\nresource=${JSON.stringify(result.resource)}`,
    )
  }
  const files = result.files.map((file) => {
    if (file.mountPath !== '/output' || !file.path.startsWith('lib/')) {
      throw new Error(`trusted TypeScript compiler emitted outside lib/: ${file.path}`)
    }
    return { path: file.path.slice('lib/'.length), bytes: file.bytes }
  })
  if (files.length === 0) throw new Error('trusted TypeScript compiler emitted no bundle files')
  return { files, resource: result.resource }
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
export async function buildCandidateFromFrozenSource(
  input: Omit<BuildInput, 'sourceRoot' | 'sourceFiles'> & {
    frozenSource: FrozenCandidateSource
  },
): Promise<BuildReceipt> {
  const { frozenSource, tscBin } = input
  const archive = frozenSource.archive
  const immutableSourceFiles = frozenSource.files.map((file) => ({
    path: file.path,
    bytes: new Uint8Array(file.bytes),
  }))

  // Candidate tsconfig is identity material only. It must match the inert
  // declared contract, and is never passed to tsc (issue #37).
  validateDeclaredTsconfig(frozenSource)

  // Step 2b: schema validation from the exact captured candidate.json bytes.
  const manifestFile = frozenFile(frozenSource, 'candidate.json')
  let manifest: unknown
  try {
    manifest = JSON.parse(decodeUtf8(manifestFile.bytes, 'candidate manifest')) as unknown
  } catch (cause) {
    throw new Error('schema validation failed: candidate manifest is invalid JSON', { cause })
  }
  const schemaValidation = await validateManifest(input.manifestKind ?? 'candidate', manifest)
  if (!schemaValidation.valid) {
    throw new Error(`schema validation failed:\n${schemaValidation.errors.join('\n')}`)
  }

  // Step 4: policy scan (imports/deps/secrets/task-fingerprints).
  // The scanner protects the candidate CODE surface (.ts/.js). Structured
  // manifest files (package.json/tsconfig.json/cordis.patch.yml) are validated
  // by the schema + structural checks, not the source scanner — their relative
  // paths (e.g. tsconfig "extends", link: deps) are legitimate config, not
  // runtime traversal.
  const codeFiles = frozenSource.files
    .filter((file) => file.path.endsWith('.ts') || file.path.endsWith('.js'))
    .map((file) => ({ path: file.path, absPath: join(frozenSource.root, file.path) }))
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

  // Step 5: compile the read-only snapshot twice in fresh OS sandboxes. The
  // only writable mount is /output, and a builder-owned config fixes every
  // effective compiler path (issues #37 and #65).
  const toolchainRoot = input.toolchainRoot ?? resolve(dirname(tscBin), '..', '..')
  const compileRoot = await mkdtemp(join(tmpdir(), 'dsh-candidate-compile-'))
  const configPath = join(compileRoot, 'trusted-tsconfig.json')
  await writeFile(configPath, JSON.stringify(trustedCompilerConfig(), null, 2) + '\n', {
    flag: 'wx',
    mode: 0o400,
  })
  let bundleHash: string
  let doubleBuildIdentical: boolean
  let build1: string
  let build2: string
  let immutableBundleFiles: BuildArtifactFile[]
  let buildResources: [ResourceDomainReceipt, ResourceDomainReceipt]
  try {
    const first = await execTrustedTsc({
      sourceRoot: frozenSource.root,
      configPath,
      toolchainRoot,
      tscBin,
    })
    build1 = hashArtifacts(first.files)
    const second = await execTrustedTsc({
      sourceRoot: frozenSource.root,
      configPath,
      toolchainRoot,
      tscBin,
    })
    build2 = hashArtifacts(second.files)
    immutableBundleFiles = second.files
    buildResources = [first.resource, second.resource]
    bundleHash = build2
    doubleBuildIdentical = build1 === build2
  } finally {
    await rm(compileRoot, { recursive: true, force: true })
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
    .update(buildResources[0].policyDigest)
    .update(buildResources[1].policyDigest)
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
    buildResources,
    sourceFiles: immutableSourceFiles,
    bundleFiles: immutableBundleFiles,
  }
}

export async function buildCandidate(input: BuildInput): Promise<BuildReceipt> {
  const releaseBuildLock = await acquireBuildLock(input.sourceRoot)
  let frozenSource: FrozenCandidateSource | undefined
  try {
    frozenSource = await freezeDeclaredSource(input.sourceRoot, input.sourceFiles)
    const testingAfterSnapshot = (
      input as BuildInput & { testingAfterSnapshot?: () => Promise<void> }
    ).testingAfterSnapshot
    if (testingAfterSnapshot !== undefined) {
      if (process.env['NODE_ENV'] !== 'test') {
        throw new Error('testingAfterSnapshot is restricted to NODE_ENV=test')
      }
      await testingAfterSnapshot()
    }
    return await buildCandidateFromFrozenSource({
      frozenSource,
      tscBin: input.tscBin,
      ...(input.toolchainRoot === undefined ? {} : { toolchainRoot: input.toolchainRoot }),
      ...(input.manifestKind === undefined ? {} : { manifestKind: input.manifestKind }),
      ...(input.testImportAllowlist === undefined
        ? {}
        : { testImportAllowlist: input.testImportAllowlist }),
    })
  } finally {
    try {
      await frozenSource?.cleanup()
    } finally {
      await releaseBuildLock()
    }
  }
}
