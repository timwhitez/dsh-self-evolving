import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { buildCandidate, type BuildArtifactFile, type BuildReceipt } from '../builder-sandbox.js'
import { packCapsule, type CapsuleOutput, type RuntimeClosureInput } from '../capsule.js'
import { assertV011, digestV011, V011_PROTOCOL } from './contract.js'
import { canonicalizeV011Tree, snapshotV011Tree } from './tree.js'

export interface V011LoaderProbeReceipt {
  schemaVersion: 1
  mode: 'solve' | 'propose'
  candidateId: string
  entries: string[]
  componentInventory: string[]
  promptSections: string[]
  replayDigest: `sha256:${string}`
  leakedHandles: string[]
}

export interface V011AdmissionReceipt {
  schemaVersion: 1
  protocol: typeof V011_PROTOCOL
  candidateDigest: `sha256:${string}`
  materializationDigest: `sha256:${string}`
  capabilityCatalogDigest: `sha256:${string}`
  stageReceipts: {
    containment: `sha256:${string}`
    schema: `sha256:${string}`
    policy: `sha256:${string}`
    candidateTests: `sha256:${string}`
    doubleBuild: `sha256:${string}`
    loaderSolve: `sha256:${string}`
    loaderPropose: `sha256:${string}`
    fixedReplay: `sha256:${string}`
    offlineCapsule: `sha256:${string}`
  }
  capsuleDigest: `sha256:${string}`
  admitted: true
}

export interface V011AdmissionOutput {
  receipt: V011AdmissionReceipt
  buildReceipt: BuildReceipt
  capsule: CapsuleOutput
  loader: { solve: V011LoaderProbeReceipt; propose: V011LoaderProbeReceipt }
  candidateTestOutputDigest: `sha256:${string}`
}

function spawnBounded(
  command: string,
  args: string[],
  options: { timeoutMs: number; maxOutputBytes?: number },
): Promise<{
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}> {
  return new Promise((done, reject) => {
    const child = spawn(command, args, {
      detached: true,
      env: { PATH: '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const cap = options.maxOutputBytes ?? 2 * 1024 * 1024
    let bytes = 0
    let settled = false
    const kill = () => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    const timer = setTimeout(kill, options.timeoutMs)
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > cap) kill()
      else target.push(chunk)
    }
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (exitCode, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  })
}

async function runCandidateTests(
  sourceRoot: string,
  toolchainRoot: string,
): Promise<`sha256:${string}`> {
  const tests = (await snapshotV011Tree(sourceRoot)).files
    .filter((file) => file.path.startsWith('tests/') && file.path.endsWith('.spec.ts'))
    .map((file) => `/work/${file.path}`)
  if (tests.length === 0) throw new Error('v0.1.1 admission: candidate has no tests')
  const dshRoot = join(resolve(toolchainRoot), 'deepseek-harness')
  const standardSchema = await realpath(
    join(dshRoot, 'vendor', 'schemastery', 'node_modules', '@standard-schema', 'spec'),
  )
  const hostNode = await realpath(process.execPath)
  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-all',
    '--hostname',
    'dsh-self-evolving-candidate-tests',
    '--cap-drop',
    'ALL',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--ro-bind',
    '/usr',
    '/usr',
    ...(hostNode === '/usr/bin/node' ? [] : ['--ro-bind', hostNode, '/usr/bin/node']),
    '--ro-bind',
    '/bin',
    '/bin',
    '--ro-bind',
    '/lib',
    '/lib',
    '--ro-bind',
    '/lib64',
    '/lib64',
    '--ro-bind',
    '/etc/hosts',
    '/etc/hosts',
    '--ro-bind',
    '/etc/nsswitch.conf',
    '/etc/nsswitch.conf',
    '--ro-bind',
    join(resolve(toolchainRoot), 'tsconfig.json'),
    '/tsconfig.json',
    '--ro-bind',
    resolve(sourceRoot),
    '/work',
    '--dir',
    '/node_modules',
    '--dir',
    '/node_modules/@deepseek-ai',
    '--dir',
    '/node_modules/@standard-schema',
    '--ro-bind',
    join(dshRoot, 'vendor', 'cordis'),
    '/node_modules/@deepseek-ai/cordis',
    '--ro-bind',
    join(dshRoot, 'vendor', 'schemastery'),
    '/node_modules/@deepseek-ai/schemastery',
    '--ro-bind',
    join(dshRoot, 'vendor', 'cosmokit'),
    '/node_modules/@deepseek-ai/cosmokit',
    '--ro-bind',
    join(dshRoot, 'packages', 'core', 'system-prompt'),
    '/node_modules/@deepseek-ai/dsh-system-prompt',
    '--ro-bind',
    standardSchema,
    '/node_modules/@standard-schema/spec',
    '--dir',
    '/toolchain',
    '--ro-bind',
    join(resolve(toolchainRoot), 'node_modules'),
    '/toolchain/node_modules',
    '--tmpfs',
    '/tmp',
    '--clearenv',
    '--setenv',
    'PATH',
    '/usr/bin:/bin',
    '--chdir',
    '/work',
    '--',
    '/usr/bin/node',
    '/toolchain/node_modules/vitest/vitest.mjs',
    'run',
    '--root',
    '/work',
    '--no-file-parallelism',
    ...tests,
  ]
  const result = await spawnBounded('/usr/bin/bwrap', args, { timeoutMs: 120_000 })
  if (result.exitCode !== 0) {
    throw new Error(`v0.1.1 admission: candidate tests failed: ${result.stderr}\n${result.stdout}`)
  }
  return digestV011(`${result.stdout}\n${result.stderr}`)
}

async function verifySums(capsuleRoot: string): Promise<`sha256:${string}`> {
  const sums = await readFile(join(capsuleRoot, 'SHA256SUMS'), 'utf8')
  for (const line of sums.trim().split('\n')) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line)
    if (match === null) throw new Error('v0.1.1 admission: malformed capsule sums')
    const bytes = await readFile(join(capsuleRoot, match[2]!))
    if (createHash('sha256').update(bytes).digest('hex') !== match[1]) {
      throw new Error(`v0.1.1 admission: capsule checksum mismatch ${match[2]}`)
    }
  }
  return digestV011(sums)
}

async function runLoaderProbe(input: {
  capsuleRoot: string
  runtimePackageName: string
  candidateId: string
  mode: 'solve' | 'propose'
}): Promise<V011LoaderProbeReceipt> {
  const runtime = join(input.capsuleRoot, 'runtime')
  const candidateEntry = `/runtime/node_modules/${input.runtimePackageName}/lib/index.js`
  const worker =
    '/runtime/node_modules/@dsh-self-evolving/candidate-sdk/lib/v011/loader-probe-worker.js'
  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-all',
    '--hostname',
    'dsh-self-evolving-loader-probe',
    '--cap-drop',
    'ALL',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind',
    '/bin',
    '/bin',
    '--ro-bind',
    '/lib',
    '/lib',
    '--ro-bind',
    '/lib64',
    '/lib64',
    '--ro-bind',
    runtime,
    '/runtime',
    '--tmpfs',
    '/tmp',
    '--clearenv',
    '--setenv',
    'PATH',
    '/usr/bin:/bin',
    '--chdir',
    '/tmp',
    '--',
    '/runtime/node',
    worker,
    candidateEntry,
    input.candidateId,
    input.mode,
  ]
  const result = await spawnBounded('/usr/bin/bwrap', args, { timeoutMs: 60_000 })
  if (result.exitCode !== 0)
    throw new Error(`v0.1.1 admission: Loader ${input.mode} failed: ${result.stderr}`)
  const line = result.stdout
    .split('\n')
    .findLast((row) => row.startsWith('DSH_SELF_EVOLVING_V011_LOADER_RECEIPT='))
  if (line === undefined) throw new Error('v0.1.1 admission: Loader receipt missing')
  const receipt = JSON.parse(
    line.slice('DSH_SELF_EVOLVING_V011_LOADER_RECEIPT='.length),
  ) as V011LoaderProbeReceipt
  if (receipt.mode !== input.mode || receipt.leakedHandles.length !== 0) {
    throw new Error('v0.1.1 admission: Loader receipt identity/quiescence mismatch')
  }
  return receipt
}

async function runtimeSourceFiles(
  receipt: BuildReceipt,
): Promise<{ files: BuildArtifactFile[]; packageName: string }> {
  const packageName = `@dsh-self-evolving/candidate-${receipt.candidateId.slice(2, 18)}`
  const packageJson = {
    name: packageName,
    version: '0.0.0',
    private: true,
    type: 'module',
    main: 'lib/index.js',
    files: ['lib', 'candidate.json', 'cordis.patch.yml'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }
  const replacements = new Map<string, Uint8Array>([
    ['package.json', Buffer.from(JSON.stringify(packageJson, null, 2) + '\n')],
    [
      'cordis.patch.yml',
      Buffer.from(`- insert:\n    - id: self-evolving-candidate\n      name: '${packageName}'\n`),
    ],
  ])
  return {
    packageName,
    files: receipt.sourceFiles.map((file) => ({
      ...file,
      bytes: replacements.get(file.path) ?? file.bytes,
    })),
  }
}

export async function admitV011Candidate(input: {
  sourceRoot: string
  toolchainRoot: string
  tscBin: string
  materializationDigest: `sha256:${string}`
  capabilityCatalogDigest: `sha256:${string}`
  capsuleOutDir: string
  runtimeClosure: RuntimeClosureInput
  runnerOverlay: string
  runnerFiles?: Record<string, string>
  provenanceJson: string
  sbomJson: string
}): Promise<V011AdmissionOutput> {
  const source = await snapshotV011Tree(input.sourceRoot)
  const archive = await canonicalizeV011Tree(source)
  const candidateDigest = `sha256:${archive.hash}` as const
  const testOutputDigest = await runCandidateTests(input.sourceRoot, input.toolchainRoot)
  const buildParent = join(resolve(input.toolchainRoot), '.v011-builds')
  await mkdir(buildParent, { recursive: true, mode: 0o700 })
  const buildRoot = await mkdtemp(join(buildParent, 'candidate-'))
  try {
    await cp(input.sourceRoot, buildRoot, { recursive: true })
    const sourceFiles = (await snapshotV011Tree(buildRoot)).files.map((file) => file.path)
    await symlink(
      join(resolve(input.toolchainRoot), 'packages', 'candidate-v011-baseline', 'node_modules'),
      join(buildRoot, 'node_modules'),
      'dir',
    )
    const buildReceipt = await buildCandidate({
      sourceRoot: buildRoot,
      sourceFiles,
      tscBin: input.tscBin,
      manifestKind: 'v011-candidate-intent',
      testImportAllowlist: new Set(['vitest']),
    })
    if (`sha256:${buildReceipt.sourceHash}` !== candidateDigest) {
      throw new Error('v0.1.1 admission: build source differs from materialized source')
    }
    const runtimeSource = await runtimeSourceFiles(buildReceipt)
    buildReceipt.runtimeSourceFiles = runtimeSource.files
    buildReceipt.runtimePackageName = runtimeSource.packageName
    const closure: RuntimeClosureInput = {
      ...input.runtimeClosure,
      seedPackages: [
        ...new Set([
          ...input.runtimeClosure.seedPackages,
          '@dsh-self-evolving/candidate-sdk',
          '@deepseek-ai/cordis-plugin-loader',
          '@deepseek-ai/dsh-system-prompt',
        ]),
      ],
    }
    const capsule = await packCapsule({
      outDir: input.capsuleOutDir,
      receipt: buildReceipt,
      runnerOverlay: input.runnerOverlay.replaceAll(
        '__DSH_SELF_EVOLVING_RUNTIME_PACKAGE__',
        runtimeSource.packageName,
      ),
      ...(input.runnerFiles === undefined ? {} : { runnerFiles: input.runnerFiles }),
      provenanceJson: input.provenanceJson,
      sbomJson: input.sbomJson,
      runtimeClosure: closure,
    })
    const sumsDigest = await verifySums(capsule.capsuleDir)
    const solve = await runLoaderProbe({
      capsuleRoot: capsule.capsuleDir,
      runtimePackageName: runtimeSource.packageName,
      candidateId: candidateDigest,
      mode: 'solve',
    })
    const propose = await runLoaderProbe({
      capsuleRoot: capsule.capsuleDir,
      runtimePackageName: runtimeSource.packageName,
      candidateId: candidateDigest,
      mode: 'propose',
    })
    const fixedReplay = digestV011({ solve: solve.replayDigest, propose: propose.replayDigest })
    const receipt: V011AdmissionReceipt = {
      schemaVersion: 1,
      protocol: V011_PROTOCOL,
      candidateDigest,
      materializationDigest: input.materializationDigest,
      capabilityCatalogDigest: input.capabilityCatalogDigest,
      stageReceipts: {
        containment: digestV011({
          files: source.files.map((file) => file.path),
          bytes: source.sourceBytes,
        }),
        schema: digestV011(buildReceipt.schemaValidation),
        policy: digestV011(buildReceipt.scan),
        candidateTests: testOutputDigest,
        doubleBuild: digestV011({
          bundleHash: buildReceipt.bundleHash,
          identical: buildReceipt.doubleBuildIdentical,
        }),
        loaderSolve: digestV011(solve),
        loaderPropose: digestV011(propose),
        fixedReplay,
        offlineCapsule: sumsDigest,
      },
      capsuleDigest: `sha256:${capsule.capsuleHash}`,
      admitted: true,
    }
    await assertV011('admission-receipt', receipt)
    return {
      receipt,
      buildReceipt,
      capsule,
      loader: { solve, propose },
      candidateTestOutputDigest: testOutputDigest,
    }
  } finally {
    await rm(buildRoot, { recursive: true, force: true })
  }
}
