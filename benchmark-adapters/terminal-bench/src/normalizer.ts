/**
 * Harbor trial result normalizer (spec 04 §4; spec 06 §9).
 *
 * Reads a Harbor trial directory (result.json, reward.txt, agent/trajectory.json,
 * verifier/...), validates required artifacts and task/candidate attribution,
 * and emits one deterministic NormalizedTrialRecord. Infrastructure failures are
 * NEVER scored as reward=0; they are status=invalid and excluded from Bernoulli
 * statistics. Only pass/fail with reward in {0,1} enter search stats.
 */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

export type TrialStatus = 'pass' | 'fail' | 'invalid'
export type InfraFailureReason =
  | 'timeout'
  | 'oom'
  | 'image-build-failure'
  | 'network-outage'
  | 'artifact-corruption'
  | 'provider-failure'
  | 'verifier-error'
  | 'unknown'

export interface ArtifactRef {
  algorithm: 'sha256'
  digest: string
  size: number
  mediaType: string
}

export interface NormalizedTrialRecord {
  schemaVersion: 1
  trialKey: string
  taskId: string
  candidateId: string | null
  attemptIndex: number | null
  status: TrialStatus
  reward: 0 | 1 | null
  infraFailureReason: InfraFailureReason | null
  invalidReason: string | null
  startedAt: string | null
  finishedAt: string | null
  wallSec: number | null
  artifacts: {
    result: ArtifactRef | null
    reward: ArtifactRef | null
    trajectory: ArtifactRef | null
    verifier: ArtifactRef[]
  }
  sourceDir: string
}

export interface NormalizeInput {
  trialDir: string
  expectedCandidateId: string
  expectedTaskId: string
  attemptIndex: number
  /** Optional candidate artifact dir containing candidate-attribution.json. */
  candidateArtifactDir?: string
}

interface HarborResult {
  task_id?: string
  started_at?: string
  finished_at?: string
  agent_execution?: { started_at?: string; finished_at?: string; exception_info?: unknown }
  verifier_execution?: { started_at?: string; finished_at?: string; exception_info?: unknown }
  reward?: number | null
}

async function fileRef(path: string, mediaType: string): Promise<ArtifactRef | null> {
  try {
    const content = await readFile(path)
    const s = await stat(path)
    return {
      algorithm: 'sha256',
      digest: createHash('sha256').update(content).digest('hex'),
      size: s.size,
      mediaType,
    }
  } catch {
    return null
  }
}

function parseReward(text: string): number | null {
  const n = Number(text.trim())
  return Number.isFinite(n) ? n : null
}

function classifyInfra(result: HarborResult | null, resultText: string | null): InfraFailureReason {
  const haystack = `${resultText ?? ''} ${JSON.stringify(result ?? {})}`.toLowerCase()
  if (haystack.includes('timeout') || haystack.includes('timed out')) return 'timeout'
  if (haystack.includes('oom') || haystack.includes('out of memory')) return 'oom'
  if (haystack.includes('image') && haystack.includes('build')) return 'image-build-failure'
  if (haystack.includes('network') || haystack.includes('connection')) return 'network-outage'
  if (haystack.includes('checksum') || haystack.includes('corrupt')) return 'artifact-corruption'
  if (haystack.includes('provider') || haystack.includes('rate limit')) return 'provider-failure'
  if (haystack.includes('verifier')) return 'verifier-error'
  return 'unknown'
}

/**
 * Normalize one Harbor trial directory. Fail-closed: missing required artifacts,
 * attribution mismatch, or non-binary reward => invalid (never fail/reward=0).
 */
export async function normalizeTrial(input: NormalizeInput): Promise<NormalizedTrialRecord> {
  const resultPath = join(input.trialDir, 'result.json')
  const rewardPath = join(input.trialDir, 'reward.txt')
  const trajectoryPath = join(input.trialDir, 'agent', 'trajectory.json')

  const [resultRef, rewardRef, trajectoryRef] = await Promise.all([
    fileRef(resultPath, 'application/json'),
    fileRef(rewardPath, 'text/plain'),
    fileRef(trajectoryPath, 'application/json'),
  ])

  let result: HarborResult | null = null
  let resultText: string | null = null
  try {
    resultText = await readFile(resultPath, 'utf8')
    result = JSON.parse(resultText) as HarborResult
  } catch {
    // handled below as invalid
  }

  let rewardValue: number | null = null
  try {
    rewardValue = parseReward(await readFile(rewardPath, 'utf8'))
  } catch {
    // handled below
  }

  // Candidate attribution: the candidate capsule writes this file; the adapter
  // verifies it matches the action's expected candidate + attempt.
  let attribution: { candidate_id?: unknown; task_id?: unknown; attempt_index?: unknown } | null =
    null
  if (input.candidateArtifactDir) {
    try {
      attribution = JSON.parse(
        await readFile(join(input.candidateArtifactDir, 'candidate-attribution.json'), 'utf8'),
      ) as typeof attribution
    } catch {
      // missing attribution => invalid
    }
  }

  const candidateId =
    typeof attribution?.candidate_id === 'string' ? attribution.candidate_id : null
  const attributedTaskId =
    typeof attribution?.task_id === 'string' ? attribution.task_id : result?.task_id
  const rawAttemptIndex = attribution?.attempt_index
  const attemptIndex =
    typeof rawAttemptIndex === 'number' &&
    Number.isSafeInteger(rawAttemptIndex) &&
    rawAttemptIndex >= 0
      ? rawAttemptIndex
      : null

  // Collect verifier artifacts (best-effort list of known paths).
  const verifierRefs: ArtifactRef[] = []
  for (const [rel, media] of [
    ['verifier/reward.json', 'application/json'],
    ['verifier/ctrf.txt', 'text/plain'],
    ['verifier/stdout.txt', 'text/plain'],
    ['verifier/stderr.txt', 'text/plain'],
  ] as const) {
    const ref = await fileRef(join(input.trialDir, rel), media)
    if (ref) verifierRefs.push(ref)
  }

  let status: TrialStatus = 'invalid'
  let reward: 0 | 1 | null = null
  let invalidReason: string | null = null
  let infraFailureReason: InfraFailureReason | null = null

  if (!resultRef) invalidReason = 'missing or unreadable result.json'
  else if (!rewardRef || rewardValue === null) invalidReason = 'missing or invalid reward.txt'
  else if (!trajectoryRef) invalidReason = 'missing agent trajectory'
  else if (result?.task_id !== input.expectedTaskId || attributedTaskId !== input.expectedTaskId) {
    invalidReason = `task attribution mismatch: expected ${input.expectedTaskId}`
  } else if (candidateId !== input.expectedCandidateId) {
    invalidReason = `candidate attribution mismatch: expected ${input.expectedCandidateId}`
  } else if (attemptIndex === null) {
    invalidReason = 'attempt attribution missing or invalid'
  } else if (attemptIndex !== input.attemptIndex) {
    invalidReason = `attempt attribution mismatch: expected ${input.attemptIndex}`
  } else if (rewardValue !== 0 && rewardValue !== 1) {
    invalidReason = `reward outside {0,1}: ${rewardValue}`
  } else if (result?.agent_execution?.exception_info || result?.verifier_execution?.exception_info) {
    invalidReason = 'infrastructure execution exception'
  } else {
    reward = rewardValue as 0 | 1
    status = reward === 1 ? 'pass' : 'fail'
  }

  if (status === 'invalid') {
    infraFailureReason = classifyInfra(result, resultText)
  }

  const startedAt = result?.started_at ?? result?.agent_execution?.started_at ?? null
  const finishedAt = result?.finished_at ?? result?.verifier_execution?.finished_at ?? null
  const wallSec =
    startedAt && finishedAt
      ? Math.max(0, (new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000)
      : null

  const keyMaterial = `${input.expectedCandidateId}\0${input.expectedTaskId}\0${String(attemptIndex)}`
  return {
    schemaVersion: 1,
    trialKey: 'sha256:' + createHash('sha256').update(keyMaterial).digest('hex'),
    taskId: input.expectedTaskId,
    candidateId,
    attemptIndex,
    status,
    reward,
    infraFailureReason,
    invalidReason,
    startedAt,
    finishedAt,
    wallSec,
    artifacts: {
      result: resultRef,
      reward: rewardRef,
      trajectory: trajectoryRef,
      verifier: verifierRefs,
    },
    sourceDir: input.trialDir,
  }
}

/**
 * Validate a normalized record for search statistics. Returns true only for
 * Bernoulli-valid trials; invalid rows are never coerced to 0.
 */
export function isBernoulliValid(record: NormalizedTrialRecord): boolean {
  return (
    (record.status === 'pass' || record.status === 'fail') &&
    (record.reward === 0 || record.reward === 1) &&
    record.candidateId !== null &&
    record.attemptIndex !== null
  )
}
