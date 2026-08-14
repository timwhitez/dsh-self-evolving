import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  SPLIT_SIZES,
  commitSplit,
  deterministicSplit,
  type SplitAssignment,
  type SplitCommitment,
  type TaskMeta,
} from '@dsh-rsi/search'

const digestPattern = /^sha256:[0-9a-f]{64}$/

export interface CeremonyTask extends TaskMeta {
  modifiedInTb21?: boolean
}

export interface CeremonyRequest {
  operation: 'ceremony'
  ceremonyId: string
  privateDir: string
  publicDir: string
  tasks: CeremonyTask[]
  datasetDigest: string
  protocolHash: string
  splitterCodeHash: string
}

export interface CandidateLockIdentity {
  runId: string
  candidateId: string
  sourceDigest: string
  capsuleDigest: string
  runManifestDigest: string
  baselineCandidateId: string
  baselineCapsuleDigest: string
  modelRouteHash: string
  protocolHash: string
  sealedPlanHash: string
  analysisContainerHash: string
}

export interface LockRequest {
  operation: 'lock'
  privateDir: string
  publicDir: string
  identity: CandidateLockIdentity
}

export interface AuthorizeRequest {
  operation: 'authorize'
  privateDir: string
  principal: 'selector' | 'proposer'
  requestedOperation: string
}

export type ServiceRequest = CeremonyRequest | LockRequest | AuthorizeRequest

export interface ControllerSplitView {
  schemaVersion: 1
  ceremonyId: string
  datasetDigest: string
  protocolHash: string
  inputMetadataHash: string
  splitterCodeHash: string
  difficultyDimension: 'OMITTED'
  createdAt: string
  serviceIdentity: {
    uid: number
    gid: number
    pid: number
    processStartTicks: string
    privateDirDevice: string
    privateDirInode: string
  }
  commitment: SplitCommitment
  observedTaskIds: string[]
  guardHandles: string[]
  sealedCount: number
}

interface PrivateCeremonyStateBody {
  schemaVersion: 1
  ceremonyId: string
  datasetDigest: string
  protocolHash: string
  inputMetadataHash: string
  splitterCodeHash: string
  privateDir: string
  publicDir: string
  seedHex: string
  assignment: SplitAssignment[]
  controllerView: ControllerSplitView
  candidateLock: CandidateLockReceipt | null
}

interface PrivateCeremonyState extends PrivateCeremonyStateBody {
  stateHash: string
}

export type ServiceResponse =
  | { ok: true; operation: 'ceremony'; view: ControllerSplitView; idempotent: boolean }
  | { ok: true; operation: 'lock'; identity: CandidateLockIdentity; idempotent: boolean }
  | { ok: true; operation: 'authorize'; allowed: true }

export interface CandidateLockReceipt {
  schemaVersion: 1
  ceremonyId: string
  splitMerkleRoot: string
  identity: CandidateLockIdentity
  lockedAt: string
  lockHash: string
}

function canonical(value: unknown): string {
  if (value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function validateDigest(value: string, field: string): void {
  if (!digestPattern.test(value)) throw new Error(`INVALID_REQUEST: ${field} must be sha256`)
}

function timeoutClass(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('INVALID_TASK: timeout')
  if (seconds <= 900) return 'short<=900'
  if (seconds <= 2400) return 'medium<=2400'
  return 'long>2400'
}

function publicSplitTasks(tasks: CeremonyTask[]): TaskMeta[] {
  return tasks.map((task) => ({
    taskId: task.taskId,
    category: [
      task.category,
      `timeout:${timeoutClass(task.agentTimeoutSec)}`,
      `network:${task.allowInternet ? 'yes' : 'no'}`,
      `modified:${task.modifiedInTb21 === undefined ? 'unknown' : task.modifiedInTb21 ? 'yes' : 'no'}`,
    ].join('|'),
    difficulty: 'OMITTED',
    agentTimeoutSec: task.agentTimeoutSec,
    allowInternet: task.allowInternet,
  }))
}

function validateTasks(tasks: CeremonyTask[]): CeremonyTask[] {
  if (tasks.length !== 89)
    throw new Error(`INVALID_INVENTORY: expected 89 tasks; got ${tasks.length}`)
  const sorted = [...tasks].sort((a, b) => a.taskId.localeCompare(b.taskId))
  const ids = new Set<string>()
  for (const task of sorted) {
    if (!task.taskId || ids.has(task.taskId))
      throw new Error('INVALID_INVENTORY: duplicate/empty task')
    if (!task.category) throw new Error(`INVALID_TASK: category missing for ${task.taskId}`)
    timeoutClass(task.agentTimeoutSec)
    ids.add(task.taskId)
  }
  return sorted
}

async function syncDir(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function atomicJson(path: string, value: unknown, mode: number): Promise<void> {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
  const handle = await open(temp, 'wx', mode)
  try {
    await handle.writeFile(canonical(value) + '\n')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, path)
  await chmod(path, mode)
  await syncDir(dirname(path))
}

async function publishJson(path: string, value: unknown, mode: number): Promise<void> {
  const expected = canonical(value) + '\n'
  const handle = await open(path, 'wx', mode).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error(`PUBLIC_RECEIPT_CONFLICT: symlink refused at ${path}`, { cause: error })
    }
    const existing = await readFile(path, 'utf8')
    if (existing !== expected) {
      throw new Error(`PUBLIC_RECEIPT_CONFLICT: ${path}`, { cause: error })
    }
    return null
  })
  if (handle === null) return
  try {
    await handle.writeFile(expected)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(path, mode)
  await syncDir(dirname(path))
}

async function prepareDirs(privateDir: string, publicDir: string): Promise<void> {
  const privatePath = resolve(privateDir)
  const publicPath = resolve(publicDir)
  if (
    privatePath === publicPath ||
    privatePath.startsWith(publicPath + '/') ||
    publicPath.startsWith(privatePath + '/')
  ) {
    throw new Error('INVALID_LAYOUT: private and public dirs must be disjoint')
  }
  await mkdir(privateDir, { recursive: true, mode: 0o700 })
  if ((await lstat(privateDir)).isSymbolicLink()) {
    throw new Error('INVALID_LAYOUT: private dir must not be a symlink')
  }
  await chmod(privateDir, 0o700)
  await mkdir(publicDir, { recursive: true, mode: 0o755 })
  if ((await lstat(publicDir)).isSymbolicLink()) {
    throw new Error('INVALID_LAYOUT: public dir must not be a symlink')
  }
  await chmod(publicDir, 0o755)
  const privateMode = (await stat(privateDir)).mode & 0o777
  if (privateMode !== 0o700) throw new Error('INVALID_LAYOUT: private dir must be mode 0700')
}

async function validatePrivateDir(privateDir: string): Promise<void> {
  const info = await lstat(privateDir)
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700) {
    throw new Error('INVALID_LAYOUT: private dir must be a non-symlink mode-0700 directory')
  }
}

async function withServiceLock<T>(privateDir: string, action: () => Promise<T>): Promise<T> {
  const lockPath = join(privateDir, '.service.lock')
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(lockPath, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const owner = await readFile(lockPath, 'utf8').catch(() => '')
    const [pidText, expectedStart] = owner.trim().split(':')
    const pid = Number(pidText)
    const actualStart = Number.isSafeInteger(pid) ? await processStartTicks(pid) : null
    if (actualStart !== null && actualStart === expectedStart) {
      throw new Error('SERVICE_BUSY: another writer holds the lock', { cause: error })
    }
    await rm(lockPath, { force: true })
    handle = await open(lockPath, 'wx', 0o600)
  }
  try {
    const start = await processStartTicks(process.pid)
    if (start === null) throw new Error('SERVICE_IDENTITY_UNAVAILABLE')
    await handle.writeFile(`${process.pid}:${start}\n`)
    await handle.sync()
    return await action()
  } finally {
    await handle.close()
    await rm(lockPath, { force: true })
  }
}

async function processStartTicks(pid: number): Promise<string | null> {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8')
    const suffix = raw
      .slice(raw.lastIndexOf(') ') + 2)
      .trim()
      .split(/\s+/)
    return suffix[19] ?? null
  } catch {
    return null
  }
}

function sealState(body: PrivateCeremonyStateBody): PrivateCeremonyState {
  return { ...body, stateHash: sha256(canonical(body)) }
}

function stateBody(state: PrivateCeremonyState): PrivateCeremonyStateBody {
  return {
    schemaVersion: state.schemaVersion,
    ceremonyId: state.ceremonyId,
    datasetDigest: state.datasetDigest,
    protocolHash: state.protocolHash,
    inputMetadataHash: state.inputMetadataHash,
    splitterCodeHash: state.splitterCodeHash,
    privateDir: state.privateDir,
    publicDir: state.publicDir,
    seedHex: state.seedHex,
    assignment: state.assignment,
    controllerView: state.controllerView,
    candidateLock: state.candidateLock,
  }
}

async function readState(privateDir: string): Promise<PrivateCeremonyState> {
  const statePath = join(privateDir, 'ceremony-state.json')
  const stateInfo = await lstat(statePath).catch(() => null)
  if (stateInfo?.isSymbolicLink()) throw new Error('EVIDENCE_CORRUPT: private state is a symlink')
  const raw = await readFile(statePath, 'utf8').catch(() => null)
  if (raw === null) throw new Error('CEREMONY_NOT_INITIALIZED')
  const state = JSON.parse(raw) as PrivateCeremonyState
  const { stateHash, ...body } = state
  if (!digestPattern.test(stateHash) || sha256(canonical(body)) !== stateHash) {
    throw new Error('EVIDENCE_CORRUPT: private ceremony state hash mismatch')
  }
  return state
}

async function ceremony(request: CeremonyRequest): Promise<ServiceResponse> {
  validateDigest(request.datasetDigest, 'datasetDigest')
  validateDigest(request.protocolHash, 'protocolHash')
  validateDigest(request.splitterCodeHash, 'splitterCodeHash')
  if (!request.ceremonyId) throw new Error('INVALID_REQUEST: ceremonyId missing')
  const tasks = validateTasks(request.tasks)
  const inputMetadataHash = sha256(canonical(tasks))
  await prepareDirs(request.privateDir, request.publicDir)
  const privateDir = resolve(request.privateDir)
  const publicDir = resolve(request.publicDir)
  return withServiceLock(request.privateDir, async () => {
    const existing = await readFile(join(request.privateDir, 'ceremony-state.json'), 'utf8').catch(
      () => null,
    )
    if (existing !== null) {
      const state = await readState(request.privateDir)
      const same =
        state.ceremonyId === request.ceremonyId &&
        state.datasetDigest === request.datasetDigest &&
        state.protocolHash === request.protocolHash &&
        state.splitterCodeHash === request.splitterCodeHash &&
        state.inputMetadataHash === inputMetadataHash &&
        state.privateDir === privateDir &&
        state.publicDir === publicDir
      if (!same) throw new Error('CEREMONY_ALREADY_EXISTS: immutable identity mismatch')
      await publishJson(join(publicDir, 'split-commitment.json'), state.controllerView, 0o644)
      return { ok: true, operation: 'ceremony', view: state.controllerView, idempotent: true }
    }
    const seed = randomBytes(32)
    const seedCommitment = sha256(
      Buffer.concat([seed, Buffer.from(request.datasetDigest), Buffer.from(request.protocolHash)]),
    )
    const seedValue = BigInt(`0x${seed.toString('hex')}`)
    const assignment = deterministicSplit(publicSplitTasks(tasks), seedValue)
    const commitment = commitSplit(assignment, seedCommitment)
    const observedTaskIds = assignment
      .filter((entry) => entry.label === 'dev-observed')
      .map((entry) => entry.taskId)
      .sort()
    const guardHandles = assignment
      .filter((entry) => entry.label === 'dev-guard')
      .map((entry) => sha256(Buffer.concat([seed, Buffer.from(`guard-handle:${entry.taskId}`)])))
      .sort()
    const privateInfo = await stat(privateDir)
    const processStart = await processStartTicks(process.pid)
    if (processStart === null) throw new Error('SERVICE_IDENTITY_UNAVAILABLE')
    const view: ControllerSplitView = {
      schemaVersion: 1,
      ceremonyId: request.ceremonyId,
      datasetDigest: request.datasetDigest,
      protocolHash: request.protocolHash,
      inputMetadataHash,
      splitterCodeHash: request.splitterCodeHash,
      difficultyDimension: 'OMITTED',
      createdAt: new Date().toISOString(),
      serviceIdentity: {
        uid: process.getuid?.() ?? -1,
        gid: process.getgid?.() ?? -1,
        pid: process.pid,
        processStartTicks: processStart,
        privateDirDevice: String(privateInfo.dev),
        privateDirInode: String(privateInfo.ino),
      },
      commitment,
      observedTaskIds,
      guardHandles,
      sealedCount: SPLIT_SIZES.sealed,
    }
    const state = sealState({
      schemaVersion: 1,
      ceremonyId: request.ceremonyId,
      datasetDigest: request.datasetDigest,
      protocolHash: request.protocolHash,
      inputMetadataHash,
      splitterCodeHash: request.splitterCodeHash,
      privateDir,
      publicDir,
      seedHex: seed.toString('hex'),
      assignment,
      controllerView: view,
      candidateLock: null,
    })
    await atomicJson(join(request.privateDir, 'ceremony-state.json'), state, 0o600)
    await publishJson(join(request.publicDir, 'split-commitment.json'), view, 0o644)
    return { ok: true, operation: 'ceremony', view, idempotent: false }
  })
}

function validateIdentity(identity: CandidateLockIdentity): void {
  if (!identity.runId) throw new Error('INVALID_LOCK: runId missing')
  for (const field of [
    'candidateId',
    'sourceDigest',
    'capsuleDigest',
    'runManifestDigest',
    'baselineCandidateId',
    'baselineCapsuleDigest',
    'modelRouteHash',
    'protocolHash',
    'sealedPlanHash',
    'analysisContainerHash',
  ] as const) {
    validateDigest(identity[field], field)
  }
}

async function lockCandidate(request: LockRequest): Promise<ServiceResponse> {
  validateIdentity(request.identity)
  await validatePrivateDir(request.privateDir)
  return withServiceLock(request.privateDir, async () => {
    const state = await readState(request.privateDir)
    if (
      resolve(request.privateDir) !== state.privateDir ||
      resolve(request.publicDir) !== state.publicDir
    ) {
      throw new Error('INVALID_LAYOUT: lock request does not match ceremony layout')
    }
    await prepareDirs(state.privateDir, state.publicDir)
    if (state.candidateLock !== null) {
      if (canonical(state.candidateLock.identity) !== canonical(request.identity)) {
        throw new Error('CANDIDATE_ALREADY_LOCKED: identity mismatch')
      }
      await publishJson(join(request.publicDir, 'candidate-lock.json'), state.candidateLock, 0o644)
      return {
        ok: true,
        operation: 'lock',
        identity: state.candidateLock.identity,
        idempotent: true,
      }
    }
    const receiptBody = {
      schemaVersion: 1 as const,
      ceremonyId: state.ceremonyId,
      splitMerkleRoot: state.controllerView.commitment.merkleRoot,
      identity: request.identity,
      lockedAt: new Date().toISOString(),
    }
    const receipt: CandidateLockReceipt = {
      ...receiptBody,
      lockHash: sha256(canonical(receiptBody)),
    }
    const next = sealState({ ...stateBody(state), candidateLock: receipt })
    await atomicJson(join(request.privateDir, 'ceremony-state.json'), next, 0o600)
    await publishJson(join(request.publicDir, 'candidate-lock.json'), receipt, 0o644)
    return { ok: true, operation: 'lock', identity: request.identity, idempotent: false }
  })
}

async function authorize(request: AuthorizeRequest): Promise<ServiceResponse> {
  await validatePrivateDir(request.privateDir)
  return withServiceLock(request.privateDir, async () => {
    const state = await readState(request.privateDir)
    if (state.candidateLock !== null) {
      throw new Error(
        `LOCKED: ${request.principal}/${request.requestedOperation} refused after candidate lock`,
      )
    }
    return { ok: true, operation: 'authorize', allowed: true }
  })
}

export async function handleServiceRequest(request: ServiceRequest): Promise<ServiceResponse> {
  if (request.operation === 'ceremony') return ceremony(request)
  if (request.operation === 'lock') return lockCandidate(request)
  if (request.operation === 'authorize') return authorize(request)
  throw new Error('INVALID_REQUEST: unsupported operation')
}
