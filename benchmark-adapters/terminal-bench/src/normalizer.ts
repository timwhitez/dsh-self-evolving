/**
 * Per-trial result normalizer (spec 07 §4 Accept).
 *
 * A TB trial produces a Harbor job artifact tree. This module normalizes one
 * trial's raw artifacts into a content-addressed, canonical record. The rules
 * are fail-closed (spec 07 §1 rule 7):
 *
 *   - a planned trial whose result.json / reward / trajectory / candidate hash
 *     is missing, corrupt, unattributable or timed out is an explicit FAIL —
 *     it NEVER silently disappears from the denominator;
 *   - only pre-registered, reward-independent infrastructure classifications
 *     may be retried; everything else counts;
 *   - the normalized record is deterministic: re-parsing the same raw artifacts
 *     yields the same SHA-256.
 */
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { TextDecoder } from 'node:util'

export type TrialStatus = 'pass' | 'fail' | 'invalid'

/** The only classifications eligible for retry (spec 07 §1 rule 7). */
export type InfraClass = 'docker-build-error' | 'network-pull-error' | 'oom-crash' | null

export interface RawTrialArtifacts {
  /** Path to the Harbor job trial directory (e.g. jobs/<job>/<trial-xyz>). */
  trialDir: string
  /** The candidate identity this trial was planned for (never inferred from artifacts). */
  expectedCandidateId: string
  /** The task id this trial was planned for (never inferred from artifacts). */
  taskId: string
  /** The attempt this trial was planned for (never inferred from artifacts). */
  expectedAttemptIndex: number
  /** Require Harbor's real ACP/ATIF evidence set, not a script stand-in. */
  requireAcpEvidence?: boolean
}

export interface NormalizedTrial {
  /** Canonical trial key: candidateId/taskId/attemptIndex. */
  key: string
  taskId: string
  candidateId: string | null
  attemptIndex: number | null
  status: TrialStatus
  /** 0.0/1.0 reward; null when unattributable (→ invalid). */
  reward: number | null
  /** sha256 of the trajectory file, or null when missing (→ invalid). */
  trajectoryHash: string | null
  /** Hashes of Harbor's raw ACP wire events and summary. */
  acpEventsHash: string | null
  acpSummaryHash: string | null
  /** sha256 of the normalized record itself (content-addressed). */
  recordHash: string
  /** True if the trial is retry-eligible per the infra classification. */
  retryEligible: boolean
  infraClass: InfraClass
  /** Human-readable reason for the assigned status. */
  reason: string
}

type PresentArtifact = {
  state: 'present'
  bytes: Buffer
  hash: string
}

type ArtifactResolution =
  | PresentArtifact
  | { state: 'missing'; hash: null }
  | { state: 'invalid'; hash: string | null; reason: string }

type DirectorySnapshot =
  | { state: 'present'; stats: Awaited<ReturnType<typeof lstat>> }
  | { state: 'missing' }
  | { state: 'invalid'; reason: string }

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'UNKNOWN'
}

function sameStableFile(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.nlink === 1 &&
    right.nlink === 1 &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function sameStableDirectory(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    left.isDirectory() &&
    right.isDirectory() &&
    !left.isSymbolicLink() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

async function inspectDirectory(path: string, label: string): Promise<DirectorySnapshot> {
  try {
    const entry = await lstat(path)
    return entry.isDirectory() && !entry.isSymbolicLink()
      ? { state: 'present', stats: entry }
      : { state: 'invalid', reason: `${label} is not a real directory` }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' }
    return { state: 'invalid', reason: `${label} cannot be inspected (${errorCode(error)})` }
  }
}

function directoryIntegrityReason(
  before: DirectorySnapshot,
  after: DirectorySnapshot,
  label: string,
): string | null {
  if (before.state === 'invalid') return before.reason
  if (after.state === 'invalid') return after.reason
  if (before.state !== after.state) return `${label} changed while artifacts were collected`
  if (before.state === 'missing' || after.state === 'missing') return null
  return sameStableDirectory(before.stats, after.stats)
    ? null
    : `${label} changed while artifacts were collected`
}

async function readStableArtifact(path: string, label: string): Promise<ArtifactResolution> {
  const file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      return error
    },
  )
  if (file === null) return { state: 'missing', hash: null }
  if (file instanceof Error) {
    return {
      state: 'invalid',
      hash: null,
      reason: `${label} is not readable (${errorCode(file)})`,
    }
  }
  try {
    const before = await file.stat()
    const pathBefore = await lstat(path).catch(() => null)
    if (pathBefore === null || !sameStableFile(before, pathBefore)) {
      return {
        state: 'invalid',
        hash: null,
        reason: `${label} is not one stable regular file`,
      }
    }
    const bytes = await file.readFile()
    const after = await file.stat()
    const pathAfter = await lstat(path).catch(() => null)
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (
      pathAfter === null ||
      !sameStableFile(before, after) ||
      !sameStableFile(after, pathAfter) ||
      bytes.byteLength !== after.size
    ) {
      return { state: 'invalid', hash, reason: `${label} changed while it was collected` }
    }
    return { state: 'present', bytes, hash }
  } catch (error) {
    return {
      state: 'invalid',
      hash: null,
      reason: `${label} could not be collected (${errorCode(error)})`,
    }
  } finally {
    await file.close()
  }
}

async function resolveSingleArtifact(label: string, paths: string[]): Promise<ArtifactResolution> {
  let selected: PresentArtifact | null = null
  for (const path of paths) {
    const artifact = await readStableArtifact(path, label)
    if (artifact.state === 'invalid') return artifact
    if (artifact.state === 'missing') continue
    if (selected !== null) {
      return {
        state: 'invalid',
        hash: null,
        reason: `${label} is ambiguous because multiple aliases exist`,
      }
    }
    selected = artifact
  }
  return selected ?? { state: 'missing', hash: null }
}

function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function parseJsonArtifact(artifact: ArtifactResolution): unknown | null {
  if (artifact.state !== 'present') return null
  const text = decodeUtf8(artifact.bytes)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validJsonObjectArtifact(artifact: ArtifactResolution): boolean {
  return artifact.state !== 'present' || isRecord(parseJsonArtifact(artifact))
}

function validJsonLinesArtifact(artifact: ArtifactResolution): boolean {
  if (artifact.state !== 'present') return true
  const text = decodeUtf8(artifact.bytes)
  if (text === null) return false
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
  if (lines.length === 0 || lines.some((line) => line.length === 0)) return false
  return lines.every((line) => {
    try {
      return isRecord(JSON.parse(line))
    } catch {
      return false
    }
  })
}

function normalizeExceptionClass(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
}

/**
 * Parse only pre-registered infrastructure tokens. Detection alone never
 * grants retry eligibility; attribution and artifact integrity are checked
 * separately below.
 */
function registeredInfrastructureClass(value: string): Exclude<InfraClass, null> | null {
  const normalized = normalizeExceptionClass(value)
  return normalized === 'docker-build-error' ||
    normalized === 'network-pull-error' ||
    normalized === 'oom-crash'
    ? normalized
    : null
}

interface InfrastructureDetection {
  detected: Exclude<InfraClass, null> | null
  integrityReason: string | null
}

/**
 * `classification` is authoritative when present. `type` is used only when
 * classification is absent; two different registered values are corrupt.
 */
function classifyInfrastructureException(exceptionInfo: unknown): InfrastructureDetection {
  if (exceptionInfo === null || exceptionInfo === undefined) {
    return { detected: null, integrityReason: null }
  }
  if (!isRecord(exceptionInfo)) {
    return { detected: null, integrityReason: 'exception_info is not an object' }
  }
  const classificationPresent = Object.hasOwn(exceptionInfo, 'classification')
  const typePresent = Object.hasOwn(exceptionInfo, 'type')
  const classificationRaw = exceptionInfo['classification']
  const typeRaw = exceptionInfo['type']
  if (classificationPresent && typeof classificationRaw !== 'string') {
    return { detected: null, integrityReason: 'exception_info.classification is not a string' }
  }
  if (typePresent && typeof typeRaw !== 'string') {
    return { detected: null, integrityReason: 'exception_info.type is not a string' }
  }

  const classification =
    typeof classificationRaw === 'string' ? registeredInfrastructureClass(classificationRaw) : null
  const type = typeof typeRaw === 'string' ? registeredInfrastructureClass(typeRaw) : null
  if (classificationPresent) {
    if (classification !== null && type !== null && classification !== type) {
      return {
        detected: null,
        integrityReason: `conflicting registered infrastructure classes: ${classification} != ${type}`,
      }
    }
    return { detected: classification, integrityReason: null }
  }
  return { detected: type, integrityReason: null }
}

type RewardResolution =
  | { state: 'missing'; reward: null }
  | { state: 'invalid'; reward: null }
  | { state: 'present'; reward: 0 | 1 }

function resolveReward(result: Record<string, unknown>): RewardResolution {
  const verifier = result['verifier_result']
  if (verifier === undefined || verifier === null) return { state: 'missing', reward: null }
  if (!isRecord(verifier)) return { state: 'invalid', reward: null }
  const rewards = verifier['rewards']
  if (rewards === undefined || rewards === null) return { state: 'missing', reward: null }
  if (!isRecord(rewards)) return { state: 'invalid', reward: null }
  if (!Object.hasOwn(rewards, 'reward')) return { state: 'missing', reward: null }
  const reward = rewards['reward']
  if (reward !== 0 && reward !== 1) return { state: 'invalid', reward: null }
  return { state: 'present', reward }
}

interface AttributionResolution {
  validShape: boolean
  candidateId: string | null
  taskId: string | null
  attemptIndex: number | null
}

function resolveAttribution(value: unknown): AttributionResolution {
  if (!isRecord(value)) {
    return { validShape: false, candidateId: null, taskId: null, attemptIndex: null }
  }
  if (
    Object.keys(value).some(
      (key) => key !== 'candidate_id' && key !== 'task_id' && key !== 'attempt_index',
    )
  ) {
    return { validShape: false, candidateId: null, taskId: null, attemptIndex: null }
  }
  const candidateId = typeof value['candidate_id'] === 'string' ? value['candidate_id'] : null
  const taskId = typeof value['task_id'] === 'string' ? value['task_id'] : null
  const attemptIndex = typeof value['attempt_index'] === 'number' ? value['attempt_index'] : null
  return {
    validShape:
      candidateId !== null &&
      candidateId.length > 0 &&
      candidateId.trim() === candidateId &&
      taskId !== null &&
      taskId.length > 0 &&
      taskId.trim() === taskId &&
      attemptIndex !== null &&
      Number.isSafeInteger(attemptIndex) &&
      attemptIndex >= 0,
    candidateId,
    taskId,
    attemptIndex,
  }
}

/**
 * Normalize one trial. The denominator (planned inventory) is fixed by the
 * caller; this function never drops a trial — a missing artifact yields an
 * explicit invalid/fail record that remains in the count.
 *
 * Reads Harbor's actual trial result.json structure:
 *   verifier_result.rewards.reward  — the numeric reward (0.0 / 1.0 for TB)
 *   exception_info                  — Harbor's exception classification
 * plus a controller-written sidecar `attribution.json` carrying the candidate,
 * task, and attempt identity (Harbor itself is candidate-agnostic; attribution is the
 * TCB's job). A trajectory is any `trajectory.json` or `acp-events.jsonl` the
 * adapter records alongside the trial.
 */
export async function normalizeTrial(raw: RawTrialArtifacts): Promise<NormalizedTrial> {
  if (
    raw.expectedCandidateId.length === 0 ||
    raw.expectedCandidateId.trim() !== raw.expectedCandidateId ||
    raw.taskId.length === 0 ||
    raw.taskId.trim() !== raw.taskId ||
    !Number.isSafeInteger(raw.expectedAttemptIndex) ||
    raw.expectedAttemptIndex < 0
  ) {
    throw new Error('normalizer: planned candidate/task/attempt identity is invalid')
  }
  const trialDirectoryBefore = await inspectDirectory(raw.trialDir, 'trial directory')
  if (trialDirectoryBefore.state !== 'present') {
    throw new Error(`normalizer: trial directory missing or not a directory: ${raw.trialDir}`)
  }

  const agentDir = join(raw.trialDir, 'agent')
  const agentDirectoryBefore = await inspectDirectory(agentDir, 'agent evidence directory')
  const agentPaths = agentDirectoryBefore.state === 'present'
  const [resultArtifact, attributionArtifact, trajectoryArtifact, eventsArtifact, summaryArtifact] =
    await Promise.all([
      readStableArtifact(join(raw.trialDir, 'result.json'), 'result.json'),
      readStableArtifact(join(raw.trialDir, 'attribution.json'), 'attribution.json'),
      resolveSingleArtifact('trajectory', [
        ...(agentPaths ? [join(agentDir, 'trajectory.json')] : []),
        join(raw.trialDir, 'trajectory.json'),
      ]),
      resolveSingleArtifact('ACP events', [
        ...(agentPaths ? [join(agentDir, 'acp-events.jsonl')] : []),
        join(raw.trialDir, 'acp-events.jsonl'),
      ]),
      resolveSingleArtifact('ACP summary', [
        ...(agentPaths ? [join(agentDir, 'acp-summary.json')] : []),
        join(raw.trialDir, 'acp-summary.json'),
      ]),
    ])
  const [trialDirectoryAfter, agentDirectoryAfter] = await Promise.all([
    inspectDirectory(raw.trialDir, 'trial directory'),
    inspectDirectory(agentDir, 'agent evidence directory'),
  ])
  const collectionIntegrityReason =
    directoryIntegrityReason(trialDirectoryBefore, trialDirectoryAfter, 'trial directory') ??
    directoryIntegrityReason(agentDirectoryBefore, agentDirectoryAfter, 'agent evidence directory')

  const parsedResult = parseJsonArtifact(resultArtifact)
  const resultJson = isRecord(parsedResult) ? parsedResult : null
  const attribution = resolveAttribution(parseJsonArtifact(attributionArtifact))
  const recordedCandidateId = attribution.candidateId
  const recordedTaskId = attribution.taskId
  const attemptIndex = attribution.attemptIndex
  const candidateMatch = recordedCandidateId === raw.expectedCandidateId
  const taskMatch = recordedTaskId === raw.taskId
  const attemptMatch = attemptIndex === raw.expectedAttemptIndex
  const rewardResolution = resultJson === null ? null : resolveReward(resultJson)
  const reward = rewardResolution?.reward ?? null
  const infrastructure = classifyInfrastructureException(resultJson?.['exception_info'])

  const trajectoryHash =
    trajectoryArtifact.state === 'present'
      ? trajectoryArtifact.hash
      : trajectoryArtifact.state === 'missing' && eventsArtifact.state === 'present'
        ? eventsArtifact.hash
        : trajectoryArtifact.hash
  const acpEventsHash = eventsArtifact.hash
  const acpSummaryHash = summaryArtifact.hash
  const evidenceIntegrityReason =
    collectionIntegrityReason ??
    [trajectoryArtifact, eventsArtifact, summaryArtifact].find(
      (artifact) => artifact.state === 'invalid',
    )?.reason ??
    (!validJsonObjectArtifact(trajectoryArtifact)
      ? 'trajectory is not a valid JSON object'
      : !validJsonLinesArtifact(eventsArtifact)
        ? 'ACP events are not valid object JSONL'
        : !validJsonObjectArtifact(summaryArtifact)
          ? 'ACP summary is not a valid JSON object'
          : null)

  let status: TrialStatus
  let reason: string

  if (resultArtifact.state === 'missing') {
    status = 'invalid'
    reason = 'result.json missing'
  } else if (resultArtifact.state === 'invalid') {
    status = 'invalid'
    reason = resultArtifact.reason
  } else if (resultJson === null) {
    status = 'invalid'
    reason = 'result.json is not a valid JSON object'
  } else if (attributionArtifact.state === 'missing') {
    status = 'invalid'
    reason = 'attribution.json missing'
  } else if (attributionArtifact.state === 'invalid') {
    status = 'invalid'
    reason = attributionArtifact.reason
  } else if (!attribution.validShape) {
    status = 'invalid'
    reason = 'attribution.json has an invalid or extended schema'
  } else if (!candidateMatch) {
    status = 'invalid'
    reason = `candidate_id mismatch: recorded ${recordedCandidateId} != planned ${raw.expectedCandidateId}`
  } else if (!taskMatch) {
    status = 'invalid'
    reason = `task_id mismatch: recorded ${recordedTaskId} != planned ${raw.taskId}`
  } else if (!attemptMatch) {
    status = 'invalid'
    reason = `attempt_index mismatch: recorded ${attemptIndex} != planned ${raw.expectedAttemptIndex}`
  } else if (infrastructure.integrityReason !== null) {
    status = 'invalid'
    reason = infrastructure.integrityReason
  } else if (rewardResolution?.state === 'invalid') {
    status = 'invalid'
    reason = 'reward is malformed (expected exactly 0 or 1)'
  } else if (evidenceIntegrityReason !== null) {
    status = 'invalid'
    reason = evidenceIntegrityReason
  } else if (rewardResolution?.state !== 'present') {
    status = 'invalid'
    reason = 'reward missing (verifier_result.rewards.reward)'
  } else if (trajectoryHash === null) {
    status = 'invalid'
    reason = 'trajectory missing (no trajectory.json or acp-events.jsonl)'
  } else if (raw.requireAcpEvidence === true && acpEventsHash === null) {
    status = 'invalid'
    reason = 'ACP events missing (no agent/acp-events.jsonl)'
  } else if (raw.requireAcpEvidence === true && acpSummaryHash === null) {
    status = 'invalid'
    reason = 'ACP summary missing (no agent/acp-summary.json)'
  } else {
    status = reward === 1 ? 'pass' : 'fail'
    reason = reward === 1 ? 'reward exactly 1.0' : `reward ${reward} < 1.0`
  }

  const retryEligible =
    status === 'invalid' &&
    infrastructure.detected !== null &&
    infrastructure.integrityReason === null &&
    resultJson !== null &&
    attribution.validShape &&
    candidateMatch &&
    taskMatch &&
    attemptMatch &&
    rewardResolution?.state === 'missing' &&
    evidenceIntegrityReason === null &&
    (infrastructure.detected === 'oom-crash' ||
      (trajectoryArtifact.state === 'missing' &&
        eventsArtifact.state === 'missing' &&
        summaryArtifact.state === 'missing'))
  const infraClass: InfraClass = retryEligible ? infrastructure.detected : null

  const key = `${raw.expectedCandidateId}/${raw.taskId}/${raw.expectedAttemptIndex}`
  const recordBody = JSON.stringify({
    key,
    taskId: raw.taskId,
    candidateId: recordedCandidateId,
    attemptIndex,
    status,
    reward,
    trajectoryHash,
    acpEventsHash,
    acpSummaryHash,
    retryEligible,
    infraClass,
    reason,
  })
  const recordHash = createHash('sha256').update(recordBody).digest('hex')

  return {
    key,
    taskId: raw.taskId,
    candidateId: recordedCandidateId,
    attemptIndex,
    status,
    reward,
    trajectoryHash,
    acpEventsHash,
    acpSummaryHash,
    recordHash,
    retryEligible,
    infraClass,
    reason,
  }
}

/**
 * Verify a trial directory exists and is non-empty (structural guard before
 * normalization, so a missing trial dir is caught explicitly rather than
 * producing a spurious "missing result.json").
 */
export async function assertTrialDirExists(trialDir: string): Promise<void> {
  const directory = await inspectDirectory(trialDir, 'trial directory')
  if (directory.state !== 'present') {
    throw new Error(`normalizer: trial directory missing or not a directory: ${trialDir}`)
  }
}
