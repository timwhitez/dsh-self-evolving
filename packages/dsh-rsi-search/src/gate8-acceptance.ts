import { createHash } from 'node:crypto'
import { classifyPromotion, pairedBootstrapCi, type PromotionState } from './stats.js'

const digestPattern = /^sha256:[0-9a-f]{64}$/

export interface SealedTrialEvidence {
  role: 'baseline' | 'candidate'
  candidateId: string
  taskId: string
  attemptIndex: number
  scheduleIndex: number
  trialSeedHash: string
  normalizedRecordHash: string
  rawEvidenceDigests: string[]
  protocolHash: string
  reward: 0 | 1
  costUsd: number
}

export interface FullSetTrialEvidence {
  candidateId: string
  capsuleDigest: string
  taskId: string
  attemptIndex: number
  normalizedRecordHash: string
  rawEvidenceDigests: string[]
  protocolHash: string
  reward: 0 | 1
  costUsd: number
}

export interface Gate8EvidenceInput {
  formalSearchReceiptHash: string | null
  formalSearchStatus: 'SEARCH_COMPLETE' | 'NO_DEVELOPMENT_IMPROVEMENT' | 'NOT_STARTED'
  developmentPointDelta: number | null
  baselineCandidateId: string
  lockedCandidate: {
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
    lockReceiptHash: string
    splitMerkleRoot: string
    signatureVerified: boolean
  } | null
  splitReveal: {
    commitmentVerified: boolean
    merkleRoot: string
    revealReceiptHash: string
    revealCount: number
    preLockSealedAccessCount: number
  } | null
  sealedPlan: {
    taskCount: number
    planHash: string
    attemptsPerTask: number
    attemptsPreRegistered: boolean
    analysisContainerHash: string
    statisticsCodeHash: string
    randomInterleaveReceiptHash: string
    bootstrapSeed: bigint
    bootstrapSeedCommitment: string
    bootstrapResamples: number
    minLift: number
    noIntermediateFeedback: boolean
  } | null
  sealedTrials: SealedTrialEvidence[]
  sealedActionsTerminalAndReconciled: boolean
  sealedJournalReplayMatches: boolean
  auditCriticalFindings: number
  reportedPromotionState: PromotionState | 'PROTOCOL_INVALID' | 'NOT_EVALUATED'
  fullSet: {
    verificationStatus: 'FULL_SET_VERIFIED_LOCAL' | 'LEADERBOARD_VERIFIED'
    officialMaintainerReceiptHash: string | null
    taskCount: number
    attemptsPerTask: number
    protocolHash: string
    trials: FullSetTrialEvidence[]
    actionsTerminalAndReconciled: boolean
    journalReplayMatches: boolean
    noAdaptation: boolean
  } | null
  release: {
    packInstallFreshProfileReceiptHash: string
    loaderSmokeReceiptHash: string
    sourceDigest: string
    bundleDigest: string
    capsuleDigest: string
    sbomDigest: string
    provenanceDigest: string
    checksumsDigest: string
    reportsDigest: string
    rollbackReceiptHash: string
    publicExportLeakScanReceiptHash: string
  } | null
}

export interface Gate8EvidenceVerdict {
  protocolValid: boolean
  promotionState: PromotionState | 'PROTOCOL_INVALID' | 'NOT_EVALUATED'
  sealedComplete: boolean
  fullSetEligible: boolean
  fullSetVerified: boolean
  releaseVerified: boolean
  reasons: string[]
}

function validDigest(value: string | null): value is string {
  return value !== null && digestPattern.test(value)
}

function bootstrapSeedCommitment(seed: bigint): string {
  return `sha256:${createHash('sha256')
    .update(`bootstrap-seed:${seed.toString(16)}`)
    .digest('hex')}`
}

function validTrialArtifacts(trial: {
  normalizedRecordHash: string
  rawEvidenceDigests: string[]
  protocolHash: string
  costUsd: number
}): boolean {
  return (
    validDigest(trial.normalizedRecordHash) &&
    trial.rawEvidenceDigests.length > 0 &&
    trial.rawEvidenceDigests.every(validDigest) &&
    validDigest(trial.protocolHash) &&
    Number.isFinite(trial.costUsd) &&
    trial.costUsd >= 0
  )
}

export function verifyGate8Evidence(input: Gate8EvidenceInput): Gate8EvidenceVerdict {
  const reasons: string[] = []
  let computedPromotion: PromotionState | 'PROTOCOL_INVALID' | 'NOT_EVALUATED' = 'NOT_EVALUATED'
  if (
    !validDigest(input.formalSearchReceiptHash) ||
    input.formalSearchStatus !== 'SEARCH_COMPLETE'
  ) {
    reasons.push('accepted SEARCH_COMPLETE receipt missing')
  }
  if (
    input.developmentPointDelta === null ||
    !Number.isFinite(input.developmentPointDelta) ||
    input.developmentPointDelta <= 0
  ) {
    reasons.push('positive development champion was not established')
  }
  const lock = input.lockedCandidate
  if (!validDigest(input.baselineCandidateId))
    reasons.push('baseline candidate identity is invalid')
  if (
    lock === null ||
    !validDigest(lock.candidateId) ||
    !validDigest(lock.sourceDigest) ||
    !validDigest(lock.capsuleDigest) ||
    !validDigest(lock.runManifestDigest) ||
    !validDigest(lock.baselineCandidateId) ||
    !validDigest(lock.baselineCapsuleDigest) ||
    !validDigest(lock.modelRouteHash) ||
    !validDigest(lock.protocolHash) ||
    !validDigest(lock.sealedPlanHash) ||
    !validDigest(lock.analysisContainerHash) ||
    !validDigest(lock.lockReceiptHash) ||
    !validDigest(lock.splitMerkleRoot) ||
    !lock.signatureVerified
  ) {
    reasons.push('signed immutable candidate lock is missing or invalid')
  }
  const reveal = input.splitReveal
  if (
    reveal === null ||
    !reveal.commitmentVerified ||
    !validDigest(reveal.merkleRoot) ||
    !validDigest(reveal.revealReceiptHash) ||
    reveal.revealCount !== 1 ||
    reveal.preLockSealedAccessCount !== 0
  ) {
    reasons.push('single reveal/split commitment/pre-lock access evidence is invalid')
  }
  const plan = input.sealedPlan
  if (
    plan === null ||
    plan.taskCount !== 29 ||
    !validDigest(plan.planHash) ||
    !Number.isSafeInteger(plan.attemptsPerTask) ||
    plan.attemptsPerTask < 1 ||
    !plan.attemptsPreRegistered ||
    !validDigest(plan.analysisContainerHash) ||
    !validDigest(plan.statisticsCodeHash) ||
    !validDigest(plan.randomInterleaveReceiptHash) ||
    !validDigest(plan.bootstrapSeedCommitment) ||
    plan.bootstrapSeedCommitment !== bootstrapSeedCommitment(plan.bootstrapSeed) ||
    plan.bootstrapResamples < 100_000 ||
    plan.minLift !== 0.05 ||
    !plan.noIntermediateFeedback
  ) {
    reasons.push('sealed analysis/schedule plan is missing, mutable, or underpowered')
  }

  if (lock !== null && reveal !== null && lock.splitMerkleRoot !== reveal.merkleRoot) {
    reasons.push('candidate lock is bound to a different split')
  }
  if (
    lock !== null &&
    plan !== null &&
    (lock.baselineCandidateId !== input.baselineCandidateId ||
      lock.sealedPlanHash !== plan.planHash ||
      lock.analysisContainerHash !== plan.analysisContainerHash)
  ) {
    reasons.push('candidate lock is not bound to baseline/sealed-plan/analysis identities')
  }

  if (lock !== null && plan !== null) {
    const expectedPerRole = 29 * plan.attemptsPerTask
    const trialKeys = new Set<string>()
    const scheduleIndexes = new Set<number>()
    const taskIds = new Set<string>()
    const pairs = new Map<
      string,
      { baseline?: SealedTrialEvidence; candidate?: SealedTrialEvidence }
    >()
    for (const trial of input.sealedTrials) {
      const key = `${trial.role}/${trial.taskId}/${trial.attemptIndex}`
      if (trialKeys.has(key)) reasons.push(`duplicate sealed trial: ${key}`)
      trialKeys.add(key)
      if (scheduleIndexes.has(trial.scheduleIndex)) {
        reasons.push(`duplicate sealed schedule index: ${trial.scheduleIndex}`)
      }
      scheduleIndexes.add(trial.scheduleIndex)
      taskIds.add(trial.taskId)
      const pairKey = `${trial.taskId}/${trial.attemptIndex}`
      const pair = pairs.get(pairKey) ?? {}
      pair[trial.role] = trial
      pairs.set(pairKey, pair)
      const expectedCandidate =
        trial.role === 'baseline' ? input.baselineCandidateId : lock.candidateId
      if (trial.candidateId !== expectedCandidate)
        reasons.push(`sealed attribution mismatch: ${key}`)
      if (
        trial.attemptIndex < 0 ||
        trial.attemptIndex >= plan.attemptsPerTask ||
        trial.scheduleIndex < 0 ||
        trial.scheduleIndex >= expectedPerRole * 2 ||
        !validDigest(trial.trialSeedHash) ||
        !validTrialArtifacts(trial) ||
        trial.protocolHash !== lock.protocolHash
      ) {
        reasons.push(`sealed trial identity/artifact invalid: ${key}`)
      }
    }
    if (
      taskIds.size !== 29 ||
      input.sealedTrials.length !== expectedPerRole * 2 ||
      trialKeys.size !== expectedPerRole * 2 ||
      scheduleIndexes.size !== expectedPerRole * 2
    ) {
      reasons.push('sealed 29 x k paired trial matrix is incomplete')
    }
    for (const [pairKey, pair] of pairs) {
      if (pair.baseline === undefined || pair.candidate === undefined) {
        reasons.push(`sealed pair incomplete: ${pairKey}`)
      } else if (pair.baseline.trialSeedHash === pair.candidate.trialSeedHash) {
        reasons.push(`sealed pair lacks independent trial seeds: ${pairKey}`)
      } else if (pair.baseline.protocolHash !== pair.candidate.protocolHash) {
        reasons.push(`sealed pair protocol mismatch: ${pairKey}`)
      }
    }
    if (reasons.length === 0) {
      const perTask = [...taskIds].sort().map((taskId) => {
        const taskPairs = [...pairs.entries()]
          .filter(([key]) => key.startsWith(`${taskId}/`))
          .map(([, pair]) => pair as Required<typeof pair>)
        return {
          taskId,
          baselineReward:
            taskPairs.reduce((sum, pair) => sum + pair.baseline.reward, 0) / plan.attemptsPerTask,
          candidateReward:
            taskPairs.reduce((sum, pair) => sum + pair.candidate.reward, 0) / plan.attemptsPerTask,
        }
      })
      const result = pairedBootstrapCi(perTask, {
        nResamples: plan.bootstrapResamples,
        masterSeed: plan.bootstrapSeed,
        minLift: plan.minLift,
      })
      computedPromotion = classifyPromotion(result, plan.minLift)
      if (input.auditCriticalFindings !== 0) computedPromotion = 'SEALED_REJECTED'
      if (input.reportedPromotionState !== computedPromotion) {
        reasons.push(
          `reported promotion state ${input.reportedPromotionState} != computed ${computedPromotion}`,
        )
      }
    } else {
      computedPromotion = 'PROTOCOL_INVALID'
    }
  }
  if (!input.sealedActionsTerminalAndReconciled) {
    reasons.push('sealed actions are not terminal/reconciled')
  }
  if (!input.sealedJournalReplayMatches) reasons.push('sealed journal replay mismatch')
  if (!Number.isSafeInteger(input.auditCriticalFindings) || input.auditCriticalFindings < 0) {
    reasons.push('audit critical finding count is invalid')
  }
  const sealedComplete = reasons.length === 0 && computedPromotion !== 'NOT_EVALUATED'
  const fullSetEligible = sealedComplete && computedPromotion === 'SEALED_PROMOTED'

  let fullSetVerified = false
  if (input.fullSet !== null) {
    const full = input.fullSet
    if (!fullSetEligible)
      reasons.push('full-set evaluation exists without SEALED_PROMOTED eligibility')
    if (
      full.taskCount !== 89 ||
      !Number.isSafeInteger(full.attemptsPerTask) ||
      full.attemptsPerTask < 5 ||
      !validDigest(full.protocolHash) ||
      lock === null ||
      full.protocolHash !== lock.protocolHash ||
      !full.actionsTerminalAndReconciled ||
      !full.journalReplayMatches ||
      !full.noAdaptation
    ) {
      reasons.push('full-set protocol/reconciliation identity is invalid')
    }
    if (
      full.verificationStatus !== 'FULL_SET_VERIFIED_LOCAL' &&
      full.verificationStatus !== 'LEADERBOARD_VERIFIED'
    ) {
      reasons.push('full-set verification status is invalid')
    }
    const expectedTrials = full.taskCount * full.attemptsPerTask
    const keys = new Set<string>()
    const tasks = new Set<string>()
    for (const trial of full.trials) {
      const key = `${trial.taskId}/${trial.attemptIndex}`
      if (keys.has(key)) reasons.push(`duplicate full-set trial: ${key}`)
      keys.add(key)
      tasks.add(trial.taskId)
      if (
        lock === null ||
        trial.candidateId !== lock.candidateId ||
        trial.capsuleDigest !== lock.capsuleDigest ||
        trial.protocolHash !== full.protocolHash ||
        trial.attemptIndex < 0 ||
        trial.attemptIndex >= full.attemptsPerTask ||
        !validTrialArtifacts(trial)
      ) {
        reasons.push(`full-set trial identity/artifact invalid: ${key}`)
      }
    }
    if (
      tasks.size !== 89 ||
      keys.size !== expectedTrials ||
      full.trials.length !== expectedTrials
    ) {
      reasons.push('full-set 89 x >=5 trial matrix is incomplete')
    }
    if (
      full.verificationStatus === 'LEADERBOARD_VERIFIED' &&
      !validDigest(full.officialMaintainerReceiptHash)
    ) {
      reasons.push('leaderboard verification lacks official maintainer receipt')
    }
    fullSetVerified = reasons.length === 0
  } else if (fullSetEligible) {
    reasons.push('eligible promoted candidate lacks full-set evaluation')
  }

  let releaseVerified = false
  if (input.release !== null) {
    const release = input.release
    const releaseHashes = Object.entries(release).filter(([field]) => field !== 'sourceDigest')
    if (
      !fullSetVerified ||
      lock === null ||
      release.sourceDigest !== lock.sourceDigest ||
      release.capsuleDigest !== lock.capsuleDigest ||
      releaseHashes.some(([, value]) => !validDigest(value))
    ) {
      reasons.push(
        'release identity/artifacts/fresh-profile/rollback/leak-scan evidence is invalid',
      )
    } else {
      releaseVerified = true
    }
  } else if (fullSetVerified) {
    reasons.push('verified full-set result lacks release evidence')
  }

  if (reasons.length > 0 && computedPromotion === 'NOT_EVALUATED') {
    computedPromotion = 'PROTOCOL_INVALID'
  }
  return {
    protocolValid: sealedComplete,
    promotionState: computedPromotion,
    sealedComplete,
    fullSetEligible,
    fullSetVerified,
    releaseVerified,
    reasons: [...new Set(reasons)].sort(),
  }
}
