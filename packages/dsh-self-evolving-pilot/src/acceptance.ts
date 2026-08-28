/** Fail-closed Gate 6 real-pilot evidence verifier. */
import { canonicalV011, digestV011, isValidCandidateId } from '@dsh-self-evolving/candidate-sdk'

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
  /**
   * The normalized trial record itself (issue #121): the verifier recomputes
   * its canonical digest and requires equality with normalizedRecordHash
   * instead of trusting any hash-shaped string.
   */
  normalizedRecord: unknown
}

export interface Gate6AcceptanceInput {
  runId: string
  targetK: number
  capabilityMode: 'real' | 'stub'
  candidates: Gate6CandidateEvidence[]
  observations: Gate6ObservationEvidence[]
  /**
   * Canonical digest over the complete evidence envelope (issue #121):
   * recorded with the verdict so post-hoc edits to any evidence field
   * (booleans included) diverge from the recorded commitment.
   */
  evidenceCommitment: `sha256:${string}`
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
  // Structural guards first: a malformed envelope must produce a fail-closed
  // verdict, never a TypeError/RangeError the caller can only crash on
  // (issue #217).
  if (input === null || typeof input !== 'object') {
    return { accepted: false, reasons: ['evidence envelope is not an object'] }
  }
  const candidatesWellFormed =
    Array.isArray(input.candidates) &&
    input.candidates.every(
      (candidate) =>
        candidate !== null &&
        typeof candidate === 'object' &&
        typeof candidate.candidateId === 'string',
    )
  const observationsWellFormed =
    Array.isArray(input.observations) &&
    input.observations.every(
      (observation) =>
        observation !== null &&
        typeof observation === 'object' &&
        typeof observation.candidateId === 'string' &&
        typeof observation.taskId === 'string' &&
        typeof observation.attemptIndex === 'number',
    )
  if (!candidatesWellFormed) reasons.push('candidate matrix is missing or malformed')
  if (!observationsWellFormed) reasons.push('observation matrix is missing or malformed')
  if (!input.runId || input.runId === 'pilot-001')
    reasons.push('fresh successor pilot run id missing')
  if (input.targetK !== 10) reasons.push(`pilot target K must equal 10; got ${input.targetK}`)
  if (input.capabilityMode !== 'real') reasons.push('pilot capabilities are not real')
  try {
    if (input.evidenceCommitment !== gate6EvidenceCommitment(input)) {
      reasons.push('evidence envelope does not match its recorded commitment')
    }
  } catch {
    // Undigestible content anywhere in the envelope (circular values, stray
    // bigint) cannot be commitment-checked: fail closed (issue #217).
    reasons.push('evidence envelope commitment cannot be computed')
  }
  const safeCandidates = candidatesWellFormed ? input.candidates : []
  const safeObservations = observationsWellFormed ? input.observations : []
  const ids = new Set(safeCandidates.map((candidate) => candidate.candidateId))
  if (ids.size !== input.targetK || ids.size !== safeCandidates.length) {
    reasons.push(`unique admitted candidate matrix incomplete: ${ids.size}/${input.targetK}`)
  }
  const sourceDigests = new Set<string>()
  for (const candidate of safeCandidates) {
    // The candidate ID is the SDK-issued canonical identity (c_<base32>),
    // distinct from every sha256 digest field (issue #77).
    if (
      !isValidCandidateId(candidate.candidateId) ||
      !digest.test(candidate.sourceDigest) ||
      !digest.test(candidate.capsuleDigest) ||
      !digest.test(candidate.buildManifestDigest)
    ) {
      reasons.push(`candidate lacks full immutable identity: ${candidate.candidateId}`)
    }
    sourceDigests.add(candidate.sourceDigest)
  }
  if (sourceDigests.size !== safeCandidates.length) {
    reasons.push('admitted candidates do not have unique source digests')
  }
  const observationKeys = new Set<string>()
  const observedCandidates = new Set<string>()
  for (const observation of safeObservations) {
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
    } else if (
      observation.normalizedRecord === undefined ||
      observation.normalizedRecord === null
    ) {
      // A claimed digest without the record content it covers is unfalsifiable
      // (issue #121); fail closed instead of trusting the claim.
      reasons.push(
        `observation normalized record missing: ${observation.candidateId}/${observation.taskId}`,
      )
    } else {
      // Recompute from the record itself: a hash-shaped string alone proves
      // nothing (issue #121). Undigestible content is a fail-closed reason,
      // never a crash (issue #217).
      let recomputed: string
      try {
        recomputed = digestV011(canonicalV011(observation.normalizedRecord))
      } catch {
        reasons.push(
          `observation normalized record digest cannot be computed: ${observation.candidateId}/${observation.taskId}`,
        )
        recomputed = ''
      }
      if (recomputed === '') {
        // Undigestible content already fails this observation closed; the
        // identity check (which re-invokes getters via Object.entries) must
        // not get a second chance to throw (issue #217).
        continue
      }
      if (recomputed !== observation.normalizedRecordHash) {
        reasons.push(
          `observation normalized record digest mismatch: ${observation.candidateId}/${observation.taskId}`,
        )
      }
      // The record must also be attributable: a correctly-hashed blob that
      // names another candidate/task/attempt — or nothing — is not evidence
      // for this observation (issue #121). Identity is compared through own
      // ENUMERABLE properties only, matching what canonicalV011 digests, so a
      // record cannot pass with identity hidden on a prototype or marked
      // non-enumerable (issue #217).
      const record = observation.normalizedRecord as unknown
      const own =
        typeof record === 'object' && record !== null && !Array.isArray(record)
          ? Object.entries(record)
          : []
      const field = (name: string): unknown => own.find(([key]) => key === name)?.[1]
      if (
        own.length === 0 ||
        field('candidateId') !== observation.candidateId ||
        field('taskId') !== observation.taskId ||
        field('attemptIndex') !== observation.attemptIndex
      ) {
        reasons.push(
          `observation record identity mismatch: ${observation.candidateId}/${observation.taskId}/${observation.attemptIndex}`,
        )
      }
    }
    if (
      !Number.isFinite(observation.costUsd) ||
      observation.costUsd < 0 ||
      !Array.isArray(observation.rawEvidenceDigests) ||
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
  const requiredFixtures = ['buildReject', 'runtimeFail', 'infraRetry', 'duplicateChild'] as const
  if (input.fixtures === null || typeof input.fixtures !== 'object') {
    reasons.push('required failure fixtures are missing or malformed')
  } else {
    // Presence AND boolean-ness: an empty or partial fixture object must not
    // sail through the entries loop (issue #217).
    for (const fixture of requiredFixtures) {
      const covered = (input.fixtures as Record<string, unknown>)[fixture]
      if (covered !== true) {
        reasons.push(`required failure fixture not covered: ${fixture}`)
      }
    }
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

/**
 * Canonical digest over the complete Gate 6 evidence envelope (issue #121):
 * recorded with the verdict so post-hoc evidence edits diverge from the
 * journal-recorded run.
 */
export function gate6EvidenceCommitment(input: Gate6AcceptanceInput): `sha256:${string}` {
  return digestV011(
    canonicalV011({
      schemaVersion: 1,
      runId: input.runId,
      targetK: input.targetK,
      capabilityMode: input.capabilityMode,
      candidates: input.candidates,
      observations: input.observations,
      allActionsTerminalAndReconciled: input.allActionsTerminalAndReconciled,
      journalReplayMatches: input.journalReplayMatches,
      realCrashResumeReceipt: input.realCrashResumeReceipt,
      fixtures: input.fixtures,
      proposerRawEvidenceReferences: input.proposerRawEvidenceReferences,
      auditCriticalFindings: input.auditCriticalFindings,
      costPredictionErrorFraction: input.costPredictionErrorFraction,
      sealedAccessCount: input.sealedAccessCount,
    }),
  )
}
