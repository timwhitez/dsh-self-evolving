/** Trusted Gate 5 credential-broker and task-network isolation contracts. */
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto'
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { LlmAdapter, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  ProposalGatewayHandlerFailure,
  assertCompletedProposalGatewayReceipts,
  createProposalGatewayLlmHandler,
  startProposalGateway,
  type ProposalGatewayHandle,
  type ProposalGatewayReceipt,
  type ProposalGatewayRoute,
} from '@dsh-self-evolving/proposer'
import { parse, stringify } from 'smol-toml'

export const GATE5_MODEL_SOCKET_TARGET = '/run/dsh-self-evolving/model.sock' as const
export const GATE5_BROKER_PROTOCOL = 'gate5-credential-broker-v2' as const

const HASH = /^sha256:[0-9a-f]{64}$/
const CANDIDATE_ID = /^(?:c_[a-z2-7]{26}|sha256:[0-9a-f]{64})$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,191}$/
const SENSITIVE_ENV_KEY =
  /(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH|COOKIE|SESSION|DOCKER_CONFIG|NETRC|PROXY)/i
const SENSITIVE_ENV_PREFIX = /^(AWS|AZURE|GOOGLE|GCP|GITHUB|GITLAB|NPM|PYPI|TWINE)_/i

export interface Gate5TrialIdentity {
  runId: string
  candidateId: string
  trialId: string
  taskId: string
  attemptIndex: number
}

export interface Gate5BrokerPolicy {
  schemaVersion: 1
  route: ProposalGatewayRoute
  contextWindow: number
  socketTarget: typeof GATE5_MODEL_SOCKET_TARGET
  /** Provider transport retries per model turn; frozen as part of the paid-call budget. */
  maxTransportRetries: number
  /** Additional Responses reasoning continuations. Gate 5 v2 forbids them for exact accounting. */
  reasoningContinuationMaxTurns: 0
  /** Durable evaluation-saga reservation, in integer micro-USD. */
  trialReservationUsdMicros: number
  pricingUnitTokens: 1_000_000
  cacheHitInputUsdMicrosPerUnit: number
  cacheMissInputUsdMicrosPerUnit: number
  outputUsdMicrosPerUnit: number
  /** Conservative provider input ceiling used before dispatch. */
  maxInputTokensPerRequest: number
  maxRequests: number
  maxRequestBytes: number
  /** Aggregate candidate-authored payload bytes admitted before provider dispatch. */
  maxPayloadBytesTotal: number
  /** Aggregate worst-case output reservation; each dispatch reserves route.maxTokens. */
  maxReservedOutputTokens: number
  maxResponseBytes: number
  maxConnections: number
  idleTimeoutMs: number
  requestTimeoutMs: number
}

export interface Gate5UsageTotal {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  events: number
}

export interface Gate5BrokerSigningAuthority {
  /** DER SPKI bytes, base64 encoded; frozen in the pre-launch run intent. */
  publicKeySpki: string
  keyId: `sha256:${string}`
  /** Process-local only. It must never be persisted with the run. */
  privateKey: KeyObject
}

export interface Gate5BrokerEvidence {
  schemaVersion: 1
  protocol: typeof GATE5_BROKER_PROTOCOL
  identity: Gate5TrialIdentity
  policy: Gate5BrokerPolicy
  status: 'complete' | 'incomplete' | 'policy-violation'
  violations: string[]
  dispatchedRequests: number
  payloadBytes: number
  reservedOutputTokens: number
  reservedWorstCaseUsdMicros: number
  settledUsageUsdMicros: number
  receipts: ProposalGatewayReceipt[]
  usage: Gate5UsageTotal
  signature: {
    algorithm: 'Ed25519'
    keyId: `sha256:${string}`
    value: string
  }
}

export interface Gate5TaskOverlayReceipt {
  schemaVersion: 1
  originalSha256: `sha256:${string}`
  overlaySha256: `sha256:${string}`
  agentNetworkMode: 'no-network'
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(bytes: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function assertIdentity(value: Gate5TrialIdentity): void {
  if (
    !SAFE_ID.test(value.runId) ||
    typeof value.candidateId !== 'string' ||
    !CANDIDATE_ID.test(value.candidateId) ||
    !SAFE_ID.test(value.trialId) ||
    !SAFE_ID.test(value.taskId) ||
    !nonNegativeSafeInteger(value.attemptIndex)
  ) {
    throw new Error('gate5 broker: invalid trial identity')
  }
}

function assertPolicy(value: Gate5BrokerPolicy): void {
  const reservedPerRequest =
    value.route.maxTokens *
    (value.maxTransportRetries + 1) *
    (value.reasoningContinuationMaxTurns + 1)
  if (
    value.schemaVersion !== 1 ||
    value.socketTarget !== GATE5_MODEL_SOCKET_TARGET ||
    !nonNegativeSafeInteger(value.maxTransportRetries) ||
    value.maxTransportRetries > 12 ||
    value.reasoningContinuationMaxTurns !== 0 ||
    !Number.isSafeInteger(reservedPerRequest) ||
    !positiveSafeInteger(value.trialReservationUsdMicros) ||
    value.pricingUnitTokens !== 1_000_000 ||
    !nonNegativeSafeInteger(value.cacheHitInputUsdMicrosPerUnit) ||
    !positiveSafeInteger(value.cacheMissInputUsdMicrosPerUnit) ||
    !positiveSafeInteger(value.outputUsdMicrosPerUnit) ||
    value.cacheHitInputUsdMicrosPerUnit > value.cacheMissInputUsdMicrosPerUnit ||
    !positiveSafeInteger(value.maxInputTokensPerRequest) ||
    value.maxInputTokensPerRequest > value.contextWindow ||
    !positiveSafeInteger(value.contextWindow) ||
    !positiveSafeInteger(value.maxRequests) ||
    value.maxRequests > 256 ||
    !positiveSafeInteger(value.maxRequestBytes) ||
    value.maxRequestBytes > 16 * 1024 * 1024 ||
    !positiveSafeInteger(value.maxPayloadBytesTotal) ||
    value.maxPayloadBytesTotal < value.maxRequestBytes ||
    value.maxPayloadBytesTotal > 256 * 1024 * 1024 ||
    !positiveSafeInteger(value.maxReservedOutputTokens) ||
    value.maxReservedOutputTokens < reservedPerRequest ||
    !Number.isSafeInteger(value.maxRequests * reservedPerRequest) ||
    value.maxReservedOutputTokens > value.maxRequests * reservedPerRequest ||
    !positiveSafeInteger(value.maxResponseBytes) ||
    value.maxResponseBytes > 64 * 1024 * 1024 ||
    !positiveSafeInteger(value.maxConnections) ||
    value.maxConnections > 64 ||
    !positiveSafeInteger(value.idleTimeoutMs) ||
    !positiveSafeInteger(value.requestTimeoutMs)
  ) {
    throw new Error('gate5 broker: invalid broker policy')
  }
  const worstCaseUsdMicros = gate5WorstCaseUsdMicrosPerRequest(value)
  if (
    !positiveSafeInteger(worstCaseUsdMicros) ||
    !Number.isSafeInteger(value.maxRequests * worstCaseUsdMicros) ||
    value.maxRequests * worstCaseUsdMicros > value.trialReservationUsdMicros
  ) {
    throw new Error('gate5 broker: policy exceeds the durable USD reservation')
  }
}

function reservedOutputTokensPerRequest(policy: Gate5BrokerPolicy): number {
  return (
    policy.route.maxTokens *
    (policy.maxTransportRetries + 1) *
    (policy.reasoningContinuationMaxTurns + 1)
  )
}

function providerAttemptsPerRequest(policy: Gate5BrokerPolicy): number {
  return (policy.maxTransportRetries + 1) * (policy.reasoningContinuationMaxTurns + 1)
}

function pricedMicros(numerator: bigint, unitTokens: number): number {
  const unit = BigInt(unitTokens)
  const roundedUp = (numerator + unit - 1n) / unit
  const value = Number(roundedUp)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('gate5 broker: USD accounting overflow')
  }
  return value
}

export function gate5WorstCaseUsdMicrosPerRequest(policy: Gate5BrokerPolicy): number {
  const outputTokens = reservedOutputTokensPerRequest(policy)
  return pricedMicros(
    BigInt(policy.maxInputTokensPerRequest) *
      BigInt(providerAttemptsPerRequest(policy)) *
      BigInt(policy.cacheMissInputUsdMicrosPerUnit) +
      BigInt(outputTokens) * BigInt(policy.outputUsdMicrosPerUnit),
    policy.pricingUnitTokens,
  )
}

export function gate5UsageUsdMicros(policy: Gate5BrokerPolicy, usage: Gate5UsageTotal): number {
  return pricedMicros(
    (BigInt(usage.inputTokens) + BigInt(usage.cacheWriteTokens)) *
      BigInt(policy.cacheMissInputUsdMicrosPerUnit) +
      BigInt(usage.cacheReadTokens) * BigInt(policy.cacheHitInputUsdMicrosPerUnit) +
      BigInt(usage.outputTokens) * BigInt(policy.outputUsdMicrosPerUnit),
    policy.pricingUnitTokens,
  )
}

export function assertExactGate5ReconstructedSummary(value: unknown, reconstructed: unknown): void {
  if (stableJson(value) !== stableJson(reconstructed)) {
    throw new Error('gate5 runner: existing summary differs from reconstructed raw evidence')
  }
}

function emptyUsage(): Gate5UsageTotal {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    events: 0,
  }
}

function addUsage(total: Gate5UsageTotal, chunks: StreamChunk[]): void {
  for (const chunk of chunks) {
    if (chunk.type !== 'usage') continue
    const usage = chunk.usage
    const values = [
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens ?? 0,
      usage.cacheWriteTokens ?? 0,
      usage.reasoningTokens ?? 0,
    ]
    if (values.some((value) => !nonNegativeSafeInteger(value))) {
      throw new Error('gate5 broker: provider returned invalid usage')
    }
    total.inputTokens += usage.inputTokens
    total.outputTokens += usage.outputTokens
    total.cacheReadTokens += usage.cacheReadTokens ?? 0
    total.cacheWriteTokens += usage.cacheWriteTokens ?? 0
    total.reasoningTokens += usage.reasoningTokens ?? 0
    total.events += 1
    if (
      !Number.isSafeInteger(total.inputTokens) ||
      !Number.isSafeInteger(total.outputTokens) ||
      !Number.isSafeInteger(total.cacheReadTokens) ||
      !Number.isSafeInteger(total.cacheWriteTokens) ||
      !Number.isSafeInteger(total.reasoningTokens)
    ) {
      throw new Error('gate5 broker: usage overflow')
    }
  }
}

function unsignedEvidence(value: Gate5BrokerEvidence): Omit<Gate5BrokerEvidence, 'signature'> {
  const { signature: _signature, ...unsigned } = value
  return unsigned
}

function signedEvidence(
  authority: Gate5BrokerSigningAuthority,
  value: Omit<Gate5BrokerEvidence, 'signature'>,
): Gate5BrokerEvidence {
  const bytes = Buffer.from(stableJson(value))
  return {
    ...value,
    signature: {
      algorithm: 'Ed25519',
      keyId: authority.keyId,
      value: sign(null, bytes, authority.privateKey).toString('base64'),
    },
  }
}

export function createGate5BrokerSigningAuthority(): Gate5BrokerSigningAuthority {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' })
  return {
    publicKeySpki: publicKeyDer.toString('base64'),
    keyId: sha256(publicKeyDer),
    privateKey,
  }
}

export function sanitizeGate5HarborEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key]) => !SENSITIVE_ENV_KEY.test(key) && !SENSITIVE_ENV_PREFIX.test(key),
    ),
  )
}

function assertContained(root: string, path: string): void {
  const child = relative(root, path)
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error('gate5 task overlay: path escaped its root')
  }
}

async function hashDirectory(rootInput: string): Promise<`sha256:${string}`> {
  const root = resolve(rootInput)
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('gate5 task overlay: root must be a real directory')
  }
  const hash = createHash('sha256')
  async function visit(directory: string): Promise<void> {
    assertContained(root, directory)
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )
    for (const entry of entries) {
      const path = join(directory, entry.name)
      assertContained(root, path)
      const name = relative(root, path).split(sep).join('/')
      const infoBefore = await lstat(path, { bigint: true })
      if (infoBefore.isSymbolicLink()) {
        throw new Error(`gate5 task overlay: symbolic links are forbidden: ${name}`)
      }
      const mode = Number(infoBefore.mode & 0o777n)
      if (infoBefore.isDirectory()) {
        hash.update(`directory\0${name}\0${mode}\0`)
        await visit(path)
        continue
      }
      if (!infoBefore.isFile() || infoBefore.nlink !== 1n) {
        throw new Error(`gate5 task overlay: non-regular or multiply-linked file: ${name}`)
      }
      const bytes = await readFile(path)
      const infoAfter = await lstat(path, { bigint: true })
      if (
        infoBefore.dev !== infoAfter.dev ||
        infoBefore.ino !== infoAfter.ino ||
        infoBefore.size !== infoAfter.size ||
        infoBefore.mtimeNs !== infoAfter.mtimeNs ||
        infoBefore.ctimeNs !== infoAfter.ctimeNs ||
        !infoAfter.isFile() ||
        infoAfter.nlink !== 1n
      ) {
        throw new Error(`gate5 task overlay: file changed while hashing: ${name}`)
      }
      hash.update(`file\0${name}\0${mode}\0${bytes.byteLength}\0`)
      hash.update(bytes)
      hash.update('\0')
    }
  }
  await visit(root)
  return `sha256:${hash.digest('hex')}`
}

function forceAgentOffline(record: Record<string, unknown>, label: string): void {
  const current = record['network_mode']
  if (current !== undefined && current !== 'no-network') {
    throw new Error(`gate5 task overlay: ${label} agent network policy is not no-network`)
  }
  if (record['allowed_hosts'] !== undefined) {
    throw new Error(`gate5 task overlay: ${label} agent allowed_hosts is forbidden`)
  }
  record['network_mode'] = 'no-network'
}

function assertAgentOffline(record: unknown, label: string): void {
  if (
    !isRecord(record) ||
    record['network_mode'] !== 'no-network' ||
    record['allowed_hosts'] !== undefined
  ) {
    throw new Error(`gate5 task overlay: ${label} agent is not locked to no-network`)
  }
}

export async function assertGate5TaskOverlay(input: {
  sourceDir: string
  destinationDir: string
  receipt: Gate5TaskOverlayReceipt
}): Promise<void> {
  if (
    input.receipt.schemaVersion !== 1 ||
    !HASH.test(input.receipt.originalSha256) ||
    !HASH.test(input.receipt.overlaySha256) ||
    input.receipt.agentNetworkMode !== 'no-network'
  ) {
    throw new Error('gate5 task overlay: receipt is invalid')
  }
  if ((await hashDirectory(input.sourceDir)) !== input.receipt.originalSha256) {
    throw new Error('gate5 task overlay: original task digest changed')
  }
  if ((await hashDirectory(input.destinationDir)) !== input.receipt.overlaySha256) {
    throw new Error('gate5 task overlay: overlay digest changed')
  }
  const parsed = parse(await readFile(join(input.destinationDir, 'task.toml'), 'utf8')) as unknown
  if (!isRecord(parsed)) throw new Error('gate5 task overlay: task.toml root is invalid')
  assertAgentOffline(parsed['agent'], 'top-level')
  const steps = parsed['steps']
  if (steps !== undefined) {
    if (!Array.isArray(steps)) throw new Error('gate5 task overlay: steps is not an array')
    for (const [index, step] of steps.entries()) {
      if (!isRecord(step)) throw new Error(`gate5 task overlay: step ${index} is invalid`)
      assertAgentOffline(step['agent'], `step ${index}`)
    }
  }
}

export async function prepareGate5TaskOverlay(input: {
  sourceDir: string
  destinationDir: string
}): Promise<Gate5TaskOverlayReceipt> {
  const sourceDir = resolve(input.sourceDir)
  const destinationDir = resolve(input.destinationDir)
  if (sourceDir === destinationDir) throw new Error('gate5 task overlay: source equals destination')
  if ((await lstat(destinationDir).catch(() => null)) !== null) {
    throw new Error('gate5 task overlay: destination already exists')
  }
  const originalSha256 = await hashDirectory(sourceDir)
  await mkdir(dirname(destinationDir), { recursive: true, mode: 0o700 })
  try {
    await cp(sourceDir, destinationDir, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    })
    if ((await hashDirectory(destinationDir)) !== originalSha256) {
      throw new Error('gate5 task overlay: copied bytes differ from the original task')
    }
    const taskPath = join(destinationDir, 'task.toml')
    const parsed = parse(await readFile(taskPath, 'utf8')) as unknown
    if (!isRecord(parsed)) throw new Error('gate5 task overlay: task.toml root is invalid')
    const topAgent = parsed['agent']
    if (topAgent === undefined) parsed['agent'] = {}
    else if (!isRecord(topAgent)) throw new Error('gate5 task overlay: [agent] is invalid')
    forceAgentOffline(parsed['agent'] as Record<string, unknown>, 'top-level')
    const steps = parsed['steps']
    if (steps !== undefined) {
      if (!Array.isArray(steps)) throw new Error('gate5 task overlay: steps is not an array')
      for (const [index, step] of steps.entries()) {
        if (!isRecord(step)) throw new Error(`gate5 task overlay: step ${index} is invalid`)
        const agent = step['agent']
        if (agent === undefined) step['agent'] = {}
        else if (!isRecord(agent)) {
          throw new Error(`gate5 task overlay: step ${index} agent is invalid`)
        }
        forceAgentOffline(step['agent'] as Record<string, unknown>, `step ${index}`)
      }
    }
    await writeFile(taskPath, stringify(parsed), { flag: 'w' })
    const overlaySha256 = await hashDirectory(destinationDir)
    if ((await hashDirectory(sourceDir)) !== originalSha256) {
      throw new Error('gate5 task overlay: original task changed during materialization')
    }
    const receipt: Gate5TaskOverlayReceipt = {
      schemaVersion: 1,
      originalSha256,
      overlaySha256,
      agentNetworkMode: 'no-network',
    }
    await assertGate5TaskOverlay({ sourceDir, destinationDir, receipt })
    return receipt
  } catch (error) {
    await rm(destinationDir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export interface Gate5CredentialBrokerHandle {
  socketPath: string
  complete: () => Promise<Gate5BrokerEvidence>
}

export async function startGate5CredentialBroker(input: {
  socketPath: string
  stateDir: string
  identity: Gate5TrialIdentity
  policy: Gate5BrokerPolicy
  adapter: LlmAdapter
  authority: Gate5BrokerSigningAuthority
}): Promise<Gate5CredentialBrokerHandle> {
  assertIdentity(input.identity)
  assertPolicy(input.policy)
  if (!isAbsolute(input.socketPath) || !isAbsolute(input.stateDir)) {
    throw new Error('gate5 broker: socket and state paths must be absolute')
  }
  const socketParent = await lstat(dirname(input.socketPath)).catch(() => null)
  if (
    socketParent === null ||
    !socketParent.isDirectory() ||
    socketParent.isSymbolicLink() ||
    (socketParent.mode & 0o077) !== 0
  ) {
    throw new Error('gate5 broker: socket parent must be a private real directory')
  }
  const usage = emptyUsage()
  const violations: string[] = []
  let dispatchedRequests = 0
  let payloadBytes = 0
  let reservedOutputTokens = 0
  let reservedWorstCaseUsdMicros = 0
  let settledUsageUsdMicros = 0
  const handler = createProposalGatewayLlmHandler(input.adapter, input.policy.route)
  const gateway: ProposalGatewayHandle = await startProposalGateway({
    socketPath: input.socketPath,
    stateDir: input.stateDir,
    route: input.policy.route,
    maxRequestBytes: input.policy.maxRequestBytes,
    maxConnections: input.policy.maxConnections,
    idleTimeoutMs: input.policy.idleTimeoutMs,
    requestTimeoutMs: input.policy.requestTimeoutMs,
    async handle(payload, context) {
      if (dispatchedRequests >= input.policy.maxRequests) {
        violations.push('request-count-exceeded')
        throw new Error('gate5 broker: request count exceeded')
      }
      const requestPayloadBytes = Buffer.byteLength(JSON.stringify(payload))
      if (payloadBytes + requestPayloadBytes > input.policy.maxPayloadBytesTotal) {
        violations.push('payload-bytes-total-exceeded')
        throw new Error('gate5 broker: aggregate payload byte limit exceeded')
      }
      const outputReservation = reservedOutputTokensPerRequest(input.policy)
      if (reservedOutputTokens + outputReservation > input.policy.maxReservedOutputTokens) {
        violations.push('reserved-output-tokens-exceeded')
        throw new Error('gate5 broker: aggregate output reservation exceeded')
      }
      const usdReservation = gate5WorstCaseUsdMicrosPerRequest(input.policy)
      if (reservedWorstCaseUsdMicros + usdReservation > input.policy.trialReservationUsdMicros) {
        violations.push('worst-case-usd-reservation-exceeded')
        throw new Error('gate5 broker: durable USD reservation exceeded')
      }
      payloadBytes += requestPayloadBytes
      reservedOutputTokens += outputReservation
      reservedWorstCaseUsdMicros += usdReservation
      dispatchedRequests += 1
      const result = await handler(payload, context)
      const responseBytes = Buffer.byteLength(JSON.stringify(result))
      if (responseBytes > input.policy.maxResponseBytes) {
        violations.push('response-bytes-exceeded')
        throw new ProposalGatewayHandlerFailure(
          'gate5 broker: response byte limit exceeded',
          result.attempts ?? [],
        )
      }
      try {
        addUsage(usage, result.chunks)
        settledUsageUsdMicros = gate5UsageUsdMicros(input.policy, usage)
        if (settledUsageUsdMicros > reservedWorstCaseUsdMicros) {
          throw new Error('gate5 broker: provider usage exceeded its worst-case reservation')
        }
      } catch (error) {
        violations.push('invalid-provider-usage')
        throw new ProposalGatewayHandlerFailure(
          error instanceof Error ? error.message : 'gate5 broker: invalid provider usage',
          result.attempts ?? [],
        )
      }
      return result
    },
  })
  // The bind-mounted socket is the capability. The containing host directory
  // remains 0700; the container sees only this socket inode at a fixed path.
  try {
    await chmod(gateway.socketPath, 0o666)
  } catch (error) {
    await gateway.close().catch(() => undefined)
    throw error
  }
  let completed: Gate5BrokerEvidence | undefined
  return {
    socketPath: gateway.socketPath,
    async complete() {
      if (completed !== undefined) return completed
      await gateway.close()
      const receipts = gateway.receipts()
      let status: Gate5BrokerEvidence['status'] =
        violations.length === 0 ? 'complete' : 'policy-violation'
      if (status === 'complete') {
        try {
          assertCompletedProposalGatewayReceipts(
            receipts,
            input.policy.route,
            'gate5 broker evidence',
          )
          if (
            receipts.length !== dispatchedRequests ||
            receipts.some((receipt) => receipt.error !== undefined) ||
            usage.events !== dispatchedRequests ||
            usage.outputTokens > reservedOutputTokens
          ) {
            status = 'incomplete'
          }
        } catch {
          status = 'incomplete'
        }
      }
      completed = signedEvidence(input.authority, {
        schemaVersion: 1,
        protocol: GATE5_BROKER_PROTOCOL,
        identity: { ...input.identity },
        policy: structuredClone(input.policy),
        status,
        violations: [...new Set(violations)].sort(),
        dispatchedRequests,
        payloadBytes,
        reservedOutputTokens,
        reservedWorstCaseUsdMicros,
        settledUsageUsdMicros,
        receipts,
        usage: { ...usage },
      })
      return completed
    },
  }
}

function assertUsage(value: unknown): asserts value is Gate5UsageTotal {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !==
      'cacheReadTokens,cacheWriteTokens,events,inputTokens,outputTokens,reasoningTokens' ||
    !nonNegativeSafeInteger(value['inputTokens']) ||
    !nonNegativeSafeInteger(value['outputTokens']) ||
    !nonNegativeSafeInteger(value['cacheReadTokens']) ||
    !nonNegativeSafeInteger(value['cacheWriteTokens']) ||
    !nonNegativeSafeInteger(value['reasoningTokens']) ||
    !positiveSafeInteger(value['events'])
  ) {
    throw new Error('gate5 broker evidence: usage is invalid')
  }
}

export function assertCompleteGate5BrokerEvidence(
  value: unknown,
  expected: {
    identity: Gate5TrialIdentity
    policy: Gate5BrokerPolicy
    publicKeySpki: string
  },
): Gate5BrokerEvidence {
  if (!isRecord(value)) throw new Error('gate5 broker evidence: not an object')
  const evidence = value as unknown as Gate5BrokerEvidence
  if (
    evidence.schemaVersion !== 1 ||
    evidence.protocol !== GATE5_BROKER_PROTOCOL ||
    !isRecord(evidence.signature) ||
    evidence.signature.algorithm !== 'Ed25519' ||
    typeof evidence.signature.keyId !== 'string' ||
    !HASH.test(evidence.signature.keyId) ||
    typeof evidence.signature.value !== 'string'
  ) {
    throw new Error('gate5 broker evidence: schema mismatch')
  }
  let publicKeyDer: Buffer
  try {
    publicKeyDer = Buffer.from(expected.publicKeySpki, 'base64')
  } catch {
    throw new Error('gate5 broker evidence: invalid public key')
  }
  if (sha256(publicKeyDer) !== evidence.signature.keyId) {
    throw new Error('gate5 broker evidence: signing key identity mismatch')
  }
  const publicKey = createPublicKey({ key: publicKeyDer, type: 'spki', format: 'der' })
  if (
    !verify(
      null,
      Buffer.from(stableJson(unsignedEvidence(evidence))),
      publicKey,
      Buffer.from(evidence.signature.value, 'base64'),
    )
  ) {
    throw new Error('gate5 broker evidence: signature verification failed')
  }
  assertIdentity(evidence.identity)
  assertPolicy(evidence.policy)
  if (stableJson(evidence.identity) !== stableJson(expected.identity)) {
    throw new Error('gate5 broker evidence: trial identity mismatch')
  }
  if (stableJson(evidence.policy) !== stableJson(expected.policy)) {
    throw new Error('gate5 broker evidence: policy mismatch')
  }
  if (
    evidence.status !== 'complete' ||
    !Array.isArray(evidence.violations) ||
    evidence.violations.length !== 0
  ) {
    throw new Error('gate5 broker evidence: trial is not complete')
  }
  if (
    !positiveSafeInteger(evidence.dispatchedRequests) ||
    evidence.dispatchedRequests > expected.policy.maxRequests ||
    !positiveSafeInteger(evidence.payloadBytes) ||
    evidence.payloadBytes > expected.policy.maxPayloadBytesTotal ||
    evidence.reservedOutputTokens !==
      evidence.dispatchedRequests * reservedOutputTokensPerRequest(expected.policy) ||
    evidence.reservedOutputTokens > expected.policy.maxReservedOutputTokens ||
    evidence.reservedWorstCaseUsdMicros !==
      evidence.dispatchedRequests * gate5WorstCaseUsdMicrosPerRequest(expected.policy) ||
    evidence.reservedWorstCaseUsdMicros > expected.policy.trialReservationUsdMicros ||
    !nonNegativeSafeInteger(evidence.settledUsageUsdMicros) ||
    evidence.settledUsageUsdMicros > evidence.reservedWorstCaseUsdMicros ||
    !Array.isArray(evidence.receipts) ||
    evidence.receipts.length !== evidence.dispatchedRequests ||
    evidence.receipts.some((receipt) => receipt.error !== undefined)
  ) {
    throw new Error('gate5 broker evidence: request accounting mismatch')
  }
  assertCompletedProposalGatewayReceipts(
    evidence.receipts,
    expected.policy.route,
    'gate5 broker evidence',
  )
  assertUsage(evidence.usage)
  const accountedInputTokens =
    BigInt(evidence.usage.inputTokens) +
    BigInt(evidence.usage.cacheReadTokens) +
    BigInt(evidence.usage.cacheWriteTokens)
  const maximumInputTokens =
    BigInt(evidence.dispatchedRequests) *
    BigInt(expected.policy.maxInputTokensPerRequest) *
    BigInt(providerAttemptsPerRequest(expected.policy))
  if (
    evidence.usage.events !== evidence.dispatchedRequests ||
    accountedInputTokens > maximumInputTokens ||
    evidence.usage.outputTokens > evidence.reservedOutputTokens ||
    evidence.settledUsageUsdMicros !== gate5UsageUsdMicros(expected.policy, evidence.usage)
  ) {
    throw new Error('gate5 broker evidence: usage accounting mismatch')
  }
  return evidence
}

export function assertGate5BrokerSessionAccounting(
  evidence: unknown,
  expected: {
    identity: Gate5TrialIdentity
    policy: Gate5BrokerPolicy
    publicKeySpki: string
    sessionUsage: unknown
  },
): Gate5BrokerEvidence {
  const broker = assertCompleteGate5BrokerEvidence(evidence, expected)
  assertUsage(expected.sessionUsage)
  if (stableJson(expected.sessionUsage) !== stableJson(broker.usage)) {
    throw new Error('gate5 broker evidence: broker/session usage mismatch')
  }
  return broker
}

export async function writeGate5ExecutionTerminal(input: {
  path: string
  value: unknown
  trials: Array<{
    evidence: unknown
    identity: Gate5TrialIdentity
    policy: Gate5BrokerPolicy
    publicKeySpki: string
    sessionUsage: unknown
  }>
}): Promise<string> {
  if (!isAbsolute(input.path) || input.trials.length === 0) {
    throw new Error('gate5 terminal: invalid publication request')
  }
  for (const trial of input.trials) {
    assertGate5BrokerSessionAccounting(trial.evidence, trial)
  }
  const bytes = JSON.stringify(input.value, null, 2) + '\n'
  const temporary = `${input.path}.tmp-${process.pid}-${randomUUID()}`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    if ((await lstat(input.path).catch(() => null)) !== null) {
      throw new Error('gate5 terminal: authority already exists')
    }
    await rename(temporary, input.path)
    const directory = await open(dirname(input.path), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
    return bytes
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}
