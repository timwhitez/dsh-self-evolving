import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { link, lstat, mkdir, open, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { assertV011, canonicalV011, digestV011 } from '@dsh-self-evolving/candidate-sdk'

export type MechanismOutcomeStatus =
  | 'TARGET_IMPROVED'
  | 'TARGET_UNCHANGED'
  | 'TARGET_NOT_MEASURED'
  | 'PRESERVATION_REGRESSED'
  | 'INVALID_TRIALS'

export interface OutcomeTrial {
  ref: `sha256:${string}`
  role: 'target-baseline' | 'target-child' | 'preservation-baseline' | 'preservation-child'
  status: 'pass' | 'fail' | 'invalid'
  reward: 0 | 1 | null
  /** Opaque task identity shared by the baseline and child arms. */
  taskId: string
  /** Frozen attempt identity shared by the baseline and child arms. */
  attemptIndex: number
}

export interface MechanismOutcomeRecord {
  schemaVersion: 1
  idempotencyKey: `sha256:${string}`
  proposalDigest: `sha256:${string}`
  hypothesisDigest: `sha256:${string}`
  candidateDigest: `sha256:${string}`
  targetClusterSlug: string
  targetTaskHandle: string
  trialRefs: `sha256:${string}`[]
  targetTrials: number
  preservationTrials: number
  status: MechanismOutcomeStatus
  singleTrialObservable: boolean
  label: 'DEV_OBSERVED'
}

type TrialDomain = 'target' | 'preservation'
type BaselineRole = 'target-baseline' | 'preservation-baseline'
type ChildRole = 'target-child' | 'preservation-child'

interface TrialPair {
  taskId: string
  attemptIndex: number
  baseline: OutcomeTrial
  child: OutcomeTrial
}

interface PairingResult {
  pairs: TrialPair[]
  valid: boolean
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function validTaskId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !value.includes('\0')
  )
}

function trialShapeIsValid(trial: OutcomeTrial): boolean {
  if (!/^sha256:[0-9a-f]{64}$/.test(trial.ref)) return false
  if (!validTaskId(trial.taskId)) return false
  if (!Number.isSafeInteger(trial.attemptIndex) || trial.attemptIndex < 0) return false
  if (
    trial.role !== 'target-baseline' &&
    trial.role !== 'target-child' &&
    trial.role !== 'preservation-baseline' &&
    trial.role !== 'preservation-child'
  ) {
    return false
  }
  if (trial.status === 'pass') return trial.reward === 1
  if (trial.status === 'fail') return trial.reward === 0
  if (trial.status === 'invalid') return trial.reward === null
  return false
}

function pairDomain(trials: OutcomeTrial[], domain: TrialDomain): PairingResult {
  if (trials.length === 0) return { pairs: [], valid: true }
  const baselineRole: BaselineRole =
    domain === 'target' ? 'target-baseline' : 'preservation-baseline'
  const childRole: ChildRole = domain === 'target' ? 'target-child' : 'preservation-child'
  if (
    trials.some((trial) => !validTaskId(trial.taskId) || !Number.isSafeInteger(trial.attemptIndex))
  ) {
    return { pairs: [], valid: false }
  }
  const grouped = new Map<string, { baseline?: OutcomeTrial; child?: OutcomeTrial }>()
  for (const trial of trials) {
    const key = canonicalV011({ attemptIndex: trial.attemptIndex, taskId: trial.taskId })
    const pair = grouped.get(key) ?? {}
    if (trial.role === baselineRole) {
      if (pair.baseline !== undefined) return { pairs: [], valid: false }
      pair.baseline = trial
    } else if (trial.role === childRole) {
      if (pair.child !== undefined) return { pairs: [], valid: false }
      pair.child = trial
    } else {
      return { pairs: [], valid: false }
    }
    grouped.set(key, pair)
  }
  const pairs: TrialPair[] = []
  for (const pair of grouped.values()) {
    if (pair.baseline === undefined || pair.child === undefined) {
      return { pairs: [], valid: false }
    }
    pairs.push({
      taskId: pair.baseline.taskId,
      attemptIndex: pair.baseline.attemptIndex,
      baseline: pair.baseline,
      child: pair.child,
    })
  }
  pairs.sort(
    (left, right) =>
      compareText(left.taskId, right.taskId) || left.attemptIndex - right.attemptIndex,
  )
  return { pairs, valid: true }
}

async function readRegularTextFile(path: string): Promise<string | null> {
  const file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    },
  )
  if (file === null) return null
  try {
    const [held, canonical] = await Promise.all([file.stat(), lstat(path)])
    if (
      !held.isFile() ||
      !canonical.isFile() ||
      held.dev !== canonical.dev ||
      held.ino !== canonical.ino
    ) {
      throw new Error('v0.1.1 outcome: artifact path is not one stable regular file')
    }
    return await file.readFile('utf8')
  } finally {
    await file.close()
  }
}

export async function deriveMechanismOutcome(input: {
  proposalDigest: `sha256:${string}`
  hypothesis: string
  candidateDigest: `sha256:${string}`
  targetClusterSlug: string
  targetTaskHandle: string
  trials: OutcomeTrial[]
}): Promise<MechanismOutcomeRecord> {
  const target = input.trials.filter((trial) => trial.role.startsWith('target-'))
  const preservation = input.trials.filter((trial) => trial.role.startsWith('preservation-'))
  const targetPairing = pairDomain(target, 'target')
  const preservationPairing = pairDomain(preservation, 'preservation')
  const uniqueRefs = new Set(input.trials.map((trial) => trial.ref))
  const invalid =
    input.trials.some((trial) => !trialShapeIsValid(trial)) ||
    input.trials.some((trial) => trial.status === 'invalid') ||
    uniqueRefs.size !== input.trials.length ||
    !targetPairing.valid ||
    !preservationPairing.valid ||
    target.some((trial) => trial.taskId !== input.targetTaskHandle)

  const preservationRegressed = preservationPairing.pairs.some(
    (pair) => pair.baseline.status === 'pass' && pair.child.status !== 'pass',
  )
  const targetImproved =
    targetPairing.pairs.length > 0 &&
    targetPairing.pairs.every(
      (pair) => pair.baseline.status === 'fail' && pair.child.status === 'pass',
    )

  let status: MechanismOutcomeStatus
  if (invalid) status = 'INVALID_TRIALS'
  else if (preservationRegressed) status = 'PRESERVATION_REGRESSED'
  else if (targetPairing.pairs.length === 0) status = 'TARGET_NOT_MEASURED'
  else if (targetImproved) status = 'TARGET_IMPROVED'
  else status = 'TARGET_UNCHANGED'

  const trialCommitment = input.trials
    .map((trial) => ({
      attemptIndex: Number.isSafeInteger(trial.attemptIndex) ? trial.attemptIndex : null,
      ref: trial.ref,
      reward: trial.reward,
      role: trial.role,
      status: trial.status,
      taskId: typeof trial.taskId === 'string' ? trial.taskId : null,
    }))
    .sort((left, right) => compareText(canonicalV011(left), canonicalV011(right)))
  const trialRefs = [...uniqueRefs].sort(compareText)
  const hypothesisDigest = digestV011(input.hypothesis)
  const record: MechanismOutcomeRecord = {
    schemaVersion: 1,
    idempotencyKey: digestV011({
      candidateDigest: input.candidateDigest,
      hypothesisDigest,
      proposalDigest: input.proposalDigest,
      targetClusterSlug: input.targetClusterSlug,
      targetTaskHandle: input.targetTaskHandle,
      trialCommitment,
    }),
    proposalDigest: input.proposalDigest,
    hypothesisDigest,
    candidateDigest: input.candidateDigest,
    targetClusterSlug: input.targetClusterSlug,
    targetTaskHandle: input.targetTaskHandle,
    trialRefs,
    targetTrials: target.length,
    preservationTrials: preservation.length,
    status,
    singleTrialObservable: !invalid && targetPairing.pairs.length === 1,
    label: 'DEV_OBSERVED',
  }
  await assertV011('mechanism-outcome', record)
  return record
}

export async function publishMechanismOutcomeOnce(
  path: string,
  record: MechanismOutcomeRecord,
): Promise<'CREATED' | 'REUSED'> {
  const parent = dirname(path)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const bytes = canonicalV011(record) + '\n'
  const stagingPath = `${path}.staging-${process.pid}-${randomUUID()}`
  const file = await open(stagingPath, 'wx', 0o600)
  try {
    await file.writeFile(bytes)
    await file.sync()
  } finally {
    await file.close()
  }
  let status: 'CREATED' | 'REUSED' = 'CREATED'
  try {
    try {
      await link(stagingPath, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = await readRegularTextFile(path)
      if (existing === null) {
        throw new Error('v0.1.1 outcome: published artifact disappeared', { cause: error })
      }
      if (existing !== bytes) {
        throw new Error('v0.1.1 outcome: conflicting exactly-once derivation', { cause: error })
      }
      status = 'REUSED'
    }
    const directory = await open(parent, 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
    return status
  } finally {
    await rm(stagingPath, { force: true })
  }
}
