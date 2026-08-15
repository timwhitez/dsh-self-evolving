/** Fail-closed Gate 6 real-pilot evidence verifier. */
export interface Gate6CandidateEvidence {
  candidateId: string
  sourceDigest: string
  capsuleDigest: string
  buildManifestDigest: string
}

export interface Gate6ObservationEvidence {
  candidateId: string
  taskId: string
  attemptIndex: number
  normalizedRecordHash: string
  rawEvidenceDigests: string[]
  costUsd: number
}

export interface Gate6AcceptanceInput {
  runId: string
  targetK: number
  capabilityMode: 'real' | 'stub'
  candidates: Gate6CandidateEvidence[]
  observations: Gate6ObservationEvidence[]
  allActionsTerminalAndReconciled: boolean
  journalReplayMatches: boolean
  realCrashResumeReceipt: boolean
  fixtures: {
    buildReject: boolean
    runtimeFail: boolean
    infraRetry: boolean
    duplicateChild: boolean
  }
  proposerRawEvidenceReferences: number
  auditCriticalFindings: number
  costPredictionErrorFraction: number | null
  sealedAccessCount: number
}

export interface Gate6AcceptanceVerdict {
  accepted: boolean
  reasons: string[]
}

const digest = /^sha256:[0-9a-f]{64}$/

export function verifyGate6Acceptance(input: Gate6AcceptanceInput): Gate6AcceptanceVerdict {
  const reasons: string[] = []
  if (!input.runId || input.runId === 'pilot-001')
    reasons.push('fresh successor pilot run id missing')
  if (input.targetK !== 10) reasons.push(`pilot target K must equal 10; got ${input.targetK}`)
  if (input.capabilityMode !== 'real') reasons.push('pilot capabilities are not real')
  const ids = new Set(input.candidates.map((candidate) => candidate.candidateId))
  if (ids.size !== input.targetK || ids.size !== input.candidates.length) {
    reasons.push(`unique admitted candidate matrix incomplete: ${ids.size}/${input.targetK}`)
  }
  const sourceDigests = new Set<string>()
  for (const candidate of input.candidates) {
    if (
      !digest.test(candidate.candidateId) ||
      !digest.test(candidate.sourceDigest) ||
      !digest.test(candidate.capsuleDigest) ||
      !digest.test(candidate.buildManifestDigest)
    ) {
      reasons.push(`candidate lacks full immutable identity: ${candidate.candidateId}`)
    }
    sourceDigests.add(candidate.sourceDigest)
  }
  if (sourceDigests.size !== input.candidates.length) {
    reasons.push('admitted candidates do not have unique source digests')
  }
  const observationKeys = new Set<string>()
  const observedCandidates = new Set<string>()
  for (const observation of input.observations) {
    const key = `${observation.candidateId}/${observation.taskId}/${observation.attemptIndex}`
    if (observationKeys.has(key)) reasons.push(`duplicate observation: ${key}`)
    observationKeys.add(key)
    observedCandidates.add(observation.candidateId)
    if (!ids.has(observation.candidateId)) {
      reasons.push(`observation references unknown candidate: ${observation.candidateId}`)
    }
    if (!digest.test(observation.normalizedRecordHash)) {
      reasons.push(
        `observation lacks normalized record: ${observation.candidateId}/${observation.taskId}`,
      )
    }
    if (
      !Number.isFinite(observation.costUsd) ||
      observation.costUsd < 0 ||
      observation.rawEvidenceDigests.length === 0 ||
      observation.rawEvidenceDigests.some((value) => !digest.test(value))
    ) {
      reasons.push(
        `observation cost/raw evidence invalid: ${observation.candidateId}/${observation.taskId}`,
      )
    }
  }
  for (const candidateId of ids) {
    if (!observedCandidates.has(candidateId)) {
      reasons.push(`candidate has no attributable observation: ${candidateId}`)
    }
  }
  if (!input.allActionsTerminalAndReconciled) reasons.push('actions are not terminal/reconciled')
  if (!input.journalReplayMatches) reasons.push('independent journal replay does not match')
  if (!input.realCrashResumeReceipt) reasons.push('real process crash/resume receipt missing')
  for (const [fixture, covered] of Object.entries(input.fixtures)) {
    if (!covered) reasons.push(`required failure fixture not covered: ${fixture}`)
  }
  if (input.proposerRawEvidenceReferences <= 0) {
    reasons.push('proposer did not cite historical raw evidence')
  }
  if (input.auditCriticalFindings !== 0) reasons.push('audit contains critical findings')
  if (
    input.costPredictionErrorFraction === null ||
    !Number.isFinite(input.costPredictionErrorFraction) ||
    Math.abs(input.costPredictionErrorFraction) > 0.2
  ) {
    reasons.push('cost prediction error is missing or exceeds 20%')
  }
  if (input.sealedAccessCount !== 0) reasons.push('pilot accessed sealed state')
  return { accepted: reasons.length === 0, reasons: [...new Set(reasons)].sort() }
}
