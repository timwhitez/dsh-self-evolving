import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { assertV011, canonicalV011, digestV011 } from '@dsh-rsi/candidate-sdk'

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
  const invalid = input.trials.some((trial) => trial.status === 'invalid' || trial.reward === null)
  const preservationRegressed = preservation.some(
    (baseline) =>
      baseline.role === 'preservation-baseline' &&
      baseline.status === 'pass' &&
      preservation.some((child) => child.role === 'preservation-child' && child.status !== 'pass'),
  )
  const baseline = target.find((trial) => trial.role === 'target-baseline')
  const child = target.find((trial) => trial.role === 'target-child')
  let status: MechanismOutcomeStatus
  if (invalid) status = 'INVALID_TRIALS'
  else if (preservationRegressed) status = 'PRESERVATION_REGRESSED'
  else if (baseline === undefined || child === undefined) status = 'TARGET_NOT_MEASURED'
  else if (baseline.status !== 'pass' && child.status === 'pass') status = 'TARGET_IMPROVED'
  else status = 'TARGET_UNCHANGED'
  const trialRefs = input.trials.map((trial) => trial.ref).sort()
  const record: MechanismOutcomeRecord = {
    schemaVersion: 1,
    idempotencyKey: digestV011({
      proposalDigest: input.proposalDigest,
      candidateDigest: input.candidateDigest,
      targetTaskHandle: input.targetTaskHandle,
      trialRefs,
    }),
    proposalDigest: input.proposalDigest,
    hypothesisDigest: digestV011(input.hypothesis),
    candidateDigest: input.candidateDigest,
    targetClusterSlug: input.targetClusterSlug,
    targetTaskHandle: input.targetTaskHandle,
    trialRefs,
    targetTrials: target.length,
    preservationTrials: preservation.length,
    status,
    singleTrialObservable:
      input.trials.filter((trial) => trial.role === 'target-child').length === 1,
    label: 'DEV_OBSERVED',
  }
  await assertV011('mechanism-outcome', record)
  return record
}

export async function publishMechanismOutcomeOnce(
  path: string,
  record: MechanismOutcomeRecord,
): Promise<'CREATED' | 'REUSED'> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const bytes = canonicalV011(record) + '\n'
  const file = await open(path, 'wx', 0o600).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
    const existing = await readFile(path, 'utf8')
    if (existing !== bytes) throw new Error('v0.1.1 outcome: conflicting exactly-once derivation')
    return null
  })
  if (file === null) return 'REUSED'
  try {
    await file.writeFile(bytes)
    await file.sync()
  } finally {
    await file.close()
  }
  return 'CREATED'
}
