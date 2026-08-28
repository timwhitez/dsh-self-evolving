import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { Readable, Transform, Writable, type TransformCallback } from 'node:stream'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent as AcpAgent,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk'
import {
  buildCandidateFromFrozenSource,
  CANDIDATE_BUILD_WRITABLE_MOUNTS_V1,
  type BuildArtifactFile,
  type BuildReceipt,
} from '../builder-sandbox.js'
import { packCapsule, type CapsuleOutput, type RuntimeClosureInput } from '../capsule.js'
import {
  assertCompletedResourceDomainReceipt,
  CANDIDATE_BUILD_RESOURCE_POLICY_V1,
  CANDIDATE_RUNTIME_RESOURCE_POLICY_V1,
  CANDIDATE_TEST_RESOURCE_POLICY_V1,
  type ResourceDomainReceipt,
  type ResourcePolicyV1,
} from '../resource-domain.js'
import { spawnResourceBoundSandbox, type WritableSandboxMount } from '../resource-sandbox.js'
import { freezeSourceTree } from '../source-snapshot.js'
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
  resource: ResourceDomainReceipt
}

export interface V011PackedOverlayProbeReceipt {
  schemaVersion: 1
  candidateId: string
  authoritativeOverlayRef: 'runner/cordis.patch.yml'
  bootedConfigRef: 'runtime/cordis.yml'
  overlayDigest: `sha256:${string}`
  byteIdentical: true
  protocolVersion: number
  agentName: string
  runtimeSettled: true
  sessionCreated: true
  sandbox: 'bwrap-unshare-all-clearenv'
  resource: ResourceDomainReceipt
}

export interface V011AdmissionReceipt {
  schemaVersion: 1
  protocol: typeof V011_PROTOCOL
  candidateDigest: `sha256:${string}`
  /** Candidate SDK canonical-tar identity cross-bound to candidateDigest. */
  buildCandidateId: string
  materializationDigest: `sha256:${string}`
  capabilityCatalogDigest: `sha256:${string}`
  resourceReceiptDigest: `sha256:${string}`
  stageReceipts: {
    containment: `sha256:${string}`
    schema: `sha256:${string}`
    policy: `sha256:${string}`
    candidateTests: `sha256:${string}`
    doubleBuild: `sha256:${string}`
    loaderSolve: `sha256:${string}`
    loaderPropose: `sha256:${string}`
    packedOverlayBoot: `sha256:${string}`
    fixedReplay: `sha256:${string}`
    offlineCapsule: `sha256:${string}`
  }
  capsuleDigest: `sha256:${string}`
  admitted: true
}

export interface V011AdmissionResourceReceipt {
  schemaVersion: 1
  candidateDigest: `sha256:${string}`
  candidateTests: ResourceDomainReceipt
  builds: [ResourceDomainReceipt, ResourceDomainReceipt]
  loaderSolve: ResourceDomainReceipt
  loaderPropose: ResourceDomainReceipt
  packedOverlayBoot: ResourceDomainReceipt
}

export interface V011AdmissionOutput {
  receipt: V011AdmissionReceipt
  buildReceipt: BuildReceipt
  capsule: CapsuleOutput
  loader: { solve: V011LoaderProbeReceipt; propose: V011LoaderProbeReceipt }
  packedOverlay: V011PackedOverlayProbeReceipt
  candidateTestOutputDigest: `sha256:${string}`
  candidateTestResource: ResourceDomainReceipt
  resourceReceipt: V011AdmissionResourceReceipt
}

export const V011_PACKED_OVERLAY_CONTROL_LIMIT_BYTES = 16 * 1024
export const V011_PACKED_OVERLAY_ACP_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024

const V011_CANDIDATE_TEST_WRITABLE_MOUNTS_V1 = [
  { path: '/tmp', maxBytes: 96 * 1024 * 1024, maxFiles: 3072, exportFiles: false },
  { path: '/dev/shm', maxBytes: 32 * 1024 * 1024, maxFiles: 1024, exportFiles: false },
] satisfies WritableSandboxMount[]

const V011_LOADER_WRITABLE_MOUNTS_V1 = [
  { path: '/tmp', maxBytes: 32 * 1024 * 1024, maxFiles: 1024, exportFiles: false },
  { path: '/dev/shm', maxBytes: 16 * 1024 * 1024, maxFiles: 512, exportFiles: false },
] satisfies WritableSandboxMount[]

const V011_PACKED_OVERLAY_WRITABLE_MOUNTS_V1 = [
  { path: '/tmp', maxBytes: 32 * 1024 * 1024, maxFiles: 1024, exportFiles: false },
  { path: '/dev/shm', maxBytes: 16 * 1024 * 1024, maxFiles: 512, exportFiles: false },
  { path: '/workspace', maxBytes: 64 * 1024 * 1024, maxFiles: 2048, exportFiles: false },
  { path: '/logs', maxBytes: 64 * 1024 * 1024, maxFiles: 2048, exportFiles: false },
] satisfies WritableSandboxMount[]

interface V011PackedOverlayReadyControl {
  schemaVersion: 1
  phase: 'ready'
  nonce: string
  candidateId: string
  configRef: 'runtime/cordis.yml'
  runtimeSettled: true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

export function assertV011AdmissionResourceReceipt(
  value: unknown,
  expectedCandidateDigest: string,
): V011AdmissionResourceReceipt {
  if (
    !/^sha256:[0-9a-f]{64}$/.test(expectedCandidateDigest) ||
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'candidateDigest',
      'candidateTests',
      'builds',
      'loaderSolve',
      'loaderPropose',
      'packedOverlayBoot',
    ]) ||
    value['schemaVersion'] !== 1 ||
    value['candidateDigest'] !== expectedCandidateDigest ||
    !Array.isArray(value['builds']) ||
    value['builds'].length !== 2
  ) {
    throw new Error('v0.1.1 admission resource receipt: invalid envelope/identity')
  }
  const verify = (
    stage: string,
    receipt: unknown,
    policy: ResourcePolicyV1,
    mounts: WritableSandboxMount[],
  ) =>
    assertCompletedResourceDomainReceipt(receipt, {
      policy,
      writableMounts: mounts,
      label: `v0.1.1 admission resource ${stage}`,
    })
  const builds = value['builds']
  return {
    schemaVersion: 1,
    candidateDigest: expectedCandidateDigest as `sha256:${string}`,
    candidateTests: verify(
      'candidateTests',
      value['candidateTests'],
      CANDIDATE_TEST_RESOURCE_POLICY_V1,
      V011_CANDIDATE_TEST_WRITABLE_MOUNTS_V1,
    ),
    builds: [
      verify(
        'builds[0]',
        builds[0],
        CANDIDATE_BUILD_RESOURCE_POLICY_V1,
        CANDIDATE_BUILD_WRITABLE_MOUNTS_V1,
      ),
      verify(
        'builds[1]',
        builds[1],
        CANDIDATE_BUILD_RESOURCE_POLICY_V1,
        CANDIDATE_BUILD_WRITABLE_MOUNTS_V1,
      ),
    ],
    loaderSolve: verify(
      'loaderSolve',
      value['loaderSolve'],
      CANDIDATE_RUNTIME_RESOURCE_POLICY_V1,
      V011_LOADER_WRITABLE_MOUNTS_V1,
    ),
    loaderPropose: verify(
      'loaderPropose',
      value['loaderPropose'],
      CANDIDATE_RUNTIME_RESOURCE_POLICY_V1,
      V011_LOADER_WRITABLE_MOUNTS_V1,
    ),
    packedOverlayBoot: verify(
      'packedOverlayBoot',
      value['packedOverlayBoot'],
      CANDIDATE_RUNTIME_RESOURCE_POLICY_V1,
      V011_PACKED_OVERLAY_WRITABLE_MOUNTS_V1,
    ),
  }
}

function decodeUtf8(bytes: Uint8Array, context: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (cause) {
    throw new Error(`${context}: invalid UTF-8`, { cause })
  }
}

/**
 * Parse the authenticated control transcript emitted by the trusted worker.
 * The nonce is generated and first written to the write-only stderr pipe
 * before candidate code is imported, so candidate code can share the
 * transport but cannot forge the matching post-import receipt. Any injected
 * or duplicate control record makes the transcript non-canonical.
 */
export function parseV011PackedOverlayControl(
  bytes: Uint8Array,
  candidateId: string,
): V011PackedOverlayReadyControl {
  if (bytes.byteLength > V011_PACKED_OVERLAY_CONTROL_LIMIT_BYTES) {
    throw new Error('packed overlay control transcript exceeds byte limit')
  }
  if (bytes.byteLength === 0 || bytes[bytes.byteLength - 1] !== 0x0a) {
    throw new Error('packed overlay control transcript must be newline-terminated')
  }
  const lines = decodeUtf8(bytes.subarray(0, bytes.byteLength - 1), 'packed overlay control').split(
    '\n',
  )
  if (lines.length !== 2) {
    throw new Error('packed overlay control transcript must contain exactly two records')
  }
  let challenge: unknown
  let ready: unknown
  try {
    challenge = JSON.parse(lines[0] ?? '') as unknown
    ready = JSON.parse(lines[1] ?? '') as unknown
  } catch (cause) {
    throw new Error('packed overlay control transcript contains invalid JSON', { cause })
  }
  if (
    !isRecord(challenge) ||
    !hasExactKeys(challenge, ['schemaVersion', 'phase', 'nonce']) ||
    challenge['schemaVersion'] !== 1 ||
    challenge['phase'] !== 'challenge' ||
    typeof challenge['nonce'] !== 'string' ||
    !/^[0-9a-f]{64}$/.test(challenge['nonce'])
  ) {
    throw new Error('packed overlay control challenge is invalid')
  }
  if (
    !isRecord(ready) ||
    !hasExactKeys(ready, [
      'schemaVersion',
      'phase',
      'nonce',
      'candidateId',
      'configRef',
      'runtimeSettled',
    ]) ||
    ready['schemaVersion'] !== 1 ||
    ready['phase'] !== 'ready' ||
    ready['candidateId'] !== candidateId ||
    ready['configRef'] !== 'runtime/cordis.yml' ||
    ready['runtimeSettled'] !== true
  ) {
    throw new Error('packed overlay control ready receipt is invalid')
  }
  if (ready['nonce'] !== challenge['nonce']) {
    throw new Error('packed overlay control nonce mismatch')
  }
  return ready as unknown as V011PackedOverlayReadyControl
}

export function validateV011AcpOutputLine(line: string): void {
  let value: unknown
  try {
    value = JSON.parse(line) as unknown
  } catch (cause) {
    throw new Error('packed overlay ACP stdout line is not valid JSON', { cause })
  }
  if (!isRecord(value) || value['jsonrpc'] !== '2.0') {
    throw new Error('packed overlay ACP stdout line is not a JSON-RPC 2.0 object')
  }
  const id = value['id']
  const idValid =
    id === undefined || id === null || typeof id === 'string' || Number.isSafeInteger(id)
  if (!idValid) {
    throw new Error('packed overlay ACP stdout line has an invalid JSON-RPC id')
  }
  const hasMethod = Object.hasOwn(value, 'method')
  const hasResult = Object.hasOwn(value, 'result')
  const hasError = Object.hasOwn(value, 'error')
  if (hasMethod) {
    const params = value['params']
    if (
      typeof value['method'] !== 'string' ||
      value['method'].length === 0 ||
      hasResult ||
      hasError ||
      (params !== undefined && !isRecord(params) && !Array.isArray(params))
    ) {
      throw new Error('packed overlay ACP stdout line has an invalid JSON-RPC request')
    }
    return
  }
  if (id === undefined || hasResult === hasError) {
    throw new Error('packed overlay ACP stdout line is not a JSON-RPC request or response')
  }
  if (hasError) {
    const error = value['error']
    if (
      !isRecord(error) ||
      !Number.isSafeInteger(error['code']) ||
      typeof error['message'] !== 'string'
    ) {
      throw new Error('packed overlay ACP stdout line has an invalid JSON-RPC error')
    }
  }
}

/** Strict, bounded framing in front of the SDK's permissive NDJSON reader. */
export class V011PackedOverlayAcpOutputGuard extends Transform {
  private pending = Buffer.alloc(0)
  private totalBytes = 0
  private handshakeStarted = false

  beginHandshake(): void {
    if (this.totalBytes !== 0) {
      throw new Error('packed overlay ACP emitted stdout before trusted runtime ready')
    }
    this.handshakeStarted = true
  }

  override _transform(chunk: unknown, encoding: BufferEncoding, callback: TransformCallback): void {
    let bytes: Buffer
    if (Buffer.isBuffer(chunk)) bytes = chunk
    else if (typeof chunk === 'string') bytes = Buffer.from(chunk, encoding)
    else if (chunk instanceof Uint8Array) bytes = Buffer.from(chunk)
    else {
      callback(new Error('packed overlay ACP stdout emitted a non-byte chunk'))
      return
    }
    this.totalBytes += bytes.byteLength
    if (this.totalBytes > V011_PACKED_OVERLAY_ACP_OUTPUT_LIMIT_BYTES) {
      callback(new Error('packed overlay ACP stdout exceeds byte limit'))
      return
    }
    if (!this.handshakeStarted && bytes.byteLength !== 0) {
      callback(new Error('packed overlay ACP emitted stdout before trusted runtime ready'))
      return
    }
    this.pending = Buffer.concat([this.pending, bytes])
    let newline = this.pending.indexOf(0x0a)
    while (newline !== -1) {
      const record = this.pending.subarray(0, newline + 1)
      const lineBytes = record.subarray(0, record.byteLength - 1)
      try {
        validateV011AcpOutputLine(decodeUtf8(lineBytes, 'packed overlay ACP stdout'))
      } catch (error) {
        callback(error as Error)
        return
      }
      this.push(record)
      this.pending = this.pending.subarray(newline + 1)
      newline = this.pending.indexOf(0x0a)
    }
    callback()
  }

  override _flush(callback: TransformCallback): void {
    if (this.pending.byteLength !== 0) {
      callback(new Error('packed overlay ACP stdout ended with an unterminated JSON record'))
      return
    }
    callback()
  }
}

async function runBoundedSandbox(input: {
  bwrapArgs: string[]
  sandboxNode: string
  targetCommand: string
  targetArgs: string[]
  mounts: WritableSandboxMount[]
  policy: ResourcePolicyV1
  timeoutMs: number
  maxOutputBytes?: number
}): Promise<{
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  resource: ResourceDomainReceipt
}> {
  const sandbox = await spawnResourceBoundSandbox({
    bwrapArgs: input.bwrapArgs,
    sandboxNode: input.sandboxNode,
    targetCommand: input.targetCommand,
    targetArgs: input.targetArgs,
    mounts: input.mounts,
    policy: input.policy,
  })
  sandbox.child.stdin.destroy()
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  const cap = input.maxOutputBytes ?? 2 * 1024 * 1024
  let bytes = 0
  const collect = (target: Buffer[]) => (chunk: Buffer) => {
    bytes += chunk.byteLength
    if (bytes > cap) void sandbox.kill('OUTPUT_LIMIT')
    else target.push(chunk)
  }
  sandbox.child.stdout.on('data', collect(stdout))
  sandbox.child.stderr.on('data', collect(stderr))
  const timer = setTimeout(() => void sandbox.kill('WALL_TIME_LIMIT'), input.timeoutMs)
  let result
  try {
    result = await sandbox.finish()
  } finally {
    clearTimeout(timer)
  }
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
    resource: result.resource,
  }
}

async function runCandidateTests(
  sourceRoot: string,
  toolchainRoot: string,
): Promise<{ digest: `sha256:${string}`; resource: ResourceDomainReceipt }> {
  const tests = (await snapshotV011Tree(sourceRoot)).files
    .filter((file) => file.path.startsWith('tests/') && file.path.endsWith('.spec.ts'))
    .map((file) => `/work/${file.path}`)
  if (tests.length === 0) throw new Error('v0.1.1 admission: candidate has no tests')
  const dshRoot = join(resolve(toolchainRoot), 'deepseek-harness')
  const standardSchema = await realpath(
    join(dshRoot, 'vendor', 'schemastery', 'node_modules', '@standard-schema', 'spec'),
  )
  const hostNode = await realpath(process.execPath)
  const sandboxNode = hostNode === '/usr/bin/node' ? '/usr/bin/node' : '/sandbox-bin/node'
  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-all',
    '--hostname',
    'dsh-self-evolving-candidate-tests',
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
    '--dir',
    '/tmp',
    '--clearenv',
    '--setenv',
    'PATH',
    '/usr/bin:/bin',
    '--chdir',
    '/work',
  ]
  const result = await runBoundedSandbox({
    bwrapArgs: args,
    sandboxNode,
    targetCommand: sandboxNode,
    targetArgs: [
      '/toolchain/node_modules/vitest/vitest.mjs',
      'run',
      '--root',
      '/work',
      '--no-file-parallelism',
      ...tests,
    ],
    mounts: V011_CANDIDATE_TEST_WRITABLE_MOUNTS_V1,
    policy: CANDIDATE_TEST_RESOURCE_POLICY_V1,
    timeoutMs: 120_000,
  })
  if (result.exitCode !== 0 || result.resource.terminationCause !== 'COMPLETED') {
    throw new Error(
      `v0.1.1 admission: candidate tests failed: ${result.stderr}\n${result.stdout}\nresource=${JSON.stringify(result.resource)}`,
    )
  }
  return {
    digest: digestV011({
      transcript: `${result.stdout}\n${result.stderr}`,
      resource: result.resource,
    }),
    resource: result.resource,
  }
}

/**
 * Verify the capsule integrity manifest against the complete live tree.
 *
 * Every entry must be listed exactly once and every listed entry must exist:
 * regular files by content hash, symlinks by their literal target string,
 * and any missing, extra, duplicated, hard-linked or special entry fails
 * closed (issue #42). `SHA256SUMS` and `capsule.json` are covered by the
 * capsuleHash binding and excluded from the listing.
 */
async function verifySums(capsuleRoot: string): Promise<`sha256:${string}`> {
  const sums = await readFile(join(capsuleRoot, 'SHA256SUMS'), 'utf8')
  const listed = new Map<string, string>()
  for (const line of sums.trim().split('\n')) {
    const match = /^([0-9a-f]{64}) {2}(symlink:)?(.+)$/.exec(line)
    if (match === null) throw new Error('v0.1.1 admission: malformed capsule sums')
    const key = `${match[2] ?? ''}${match[3]!}`
    if (listed.has(key)) throw new Error(`v0.1.1 admission: duplicate capsule entry ${key}`)
    listed.set(key, match[1]!)
  }

  const walked = new Map<string, string>()
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      const rel = relative(capsuleRoot, abs)
      if (rel === 'SHA256SUMS' || rel === 'capsule.json') continue
      if (entry.isDirectory()) {
        await walk(abs)
        continue
      }
      if (entry.isSymbolicLink()) {
        walked.set(
          `symlink:${rel}`,
          createHash('sha256')
            .update(await readlink(abs))
            .digest('hex'),
        )
        continue
      }
      if (!entry.isFile()) {
        throw new Error(`v0.1.1 admission: special capsule entry ${rel}`)
      }
      const info = await lstat(abs)
      if (info.nlink > 1) {
        throw new Error(`v0.1.1 admission: hard-linked capsule entry ${rel}`)
      }
      walked.set(
        rel,
        createHash('sha256')
          .update(await readFile(abs))
          .digest('hex'),
      )
    }
  }
  await walk(capsuleRoot)

  for (const [key, hash] of walked) {
    const expected = listed.get(key)
    if (expected === undefined) {
      throw new Error(`v0.1.1 admission: unlisted capsule entry ${key}`)
    }
    if (expected !== hash) {
      throw new Error(`v0.1.1 admission: capsule checksum mismatch ${key}`)
    }
  }
  for (const key of listed.keys()) {
    if (!walked.has(key)) {
      throw new Error(`v0.1.1 admission: capsule lists a missing entry ${key}`)
    }
  }
  return digestV011(sums)
}

export { verifySums as verifyV011CapsuleSums }

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
    '--dir',
    '/tmp',
    '--clearenv',
    '--setenv',
    'PATH',
    '/usr/bin:/bin',
    '--chdir',
    '/tmp',
  ]
  const result = await runBoundedSandbox({
    bwrapArgs: args,
    sandboxNode: '/runtime/node',
    targetCommand: '/runtime/node',
    targetArgs: [worker, candidateEntry, input.candidateId, input.mode],
    mounts: V011_LOADER_WRITABLE_MOUNTS_V1,
    policy: CANDIDATE_RUNTIME_RESOURCE_POLICY_V1,
    timeoutMs: 60_000,
  })
  if (result.exitCode !== 0 || result.resource.terminationCause !== 'COMPLETED')
    throw new Error(
      `v0.1.1 admission: Loader ${input.mode} failed: ${result.stderr}\nresource=${JSON.stringify(result.resource)}`,
    )
  const line = result.stdout
    .split('\n')
    .findLast((row) => row.startsWith('DSH_SELF_EVOLVING_V011_LOADER_RECEIPT='))
  if (line === undefined) throw new Error('v0.1.1 admission: Loader receipt missing')
  const receipt = JSON.parse(line.slice('DSH_SELF_EVOLVING_V011_LOADER_RECEIPT='.length)) as Omit<
    V011LoaderProbeReceipt,
    'resource'
  >
  if (
    receipt.mode !== input.mode ||
    receipt.leakedHandles.length !== 0 ||
    receipt.candidateId !== input.candidateId
  ) {
    throw new Error('v0.1.1 admission: Loader receipt identity/quiescence mismatch')
  }
  return { ...receipt, resource: result.resource }
}

/**
 * Boot the exact production overlay bytes packed into the capsule and perform
 * a model-free ACP initialize/session handshake. The runtime copy is the file
 * the shipped launcher consumes; byte equality with runner/cordis.patch.yml is
 * checked immediately before launch so an equivalent hand-built composition
 * cannot stand in for deployed configuration (issue #197).
 */
async function runPackedOverlayProbe(input: {
  capsuleRoot: string
  candidateId: string
}): Promise<V011PackedOverlayProbeReceipt> {
  const overlayDigest = await verifyV011PackedOverlayBytes(input.capsuleRoot)
  const runtime = join(input.capsuleRoot, 'runtime')
  const runner = join(input.capsuleRoot, 'runner')
  const closure = JSON.parse(await readFile(join(runtime, 'package-closure.json'), 'utf8')) as {
    entryPackage?: unknown
    entryBin?: unknown
  }
  if (
    typeof closure.entryPackage !== 'string' ||
    !/^@[a-z0-9_-]+\/[a-z0-9._-]+$/.test(closure.entryPackage) ||
    typeof closure.entryBin !== 'string' ||
    closure.entryBin.startsWith('/') ||
    closure.entryBin.split('/').includes('..')
  ) {
    throw new Error('v0.1.1 admission: packed runtime entry identity is invalid')
  }
  const productionEntry = `/runtime/node_modules/${closure.entryPackage}/${closure.entryBin}`
  const worker =
    '/runtime/node_modules/@dsh-self-evolving/candidate-sdk/lib/v011/packed-overlay-probe-worker.js'

  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-all',
    '--hostname',
    'dsh-self-evolving-packed-overlay',
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
    '--ro-bind',
    runner,
    '/runner',
    '--dir',
    '/tmp',
    '--dir',
    '/workspace',
    '--dir',
    '/logs',
    '--clearenv',
    '--setenv',
    'PATH',
    '/usr/bin:/bin',
    '--setenv',
    'HOME',
    '/workspace',
    '--setenv',
    'DSH_HOME',
    '/workspace/.dsh',
    '--setenv',
    'DSH_AGENTS_HOME',
    '/workspace/.agents',
    '--chdir',
    '/workspace',
  ]
  const sandbox = await spawnResourceBoundSandbox({
    bwrapArgs: args,
    sandboxNode: '/runtime/node',
    targetCommand: '/runtime/node',
    targetArgs: [worker, productionEntry, '/runtime/cordis.yml', input.candidateId],
    mounts: V011_PACKED_OVERLAY_WRITABLE_MOUNTS_V1,
    policy: CANDIDATE_RUNTIME_RESOURCE_POLICY_V1,
  })
  const child = sandbox.child
  const stderr: Buffer[] = []
  let stderrBytes = 0
  let stderrLineBuffer = ''
  const controlRecords: string[] = []
  let controlReadySettled = false
  let resolveControlReady!: (ready: V011PackedOverlayReadyControl) => void
  let rejectControlReady!: (error: Error) => void
  let rejectControlViolation!: (error: Error) => void
  const controlReady = new Promise<V011PackedOverlayReadyControl>((resolveReady, rejectReady) => {
    resolveControlReady = resolveReady
    rejectControlReady = rejectReady
  })
  const controlViolation = new Promise<never>((_resolve, reject) => {
    rejectControlViolation = reject
  })
  void controlReady.catch(() => undefined)
  void controlViolation.catch(() => undefined)
  const failControl = (error: Error): void => {
    void sandbox.kill('CONTROL_PROTOCOL_FAILURE')
    if (!controlReadySettled) {
      controlReadySettled = true
      rejectControlReady(error)
      return
    }
    rejectControlViolation(error)
  }
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.byteLength
    if (stderrBytes > 2 * 1024 * 1024) {
      failControl(new Error('packed overlay stderr exceeds byte limit'))
      return
    }
    stderr.push(chunk)
    stderrLineBuffer += chunk.toString('utf8')
    const lines = stderrLineBuffer.split('\n')
    stderrLineBuffer = lines.pop() ?? ''
    for (const line of lines) {
      const prefix = 'DSH_SELF_EVOLVING_PACKED_OVERLAY_CONTROL='
      if (!line.startsWith(prefix)) continue
      if (controlReadySettled) {
        failControl(new Error('packed overlay emitted a control record after ready'))
        continue
      }
      controlRecords.push(line.slice(prefix.length))
      if (controlRecords.length !== 2) continue
      try {
        const ready = parseV011PackedOverlayControl(
          Buffer.from(`${controlRecords.join('\n')}\n`),
          input.candidateId,
        )
        controlReadySettled = true
        resolveControlReady(ready)
      } catch (error) {
        failControl(error as Error)
      }
    }
  })
  const stdoutGuard = new V011PackedOverlayAcpOutputGuard()
  child.stdout.pipe(stdoutGuard)
  const stdoutFailure = new Promise<never>((_resolve, reject) => {
    stdoutGuard.once('error', (error) => {
      void sandbox.kill(
        error.message.includes('exceeds byte limit') ? 'OUTPUT_LIMIT' : 'CONTROL_PROTOCOL_FAILURE',
      )
      reject(error)
    })
  })
  void stdoutFailure.catch(() => undefined)
  const prematureExit = new Promise<never>((_resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      reject(new Error(`packed overlay process exited before handshake: ${code ?? signal}`))
    })
  })
  const childSettled = new Promise<void>((done) => {
    child.once('close', () => done())
    child.once('error', () => done())
  })
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void sandbox.kill('WALL_TIME_LIMIT')
      reject(new Error('packed overlay ACP handshake timed out'))
    }, 60_000)
  })

  let completed: Omit<V011PackedOverlayProbeReceipt, 'resource'> | undefined
  let failure: Error | undefined
  let resource: ResourceDomainReceipt | undefined
  let acpStream: ReturnType<typeof ndJsonStream> | undefined
  try {
    await Promise.race([controlReady, prematureExit, timeout, stdoutFailure])
    stdoutGuard.beginHandshake()
    acpStream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(stdoutGuard) as ReadableStream<Uint8Array>,
    )
    const makeClient = (_agent: AcpAgent): Client => ({
      sessionUpdate(_params: SessionNotification): Promise<void> {
        return Promise.resolve()
      },
      requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        return Promise.resolve({ outcome: { outcome: 'cancelled' } })
      },
    })
    const client = new ClientSideConnection(makeClient, acpStream)
    const initialized = await Promise.race([
      client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
      prematureExit,
      timeout,
      stdoutFailure,
      controlViolation,
    ])
    const session = await Promise.race([
      client.newSession({ cwd: '/workspace', mcpServers: [] }),
      prematureExit,
      timeout,
      stdoutFailure,
      controlViolation,
    ])
    if (session.sessionId.length === 0) {
      throw new Error('packed overlay ACP returned an empty session identity')
    }
    const agentName = initialized.agentInfo?.name
    if (typeof agentName !== 'string' || agentName.length === 0) {
      throw new Error('packed overlay ACP returned no agent identity')
    }
    completed = {
      schemaVersion: 1,
      candidateId: input.candidateId,
      authoritativeOverlayRef: 'runner/cordis.patch.yml',
      bootedConfigRef: 'runtime/cordis.yml',
      overlayDigest,
      byteIdentical: true,
      protocolVersion: PROTOCOL_VERSION,
      agentName,
      runtimeSettled: true,
      sessionCreated: true,
      sandbox: 'bwrap-unshare-all-clearenv',
    }
  } catch (cause) {
    failure = new Error(
      `v0.1.1 admission: exact packed overlay boot failed: ${Buffer.concat(stderr).toString('utf8')}`,
      { cause },
    )
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (completed !== undefined && acpStream !== undefined) {
      try {
        // End the ACP input stream after the successful handshake. The
        // trusted one-shot probe wrapper treats EOF as a successful shutdown,
        // allowing the namespace supervisor to sample storage and emit its
        // completion control record. Killing the cgroup here used to destroy
        // that record and nevertheless admit a CONTROL_PROTOCOL_FAILURE
        // receipt (#51).
        // `ndJsonStream().writable.close()` only closes the JSON wrapper; the
        // SDK intentionally provides no close sink for the underlying byte
        // stream. End the owned child pipe itself so the target observes EOF.
        await new Promise<void>((done, reject) => {
          child.stdin.once('error', reject)
          child.stdin.end(done)
        })
        let shutdownTimer: NodeJS.Timeout | undefined
        const exited = await Promise.race([
          childSettled.then(() => true),
          new Promise<false>((done) => {
            shutdownTimer = setTimeout(() => done(false), 10_000)
          }),
        ])
        if (shutdownTimer !== undefined) clearTimeout(shutdownTimer)
        if (!exited) {
          failure ??= new Error('v0.1.1 admission: packed overlay ACP did not exit after input EOF')
          await sandbox.kill('CONTROL_PROTOCOL_FAILURE')
          await childSettled
        }
      } catch (cause) {
        failure ??= new Error('v0.1.1 admission: packed overlay graceful shutdown failed', {
          cause,
        })
        await sandbox.kill('CONTROL_PROTOCOL_FAILURE')
        await childSettled
      }
    } else {
      child.stdin.destroy()
      await sandbox.kill('CONTROL_PROTOCOL_FAILURE')
      await childSettled
    }
    child.stdout.unpipe(stdoutGuard)
    stdoutGuard.destroy()
    resource = (await sandbox.finish()).resource
  }
  if (failure !== undefined) {
    throw new Error(
      `${failure.message}\nresource=${resource === undefined ? 'missing' : JSON.stringify(resource)}`,
      { cause: failure },
    )
  }
  if (completed === undefined || resource === undefined) {
    throw new Error('v0.1.1 admission: packed overlay completion receipt missing')
  }
  return { ...completed, resource }
}

export async function verifyV011PackedOverlayBytes(
  capsuleRoot: string,
): Promise<`sha256:${string}`> {
  const [authoritativeOverlay, bootedConfig] = await Promise.all([
    readFile(join(capsuleRoot, 'runner', 'cordis.patch.yml')),
    readFile(join(capsuleRoot, 'runtime', 'cordis.yml')),
  ])
  if (!authoritativeOverlay.equals(bootedConfig)) {
    throw new Error('v0.1.1 admission: packed runner/runtime overlays differ')
  }
  return `sha256:${createHash('sha256').update(authoritativeOverlay).digest('hex')}`
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
  const frozenSource = await freezeSourceTree(input.sourceRoot)
  try {
    // Containment, tests, identity, policy, schema and compilation all consume
    // the same descriptor-captured staging tree (issue #65).
    const source = await snapshotV011Tree(frozenSource.root)
    const archive = await canonicalizeV011Tree(source)
    const candidateDigest = `sha256:${archive.hash}` as const
    const candidateTests = await runCandidateTests(frozenSource.root, input.toolchainRoot)
    const buildReceipt = await buildCandidateFromFrozenSource({
      frozenSource,
      tscBin: input.tscBin,
      toolchainRoot: input.toolchainRoot,
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
    const resolvedOverlay = input.runnerOverlay
      .replaceAll('__DSH_SELF_EVOLVING_RUNTIME_PACKAGE__', runtimeSource.packageName)
      .replaceAll('__DSH_SELF_EVOLVING_CANDIDATE_ID__', candidateDigest)
    // Drift must fail closed, not silently pack an unbound identity (issue
    // #114): every offered token must have been consumed and the admitted
    // digest must actually appear in the deployed overlay bytes.
    if (
      resolvedOverlay.includes('__DSH_SELF_EVOLVING_') ||
      (input.runnerOverlay.includes('__DSH_SELF_EVOLVING_CANDIDATE_ID__') &&
        !resolvedOverlay.includes(`candidateId: ${candidateDigest}`))
    ) {
      throw new Error('v0.1.1 admission: runner overlay identity tokens were not resolved')
    }
    const capsule = await packCapsule({
      outDir: input.capsuleOutDir,
      receipt: buildReceipt,
      canonicalCandidateId: candidateDigest,
      runnerOverlay: resolvedOverlay,
      ...(input.runnerFiles === undefined ? {} : { runnerFiles: input.runnerFiles }),
      provenanceJson: input.provenanceJson,
      sbomJson: input.sbomJson,
      runtimeClosure: closure,
    })
    const sumsDigest = await verifySums(capsule.capsuleDir)
    const packedOverlay = await runPackedOverlayProbe({
      capsuleRoot: capsule.capsuleDir,
      candidateId: candidateDigest,
    })
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
    const resourceReceipt = assertV011AdmissionResourceReceipt(
      {
        schemaVersion: 1,
        candidateDigest,
        candidateTests: candidateTests.resource,
        builds: buildReceipt.buildResources,
        loaderSolve: solve.resource,
        loaderPropose: propose.resource,
        packedOverlayBoot: packedOverlay.resource,
      },
      candidateDigest,
    )
    const receipt: V011AdmissionReceipt = {
      schemaVersion: 1,
      protocol: V011_PROTOCOL,
      candidateDigest,
      buildCandidateId: buildReceipt.candidateId,
      materializationDigest: input.materializationDigest,
      capabilityCatalogDigest: input.capabilityCatalogDigest,
      resourceReceiptDigest: digestV011(resourceReceipt),
      stageReceipts: {
        containment: digestV011({
          files: source.files.map((file) => file.path),
          bytes: source.sourceBytes,
        }),
        schema: digestV011(buildReceipt.schemaValidation),
        policy: digestV011(buildReceipt.scan),
        candidateTests: candidateTests.digest,
        doubleBuild: digestV011({
          bundleHash: buildReceipt.bundleHash,
          identical: buildReceipt.doubleBuildIdentical,
          resources: buildReceipt.buildResources,
        }),
        loaderSolve: digestV011(solve),
        loaderPropose: digestV011(propose),
        packedOverlayBoot: digestV011(packedOverlay),
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
      packedOverlay,
      candidateTestOutputDigest: candidateTests.digest,
      candidateTestResource: candidateTests.resource,
      resourceReceipt,
    }
  } finally {
    await frozenSource.cleanup()
  }
}
