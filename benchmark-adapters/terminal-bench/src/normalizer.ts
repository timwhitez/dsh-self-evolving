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
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

export type TrialStatus = 'pass' | 'fail' | 'invalid'

/** The only classifications eligible for retry (spec 07 §1 rule 7). */
export type InfraClass = 'docker-build-error' | 'network-pull-error' | 'oom-crash' | null

export interface RawTrialArtifacts {
  /** Path to the Harbor job trial directory (e.g. jobs/<job>/<trial-xyz>). */
  trialDir: string
  /** The candidate identity this trial was planned for (never inferred from artifacts). */
  expectedCandidateId: string
  /** The task id this trial was planned for. */
  taskId: string
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

async function hashFile(path: string): Promise<string | null> {
  try {
    const data = await readFile(path)
    return createHash('sha256').update(data).digest('hex')
  } catch {
    return null
  }
}

async function readJsonOrNull(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function firstHash(paths: string[]): Promise<string | null> {
  for (const path of paths) {
    const hash = await hashFile(path)
    if (hash !== null) return hash
  }
  return null
}

async function firstJson(paths: string[]): Promise<unknown | null> {
  for (const path of paths) {
    const parsed = await readJsonOrNull(path)
    if (parsed !== null) return parsed
  }
  return null
}

/**
 * Normalize one trial. The denominator (planned inventory) is fixed by the
 * caller; this function never drops a trial — a missing artifact yields an
 * explicit invalid/fail record that remains in the count.
 *
 * Reads Harbor's actual trial result.json structure:
 *   verifier_result.rewards.reward  — the numeric reward (0.0 / 1.0 for TB)
 *   exception_info                  — Harbor's exception classification
 * plus a controller-written sidecar `attribution.json` carrying the candidate
 * id + attempt index (Harbor itself is candidate-agnostic; attribution is the
 * TCB's job). A trajectory is any `trajectory.json` or `acp-events.jsonl` the
 * adapter records alongside the trial.
 */
export async function normalizeTrial(raw: RawTrialArtifacts): Promise<NormalizedTrial> {
  const resultJson = (await readJsonOrNull(join(raw.trialDir, 'result.json'))) as {
    verifier_result?: { rewards?: { reward?: unknown } }
    exception_info?: { type?: string; classification?: string } | null
  } | null
  const attribution = (await readJsonOrNull(join(raw.trialDir, 'attribution.json'))) as {
    candidate_id?: string
    attempt_index?: number
  } | null
  // Harbor stores installed-agent evidence below trial/agent/. Retain the old
  // root fallback for imported fixtures, but prefer the real layout.
  const trajectoryHash = await firstHash([
    join(raw.trialDir, 'agent', 'trajectory.json'),
    join(raw.trialDir, 'trajectory.json'),
    join(raw.trialDir, 'agent', 'acp-events.jsonl'),
    join(raw.trialDir, 'acp-events.jsonl'),
  ])
  const acpEventsHash = await firstHash([
    join(raw.trialDir, 'agent', 'acp-events.jsonl'),
    join(raw.trialDir, 'acp-events.jsonl'),
  ])
  const acpSummaryHash = await firstHash([
    join(raw.trialDir, 'agent', 'acp-summary.json'),
    join(raw.trialDir, 'acp-summary.json'),
  ])
  const acpSummary = await firstJson([
    join(raw.trialDir, 'agent', 'acp-summary.json'),
    join(raw.trialDir, 'acp-summary.json'),
  ])

  // Candidate attribution: the controller-written sidecar MUST match the plan.
  const recordedCandidateId = attribution?.candidate_id ?? null
  const candidateMatch = recordedCandidateId === raw.expectedCandidateId
  const attemptIndex = attribution?.attempt_index ?? null

  const rewardRaw = resultJson?.verifier_result?.rewards?.reward
  const reward = typeof rewardRaw === 'number' ? rewardRaw : null

  let status: TrialStatus
  let reason: string
  let infraClass: InfraClass = null

  if (resultJson === null) {
    status = 'invalid'
    reason = 'result.json missing'
  } else if (!candidateMatch) {
    status = 'invalid'
    reason = `candidate_id mismatch: recorded ${recordedCandidateId} != planned ${raw.expectedCandidateId}`
  } else if (reward === null) {
    status = 'invalid'
    reason = 'reward missing or non-numeric (verifier_result.rewards.reward)'
  } else if (trajectoryHash === null) {
    status = 'invalid'
    reason = 'trajectory missing (no trajectory.json or acp-events.jsonl)'
  } else if (raw.requireAcpEvidence === true && acpEventsHash === null) {
    status = 'invalid'
    reason = 'ACP events missing (no agent/acp-events.jsonl)'
  } else if (raw.requireAcpEvidence === true && acpSummaryHash === null) {
    status = 'invalid'
    reason = 'ACP summary missing (no agent/acp-summary.json)'
  } else if (raw.requireAcpEvidence === true && acpSummary === null) {
    status = 'invalid'
    reason = 'ACP summary is not valid JSON'
  } else {
    status = reward >= 1.0 ? 'pass' : 'fail'
    reason = reward >= 1.0 ? 'reward >= 1.0' : `reward ${reward} < 1.0`
    // Infrastructure classification for retry eligibility (reward-independent).
    const exc = resultJson.exception_info
    const cls = typeof exc?.classification === 'string' ? exc.classification : ''
    const type = typeof exc?.type === 'string' ? exc.type : ''
    const hay = `${cls} ${type}`
    if (hay.includes('docker') && hay.includes('build')) infraClass = 'docker-build-error'
    else if (hay.includes('network') || hay.includes('pull')) infraClass = 'network-pull-error'
    else if (hay.includes('oom') || hay.includes('memory')) infraClass = 'oom-crash'
  }

  const retryEligible = infraClass !== null

  const key = `${raw.expectedCandidateId}/${raw.taskId}/${attemptIndex ?? '?'}`
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
  const st = await stat(trialDir).catch(() => null)
  if (!st || !st.isDirectory()) {
    throw new Error(`normalizer: trial directory missing or not a directory: ${trialDir}`)
  }
}
