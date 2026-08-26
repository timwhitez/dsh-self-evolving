import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  verifyGate8Evidence,
  type Gate8EvidenceInput,
  type SealedTrialEvidence,
} from '../src/index.js'

const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`

function complete(): Gate8EvidenceInput {
  const baselineCandidateId = digest('baseline-candidate')
  const candidateId = digest('locked-candidate')
  const capsuleDigest = digest('locked-capsule')
  const protocolHash = digest('protocol')
  const planHash = digest('sealed-plan')
  const analysisContainerHash = digest('analysis-container')
  const attemptsPerTask = 5
  const sealedTrials: SealedTrialEvidence[] = []
  let scheduleIndex = 0
  for (let task = 0; task < 29; task++) {
    for (let attemptIndex = 0; attemptIndex < attemptsPerTask; attemptIndex++) {
      const taskId = `sealed-task-${task}`
      sealedTrials.push({
        role: 'baseline',
        candidateId: baselineCandidateId,
        taskId,
        attemptIndex,
        scheduleIndex: scheduleIndex++,
        trialSeedHash: digest(`baseline-seed-${task}-${attemptIndex}`),
        normalizedRecordHash: digest(`baseline-normalized-${task}-${attemptIndex}`),
        rawEvidenceDigests: [digest(`baseline-raw-${task}-${attemptIndex}`)],
        protocolHash,
        reward: task < 9 ? 1 : 0,
        costUsd: 0.01,
      })
      sealedTrials.push({
        role: 'candidate',
        candidateId,
        taskId,
        attemptIndex,
        scheduleIndex: scheduleIndex++,
        trialSeedHash: digest(`candidate-seed-${task}-${attemptIndex}`),
        normalizedRecordHash: digest(`candidate-normalized-${task}-${attemptIndex}`),
        rawEvidenceDigests: [digest(`candidate-raw-${task}-${attemptIndex}`)],
        protocolHash,
        reward: 1,
        costUsd: 0.01,
      })
    }
  }
  const fullTrials = Array.from({ length: 89 }, (_, task) =>
    Array.from({ length: 5 }, (_, attemptIndex) => ({
      candidateId,
      capsuleDigest,
      taskId: `full-task-${task}`,
      attemptIndex,
      normalizedRecordHash: digest(`full-normalized-${task}-${attemptIndex}`),
      rawEvidenceDigests: [digest(`full-raw-${task}-${attemptIndex}`)],
      protocolHash,
      reward: 1 as const,
      costUsd: 0.01,
    })),
  ).flat()
  return {
    formalSearchReceiptHash: digest('search-complete'),
    formalSearchStatus: 'SEARCH_COMPLETE',
    developmentPointDelta: 0.1,
    baselineCandidateId,
    lockedCandidate: {
      candidateId,
      sourceDigest: digest('locked-source'),
      capsuleDigest,
      runManifestDigest: digest('run-manifest'),
      baselineCandidateId,
      baselineCapsuleDigest: digest('baseline-capsule'),
      modelRouteHash: digest('model-route'),
      protocolHash,
      sealedPlanHash: planHash,
      analysisContainerHash,
      lockReceiptHash: digest('candidate-lock'),
      splitMerkleRoot: digest('split-root'),
      signatureVerified: true,
    },
    splitReveal: {
      commitmentVerified: true,
      merkleRoot: digest('split-root'),
      revealReceiptHash: digest('reveal'),
      revealCount: 1,
      preLockSealedAccessCount: 0,
      revealedTaskIds: Array.from({ length: 29 }, (_, task) => `sealed-task-${task}`),
    },
    sealedPlan: {
      taskCount: 29,
      planHash,
      attemptsPerTask,
      attemptsPreRegistered: true,
      analysisContainerHash,
      statisticsCodeHash: digest('statistics-code'),
      randomInterleaveReceiptHash: digest('interleave'),
      bootstrapSeed: 42n,
      bootstrapSeedCommitment: digest('bootstrap-seed:2a'),
      bootstrapResamples: 100_000,
      minLift: 0.05,
      noIntermediateFeedback: true,
    },
    sealedTrials,
    sealedActionsTerminalAndReconciled: true,
    sealedJournalReplayMatches: true,
    auditCriticalFindings: 0,
    reportedPromotionState: 'SEALED_PROMOTED',
    fullSet: {
      verificationStatus: 'FULL_SET_VERIFIED_LOCAL',
      inventoryTaskIds: Array.from({ length: 89 }, (_, task) => `full-task-${task}`),
      officialMaintainerReceiptHash: null,
      taskCount: 89,
      attemptsPerTask: 5,
      protocolHash,
      trials: fullTrials,
      actionsTerminalAndReconciled: true,
      journalReplayMatches: true,
      noAdaptation: true,
    },
    release: {
      packInstallFreshProfileReceiptHash: digest('fresh-profile'),
      loaderSmokeReceiptHash: digest('loader-smoke'),
      sourceDigest: digest('locked-source'),
      bundleDigest: digest('bundle'),
      capsuleDigest,
      sbomDigest: digest('sbom'),
      provenanceDigest: digest('provenance'),
      checksumsDigest: digest('checksums'),
      reportsDigest: digest('reports'),
      rollbackReceiptHash: digest('rollback'),
      publicExportLeakScanReceiptHash: digest('leak-scan'),
    },
  }
}

describe('Gate 8 sealed/full/release evidence', () => {
  it('accepts complete paired sealed promotion, 89x5 local full set, and release evidence', () => {
    const verdict = verifyGate8Evidence(complete())
    expect(verdict.reasons, verdict.reasons.join('\n')).toEqual([])
    expect(verdict).toMatchObject({
      protocolValid: true,
      promotionState: 'SEALED_PROMOTED',
      sealedComplete: true,
      fullSetEligible: true,
      fullSetVerified: true,
      releaseVerified: true,
    })
  })

  it('rejects every non-binary runtime reward before statistical analysis', () => {
    for (const reward of [-1, 0.5, 2, Number.NaN, Number.POSITIVE_INFINITY]) {
      const sealed = complete()
      ;(sealed.sealedTrials[0] as unknown as { reward: number }).reward = reward
      sealed.reportedPromotionState = 'PROTOCOL_INVALID'
      sealed.fullSet = null
      sealed.release = null
      const sealedVerdict = verifyGate8Evidence(sealed)
      expect(sealedVerdict.protocolValid).toBe(false)
      expect(sealedVerdict.reasons.join('\n')).toMatch(/sealed trial identity\/artifact invalid/)

      const full = complete()
      ;(full.fullSet!.trials[0] as unknown as { reward: number }).reward = reward
      const fullVerdict = verifyGate8Evidence(full)
      expect(fullVerdict.fullSetVerified).toBe(false)
      expect(fullVerdict.reasons.join('\n')).toMatch(/full-set trial identity\/artifact invalid/)
    }
  })

  it('rejects non-finite, fractional, underpowered, and excessive bootstrap counts', () => {
    for (const bootstrapResamples of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      100_000.5,
      0,
      99_999,
      1_000_001,
    ]) {
      const input = complete()
      input.sealedPlan!.bootstrapResamples = bootstrapResamples
      input.reportedPromotionState = 'PROTOCOL_INVALID'
      input.fullSet = null
      input.release = null
      const verdict = verifyGate8Evidence(input)
      expect(verdict.protocolValid).toBe(false)
      expect(verdict.reasons.join('\n')).toMatch(/underpowered/)
    }

    const exactMinimum = complete()
    exactMinimum.sealedPlan!.bootstrapResamples = 100_000
    expect(verifyGate8Evidence(exactMinimum).protocolValid).toBe(true)
  })

  it('marks an incomplete paired matrix protocol-invalid and ineligible for full set', () => {
    const input = complete()
    input.sealedTrials.pop()
    input.reportedPromotionState = 'PROTOCOL_INVALID'
    input.fullSet = null
    input.release = null
    const verdict = verifyGate8Evidence(input)
    expect(verdict.protocolValid).toBe(false)
    expect(verdict.promotionState).toBe('PROTOCOL_INVALID')
    expect(verdict.fullSetEligible).toBe(false)
    expect(verdict.reasons.join('\n')).toMatch(/paired trial matrix is incomplete/)
  })

  it('allows an honest sealed rejection but forbids a subsequent full-set claim', () => {
    const input = complete()
    const baselineRewards = new Map(
      input.sealedTrials
        .filter((trial) => trial.role === 'baseline')
        .map((trial) => [`${trial.taskId}/${trial.attemptIndex}`, trial.reward]),
    )
    for (const trial of input.sealedTrials) {
      if (trial.role === 'candidate') {
        trial.reward = baselineRewards.get(`${trial.taskId}/${trial.attemptIndex}`) ?? 0
      }
    }
    input.reportedPromotionState = 'SEALED_REJECTED'
    input.release = null
    const verdict = verifyGate8Evidence(input)
    expect(verdict.promotionState).toBe('SEALED_REJECTED')
    expect(verdict.fullSetEligible).toBe(false)
    expect(verdict.fullSetVerified).toBe(false)
    expect(verdict.reasons.join('\n')).toMatch(/without SEALED_PROMOTED eligibility/)
  })

  it('rejects a sealed matrix whose tasks are not the revealed set (issue #110)', () => {
    const input = complete()
    // Substitute one evaluated task with an easier impostor: counts stay 29.
    input.sealedTrials = input.sealedTrials.map((trial) =>
      trial.taskId === 'sealed-task-0' ? { ...trial, taskId: 'easy-impostor-task' } : trial,
    )
    const verdict = verifyGate8Evidence(input)
    expect(verdict.sealedComplete).toBe(false)
    expect(verdict.reasons.join('\n')).toMatch(/does not match the revealed sealed task set/)
  })

  it('rejects a malformed revealed list (wrong count or duplicates)', () => {
    const input = complete()
    input.splitReveal = {
      ...input.splitReveal!,
      revealedTaskIds: [...input.splitReveal!.revealedTaskIds.slice(1)],
    }
    let verdict = verifyGate8Evidence(input)
    expect(verdict.reasons.join('\n')).toMatch(/not 29 unique canonical ids/)
    // Duplicates at the right length are rejected too.
    input.splitReveal = {
      ...input.splitReveal!,
      revealedTaskIds: [
        input.splitReveal!.revealedTaskIds[0]!,
        ...input.splitReveal!.revealedTaskIds.slice(0, 28),
      ],
    }
    verdict = verifyGate8Evidence(input)
    expect(verdict.reasons.join('\n')).toMatch(/not 29 unique canonical ids/)
    // A missing list degrades to a reason, never a TypeError.
    input.splitReveal = { ...input.splitReveal!, revealedTaskIds: undefined as never }
    verdict = verifyGate8Evidence(input)
    expect(verdict.reasons.join('\n')).toMatch(/revealed sealed task list is missing/)
  })

  it('rejects a missing or malformed official inventory list', () => {
    const input = complete()
    input.fullSet = { ...input.fullSet!, inventoryTaskIds: undefined as never }
    let verdict = verifyGate8Evidence(input)
    expect(verdict.reasons.join('\n')).toMatch(/inventory list is missing/)
    const original = complete().fullSet!.inventoryTaskIds
    input.fullSet = {
      ...input.fullSet!,
      inventoryTaskIds: [original[0]!, ...original.slice(0, 88)],
    }
    verdict = verifyGate8Evidence(input)
    expect(verdict.reasons.join('\n')).toMatch(/not 89 unique canonical ids/)
  })

  it('rejects a full-set matrix whose tasks are not the official inventory', () => {
    const input = complete()
    input.fullSet = {
      ...input.fullSet!,
      trials: input.fullSet!.trials.map((trial) =>
        trial.taskId === 'full-task-0' ? { ...trial, taskId: 'substituted-task' } : trial,
      ),
    }
    const verdict = verifyGate8Evidence(input)
    expect(verdict.fullSetVerified).toBe(false)
    expect(verdict.reasons.join('\n')).toMatch(/does not match the official inventory/)
  })
})
