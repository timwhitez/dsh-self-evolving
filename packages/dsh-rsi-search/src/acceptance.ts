/** Fail-closed Gate 5 evidence verifier. */
export interface Gate5TrialEvidence {
  candidateId: string
  taskId: string
  attemptIndex: number
  stratum: string
  capabilityMode: 'real' | 'stub' | 'nop' | 'oracle'
  normalizedRecordHash: string | null
  costUsd: number | null
  priced: boolean
  wallSec: number
}

export interface Gate5AcceptanceInput {
  baselineCandidateId: string
  developmentTaskIds: string[]
  requiredAttempts: number
  requiredStrata: string[]
  baselineTrials: Gate5TrialEvidence[]
  calibrationTrials: Gate5TrialEvidence[]
  requiredCalibrationCandidates: number
  splitAssignmentExposedToController: boolean
  sealedAccessCount: number
  budgetModel: {
    feasible: boolean
    reserveFraction: number
    predictedP90CostUsd: number
    predictedP90WallSec: number
  } | null
}

export interface Gate5AcceptanceVerdict {
  accepted: boolean
  reasons: string[]
  expectedBaselineTrials: number
  observedBaselineTrials: number
}

function validTrial(trial: Gate5TrialEvidence): boolean {
  return (
    trial.capabilityMode === 'real' &&
    typeof trial.normalizedRecordHash === 'string' &&
    /^sha256:[0-9a-f]{64}$/.test(trial.normalizedRecordHash) &&
    trial.priced &&
    typeof trial.costUsd === 'number' &&
    Number.isFinite(trial.costUsd) &&
    trial.costUsd >= 0 &&
    Number.isFinite(trial.wallSec) &&
    trial.wallSec > 0
  )
}

export function verifyGate5Acceptance(input: Gate5AcceptanceInput): Gate5AcceptanceVerdict {
  const reasons: string[] = []
  if (!input.baselineCandidateId) reasons.push('baseline candidate identity missing')
  const uniqueTasks = new Set(input.developmentTaskIds)
  if (uniqueTasks.size !== 60 || uniqueTasks.size !== input.developmentTaskIds.length) {
    reasons.push(
      `development inventory must contain exactly 60 unique tasks; got ${uniqueTasks.size}`,
    )
  }
  if (!Number.isSafeInteger(input.requiredAttempts) || input.requiredAttempts < 2) {
    reasons.push('baseline requiredAttempts must be at least 2')
  }
  const expectedBaselineTrials = uniqueTasks.size * input.requiredAttempts
  const baselineKeys = new Set<string>()
  for (const trial of input.baselineTrials) {
    const key = `${trial.taskId}/${trial.attemptIndex}`
    if (baselineKeys.has(key)) reasons.push(`duplicate baseline trial ${key}`)
    baselineKeys.add(key)
    if (trial.candidateId !== input.baselineCandidateId) {
      reasons.push(`baseline attribution mismatch for ${key}`)
    }
    if (!uniqueTasks.has(trial.taskId))
      reasons.push(`baseline task outside inventory: ${trial.taskId}`)
    if (trial.attemptIndex < 0 || trial.attemptIndex >= input.requiredAttempts) {
      reasons.push(`baseline attempt outside preregistered range: ${key}`)
    }
    if (!validTrial(trial))
      reasons.push(`baseline trial lacks real/priced/normalized evidence: ${key}`)
  }
  if (baselineKeys.size !== expectedBaselineTrials) {
    reasons.push(`baseline trial matrix incomplete: ${baselineKeys.size}/${expectedBaselineTrials}`)
  }

  const calibrationCandidates = new Set(input.calibrationTrials.map((trial) => trial.candidateId))
  const requiredStrata = new Set(input.requiredStrata)
  if (requiredStrata.size < 3 || requiredStrata.size !== input.requiredStrata.length) {
    reasons.push('calibration requires at least 3 unique declared strata')
  }
  if (
    !Number.isSafeInteger(input.requiredCalibrationCandidates) ||
    input.requiredCalibrationCandidates < 3
  ) {
    reasons.push('calibration requires at least 3 candidates')
  }
  if (calibrationCandidates.size < input.requiredCalibrationCandidates) {
    reasons.push(
      `calibration candidate count ${calibrationCandidates.size} < ${input.requiredCalibrationCandidates}`,
    )
  }
  const covered = new Set<string>()
  for (const trial of input.calibrationTrials) {
    if (!validTrial(trial)) {
      reasons.push(
        `calibration trial lacks real/priced/normalized evidence: ${trial.candidateId}/${trial.taskId}/${trial.attemptIndex}`,
      )
    }
    covered.add(`${trial.candidateId}/${trial.stratum}`)
  }
  for (const candidateId of calibrationCandidates) {
    for (const stratum of requiredStrata) {
      if (!covered.has(`${candidateId}/${stratum}`)) {
        reasons.push(`calibration stratum missing: ${candidateId}/${stratum}`)
      }
    }
  }
  if (input.splitAssignmentExposedToController) {
    reasons.push('split assignment/seed was exposed outside the sealed service')
  }
  if (input.sealedAccessCount !== 0) reasons.push('sealed store was accessed before candidate lock')
  if (input.budgetModel === null) reasons.push('budget model missing')
  else {
    if (input.budgetModel.reserveFraction < 0.2) reasons.push('budget reserve is below 20%')
    if (!input.budgetModel.feasible) reasons.push('budget model is infeasible')
    if (
      !Number.isFinite(input.budgetModel.predictedP90CostUsd) ||
      input.budgetModel.predictedP90CostUsd < 0 ||
      input.budgetModel.predictedP90CostUsd > 500
    )
      reasons.push('predicted p90 cost is invalid or exceeds $500')
    if (
      !Number.isFinite(input.budgetModel.predictedP90WallSec) ||
      input.budgetModel.predictedP90WallSec <= 0 ||
      input.budgetModel.predictedP90WallSec > 16 * 3600
    ) {
      reasons.push('predicted p90 wall time is invalid or exceeds 16 hours')
    }
  }
  return {
    accepted: reasons.length === 0,
    reasons: [...new Set(reasons)].sort(),
    expectedBaselineTrials,
    observedBaselineTrials: baselineKeys.size,
  }
}
