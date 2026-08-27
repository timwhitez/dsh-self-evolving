import { createHash } from 'node:crypto'
import { canonicalV011, digestV011 } from '@dsh-self-evolving/candidate-sdk'
import {
  MAX_BOOTSTRAP_RESAMPLES,
  classifyPromotion,
  pairedBootstrapCi,
  type PromotionState,
} from './stats.js'
import { commitSplit, SPLIT_SIZES } from './split.js'

const digestPattern = /^sha256:[0-9a-f]{64}$/

export interface SealedTrialEvidence {
  role: 'baseline' | 'candidate'
  candidateId: string
  taskId: string
  attemptIndex: number
  scheduleIndex: number
  trialSeedHash: string
  normalizedRecordHash: string
  /**
   * The normalized record content itself (issue #219): the verifier recomputes
   * its canonical digest and requires it to equal normalizedRecordHash, and
   * requires the record's own identity fields to match this row.
   */
  normalizedRecord: unknown
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
  /**
   * The normalized record content itself (issue #219): digest recomputation
   * and row-identity binding, mirroring the sealed matrix.
   */
  normalizedRecord: unknown
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
    /**
     * Canonical one-time revealed sealed task list (issue #110): the trial
     * matrix must match THIS set exactly, not merely 29 arbitrary ids.
     */
    revealedTaskIds: string[]
    /**
     * The complete one-time revealed assignment over the whole inventory
     * (48 dev-observed + 12 dev-guard + 29 sealed rows), recommitted via the
     * ceremony's own commitSplit to prove the revealed sealed set is the
     * committed one (issue #110/#111).
     */
    revealedAssignment: Array<{
      taskId: string
      label: 'dev-observed' | 'dev-guard' | 'sealed'
    }>
    /** The full ceremony commitment (sizes, seed commitment, digests). */
    commitment: {
      seedCommitment: string
      taskInventoryDigest: string
      sizes: { devObserved: number; devGuard: number; sealed: number }
    }
    /** The complete task inventory the commitment was minted over. */
    inventoryTaskIds: string[]
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
    /**
     * Canonical official 89-task inventory list (issue #110): full-set trials
     * must match THIS universe exactly, not merely 89 arbitrary ids.
     */
    inventoryTaskIds: string[]
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
  reward: unknown
  costUsd: number
}): boolean {
  return (
    trial.rawEvidenceDigests.length > 0 &&
    trial.rawEvidenceDigests.every(validDigest) &&
    validDigest(trial.protocolHash) &&
    (trial.reward === 0 || trial.reward === 1) &&
    Number.isFinite(trial.costUsd) &&
    trial.costUsd >= 0
  )
}

/**
 * Verify a trial's record content against its claims (issue #219): the
 * record must be present, hash to its claimed digest, and carry the trial
 * row's own identity. Identity is compared through own enumerable properties
 * only, matching what canonicalV011 digests, so a record cannot pass with
 * identity fields hidden on a prototype or marked non-enumerable.
 */
function recordIdentityMatches(
  record: unknown,
  trial: { candidateId: string; taskId: string; attemptIndex: number },
): boolean {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return false
  const own = Object.entries(record)
  const field = (name: string): unknown =>
    own.find(([key]) => key === name)?.[1]
  return (
    field('candidateId') === trial.candidateId &&
    field('taskId') === trial.taskId &&
    field('attemptIndex') === trial.attemptIndex
  )
}

/**
 * Record-content checks for one trial row (issue #219): missing content,
 * digest divergence, or identity mismatch each yield their own reason so a
 * forged envelope cannot hide behind a generic artifact failure.
 */
function trialRecordReason(
  trial: {
    candidateId: string
    taskId: string
    attemptIndex: number
    normalizedRecordHash: string
    normalizedRecord: unknown
  },
  key: string,
): string | null {
  if (trial.normalizedRecord === undefined || trial.normalizedRecord === null) {
    return `trial normalized record missing: ${key}`
  }
  if (digestV011(canonicalV011(trial.normalizedRecord)) !== trial.normalizedRecordHash) {
    return `trial normalized record digest mismatch: ${key}`
  }
  if (!recordIdentityMatches(trial.normalizedRecord, trial)) {
    return `trial record identity mismatch: ${key}`
  }
  return null
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
    !Number.isSafeInteger(plan.bootstrapResamples) ||
    plan.bootstrapResamples < 100_000 ||
    plan.bootstrapResamples > MAX_BOOTSTRAP_RESAMPLES ||
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
      const recordReason = trialRecordReason(trial, `sealed/${key}`)
      if (recordReason !== null) reasons.push(recordReason)
    }
    if (
      taskIds.size !== 29 ||
      input.sealedTrials.length !== expectedPerRole * 2 ||
      trialKeys.size !== expectedPerRole * 2 ||
      scheduleIndexes.size !== expectedPerRole * 2
    ) {
      reasons.push('sealed 29 x k paired trial matrix is incomplete')
    }
    // Exact membership, not cardinality: every evaluated task must belong to
    // the canonical one-time revealed set and cover it completely (issue
    // #110). A 29-task matrix of easier substitutes must fail here.
    if (reveal !== null && Array.isArray(reveal.revealedTaskIds)) {
      const uniqueRevealed = new Set(reveal.revealedTaskIds)
      const revealed = [...uniqueRevealed].sort()
      if (
        reveal.revealedTaskIds.length !== 29 ||
        uniqueRevealed.size !== 29 ||
        reveal.revealedTaskIds.some((id) => id.length === 0 || id.trim() !== id)
      ) {
        reasons.push('revealed sealed task list is not 29 unique canonical ids')
      }
      const evaluated = [...taskIds].sort()
      if (JSON.stringify(evaluated) !== JSON.stringify(revealed)) {
        reasons.push('sealed trial matrix does not match the revealed sealed task set')
      }
      // Recompute the split commitment from the revealed assignment: the
      // revealed set is provably the committed one, not a self-declared list
      // (issues #110/#111).
      // Protocol constants, not caller choices (spec 04 §3.1): the ceremony
      // is always 48/12/29 over the pinned 89-task inventory. Checked
      // independently of the recommit so a fabricated small ceremony cannot
      // slip through on a throw.
      const commitment = reveal.commitment as
        | { sizes?: { devObserved?: unknown; devGuard?: unknown; sealed?: unknown } }
        | undefined
      if (
        commitment?.sizes?.devObserved !== SPLIT_SIZES.devObserved ||
        commitment?.sizes?.devGuard !== SPLIT_SIZES.devGuard ||
        commitment?.sizes?.sealed !== SPLIT_SIZES.sealed ||
        reveal.inventoryTaskIds.length !== 89
      ) {
        reasons.push('split commitment sizes/inventory do not match the frozen protocol')
      }
      if (Array.isArray(reveal.revealedAssignment) && Array.isArray(reveal.inventoryTaskIds)) {
        try {
          const recomputed = commitSplit(
            reveal.revealedAssignment,
            reveal.commitment.seedCommitment,
            reveal.inventoryTaskIds,
            reveal.commitment.sizes,
          )
          if (recomputed.merkleRoot !== reveal.merkleRoot) {
            reasons.push('revealed sealed set is not committed by the split Merkle root')
          }
          if (recomputed.taskInventoryDigest !== reveal.commitment.taskInventoryDigest) {
            reasons.push('revealed inventory does not match the committed task inventory digest')
          }
          // The sealed rows of the recommitted assignment must BE the revealed
          // sealed set, so the evaluated matrix is exactly the committed
          // sealed stratum.
          const committedSealed = reveal.revealedAssignment
            .filter((row) => row.label === 'sealed')
            .map((row) => row.taskId)
            .sort()
          if (JSON.stringify(committedSealed) !== JSON.stringify(revealed)) {
            reasons.push('revealed sealed set does not match the committed sealed stratum')
          }
        } catch {
          reasons.push('revealed split assignment cannot be recommitted')
        }
      } else {
        reasons.push('revealed split assignment/inventory evidence is missing')
      }
    } else {
      reasons.push('revealed sealed task list is missing')
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
      const recordReason = trialRecordReason(trial, `full-set/${key}`)
      if (recordReason !== null) reasons.push(recordReason)
    }
    if (
      tasks.size !== 89 ||
      keys.size !== expectedTrials ||
      full.trials.length !== expectedTrials
    ) {
      reasons.push('full-set 89 x >=5 trial matrix is incomplete')
    }
    // Exact membership against the official inventory universe (issue #110) —
    // and the SAME universe the sealed ceremony committed over (spec 04
    // §11: one pinned 89-task dataset for split and full set).
    if (reveal !== null && Array.isArray(reveal.inventoryTaskIds)) {
      const sealedInventory = [...new Set(reveal.inventoryTaskIds)].sort()
      const fullInventorySorted = [...new Set(full.inventoryTaskIds)].sort()
      if (JSON.stringify(sealedInventory) !== JSON.stringify(fullInventorySorted)) {
        reasons.push('sealed ceremony and full-set inventories are different task universes')
      }
    }
    if (!Array.isArray(full.inventoryTaskIds)) {
      reasons.push('official inventory list is missing')
    } else {
      const uniqueInventory = new Set(full.inventoryTaskIds)
      const inventory = [...uniqueInventory].sort()
      if (
        full.inventoryTaskIds.length !== 89 ||
        uniqueInventory.size !== 89 ||
        full.inventoryTaskIds.some((id) => id.length === 0 || id.trim() !== id)
      ) {
        reasons.push('official inventory list is not 89 unique canonical ids')
      }
      const evaluatedFull = [...tasks].sort()
      if (JSON.stringify(evaluatedFull) !== JSON.stringify(inventory)) {
        reasons.push('full-set trial matrix does not match the official inventory')
      }
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
