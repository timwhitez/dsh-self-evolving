import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canonicalV011, digestV011 } from '@dsh-self-evolving/candidate-sdk'
import {
  commitSplit,
  gate8EvidenceCommitment,
  verifyGate8Evidence,
  type Gate8EvidenceInput,
  type SealedTrialEvidence,
} from '../src/index.js'

const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`
const recordDigest = (record: unknown) => digestV011(canonicalV011(record))

function completeSplitReveal() {
  const inventory = Array.from({ length: 89 }, (_, task) => `task-${String(task).padStart(3, '0')}`)
  const sealedIds = inventory.slice(60)
  const assignment = [
    ...inventory.slice(0, 48).map((taskId) => ({ taskId, label: 'dev-observed' as const })),
    ...inventory.slice(48, 60).map((taskId) => ({ taskId, label: 'dev-guard' as const })),
    ...sealedIds.map((taskId) => ({ taskId, label: 'sealed' as const })),
  ]
  const commitment = commitSplit(assignment, digest('seed-commitment'), inventory)
  return {
    commitmentVerified: true,
    merkleRoot: commitment.merkleRoot,
    revealReceiptHash: digest('reveal'),
    revealCount: 1,
    preLockSealedAccessCount: 0,
    revealedTaskIds: sealedIds,
    revealedAssignment: assignment,
    commitment: {
      seedCommitment: digest('seed-commitment'),
      taskInventoryDigest: commitment.taskInventoryDigest,
      sizes: { devObserved: 48, devGuard: 12, sealed: 29 },
    },
    inventoryTaskIds: inventory,
  }
}

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
      const taskId = `task-${String(task + 60).padStart(3, '0')}`
      const baselineReward = task < 9 ? 1 : 0
      const baselineRecord = {
        schemaVersion: 1,
        role: 'baseline',
        candidateId: baselineCandidateId,
        taskId,
        attemptIndex,
        reward: baselineReward,
        costUsd: 0.01,
      }
      sealedTrials.push({
        role: 'baseline',
        candidateId: baselineCandidateId,
        taskId,
        attemptIndex,
        scheduleIndex: scheduleIndex++,
        trialSeedHash: digest(`baseline-seed-${task}-${attemptIndex}`),
        normalizedRecordHash: recordDigest(baselineRecord),
        normalizedRecord: baselineRecord,
        rawEvidenceDigests: [digest(`baseline-raw-${task}-${attemptIndex}`)],
        protocolHash,
        reward: baselineReward,
        costUsd: 0.01,
      })
      const candidateRecord = {
        schemaVersion: 1,
        role: 'candidate',
        candidateId,
        taskId,
        attemptIndex,
        reward: 1,
        costUsd: 0.01,
      }
      sealedTrials.push({
        role: 'candidate',
        candidateId,
        taskId,
        attemptIndex,
        scheduleIndex: scheduleIndex++,
        trialSeedHash: digest(`candidate-seed-${task}-${attemptIndex}`),
        normalizedRecordHash: recordDigest(candidateRecord),
        normalizedRecord: candidateRecord,
        rawEvidenceDigests: [digest(`candidate-raw-${task}-${attemptIndex}`)],
        protocolHash,
        reward: 1,
        costUsd: 0.01,
      })
    }
  }
  const fullTrials = Array.from({ length: 89 }, (_, task) =>
    Array.from({ length: 5 }, (_, attemptIndex) => {
      const fullRecord = {
        schemaVersion: 1,
        candidateId,
        capsuleDigest,
        taskId: `task-${String(task).padStart(3, '0')}`,
        attemptIndex,
        reward: 1,
        costUsd: 0.01,
      }
      return {
        candidateId,
        capsuleDigest,
        taskId: fullRecord.taskId,
        attemptIndex,
        normalizedRecordHash: recordDigest(fullRecord),
        normalizedRecord: fullRecord,
        rawEvidenceDigests: [digest(`full-raw-${task}-${attemptIndex}`)],
        protocolHash,
        reward: 1 as const,
        costUsd: 0.01,
      }
    }),
  ).flat()
  const input = {
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
      splitMerkleRoot: completeSplitReveal().merkleRoot,
      signatureVerified: true,
    },
    splitReveal: completeSplitReveal(),
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
      inventoryTaskIds: Array.from(
        { length: 89 },
        (_, task) => `task-${String(task).padStart(3, '0')}`,
      ),
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
  } as unknown as Gate8EvidenceInput
  input.evidenceCommitment = gate8EvidenceCommitment(input)
  return input
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
        const reward = baselineRewards.get(`${trial.taskId}/${trial.attemptIndex}`) ?? 0
        trial.reward = reward
        const record = trial.normalizedRecord as { reward: number }
        record.reward = reward
        trial.normalizedRecordHash = recordDigest(record)
      }
    }
    input.reportedPromotionState = 'SEALED_REJECTED'
    input.release = null
    // The rewritten envelope is honestly re-recorded: outcome edits update the
    // record content and the envelope commitment together.
    input.evidenceCommitment = gate8EvidenceCommitment(input)
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
      trial.taskId === 'task-060' ? { ...trial, taskId: 'easy-impostor-task' } : trial,
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
        trial.taskId === 'task-000' ? { ...trial, taskId: 'substituted-task' } : trial,
      ),
    }
    const verdict = verifyGate8Evidence(input)
    expect(verdict.fullSetVerified).toBe(false)
    expect(verdict.reasons.join('\n')).toMatch(/does not match the official inventory/)
  })

  it('rejects a self-declared revealed set the committed stratum does not contain (issue #110/#111)', () => {
    const input = complete()
    // Swap two sealed ids for dev ids in the revealed list AND the trials:
    // counts, schedule indexes and the root stay valid, so the rejection can
    // come only from the committed-stratum binding.
    const forged = [...input.splitReveal!.revealedTaskIds]
    forged[0] = 'task-000'
    forged[1] = 'task-001'
    input.splitReveal = { ...input.splitReveal!, revealedTaskIds: forged }
    input.sealedTrials = input.sealedTrials.map((trial) =>
      trial.taskId === 'task-060'
        ? { ...trial, taskId: 'task-000' }
        : trial.taskId === 'task-061'
          ? { ...trial, taskId: 'task-001' }
          : trial,
    )
    const verdict = verifyGate8Evidence(input)
    expect(verdict.sealedComplete).toBe(false)
    expect(verdict.reasons.join('\n')).toMatch(
      /revealed sealed set does not match the committed sealed stratum/,
    )
    expect(verdict.reasons.join('\n')).not.toMatch(/does not match the revealed sealed task set/)
  })

  it('rejects an assignment commitSplit cannot recommit (label count violation)', () => {
    const input = complete()
    input.splitReveal = {
      ...input.splitReveal!,
      revealedAssignment: input.splitReveal!.revealedAssignment.map((row) =>
        row.taskId === 'task-060' ? { ...row, label: 'dev-guard' as const } : row,
      ),
    }
    const verdict = verifyGate8Evidence(input)
    expect(verdict.sealedComplete).toBe(false)
    expect(verdict.reasons.join('\n')).toMatch(/cannot be recommitted/)
  })

  it('rejects non-protocol ceremony sizes', () => {
    const input = complete()
    input.splitReveal = {
      ...input.splitReveal!,
      commitment: {
        ...input.splitReveal!.commitment,
        sizes: { devObserved: 0, devGuard: 0, sealed: 29 },
      },
    }
    const verdict = verifyGate8Evidence(input)
    expect(verdict.sealedComplete).toBe(false)
    expect(verdict.reasons.join('\n')).toMatch(
      /split commitment sizes\/inventory do not match the frozen protocol/,
    )
  })

  it('rejects a recomputed-root divergence with valid stratum counts (label swap)', () => {
    const input = complete()
    // Swap the labels of one sealed and one dev-guard row: sizes stay
    // 48/12/29, so commitSplit succeeds and the recomputed root legitimately
    // diverges from the revealed root.
    input.splitReveal = {
      ...input.splitReveal!,
      revealedAssignment: input.splitReveal!.revealedAssignment.map((row) => {
        if (row.taskId === 'task-060') return { ...row, label: 'dev-guard' as const }
        if (row.taskId === 'task-059') return { ...row, label: 'sealed' as const }
        return row
      }),
    }
    const verdict = verifyGate8Evidence(input)
    expect(verdict.sealedComplete).toBe(false)
    expect(verdict.reasons.join('\n')).toMatch(/not committed by the split Merkle root/)
  })

  it('rejects a full-set universe disjoint from the sealed ceremony inventory', () => {
    const input = complete()
    const otherUniverse = Array.from({ length: 89 }, (_, task) => `other-${task}`)
    input.fullSet = {
      ...input.fullSet!,
      inventoryTaskIds: otherUniverse,
      trials: input.fullSet!.trials.map((trial, index) => ({
        ...trial,
        taskId: otherUniverse[index % 89]!,
      })),
    }
    const verdict = verifyGate8Evidence(input)
    expect(verdict.reasons.join('\n')).toMatch(/different task universes/)
  })

  it('rejects a sealed record relabeled onto another candidate, even with a recomputed hash (issue #219)', () => {
    const input = complete()
    const trial = input.sealedTrials[1] as unknown as {
      normalizedRecord: { candidateId: string }
    }
    trial.normalizedRecord.candidateId = input.baselineCandidateId
    input.sealedTrials[1]!.normalizedRecordHash = recordDigest(trial.normalizedRecord)
    const verdict = verifyGate8Evidence(input)
    expect(verdict.sealedComplete).toBe(false)
    expect(verdict.reasons.join('\n')).toMatch(/trial record identity mismatch: sealed\//)
  })

  it('rejects an arbitrary blob reused as every full-set record, even fully re-hashed (issue #219)', () => {
    const input = complete()
    const blob = { lie: 'i am a real trial' }
    input.fullSet = {
      ...input.fullSet!,
      trials: input.fullSet!.trials.map((trial) => ({
        ...trial,
        normalizedRecord: blob,
        normalizedRecordHash: recordDigest(blob),
      })),
    }
    const verdict = verifyGate8Evidence(input)
    expect(verdict.fullSetVerified).toBe(false)
    expect(verdict.reasons.join('\n')).toMatch(/trial record identity mismatch: full-set\//)
  })

  it('rejects trials whose record content is absent, without throwing (issue #219)', () => {
    const input = complete()
    input.sealedTrials = input.sealedTrials.map((trial) => {
      const rest = { ...(trial as unknown as Record<string, unknown>) }
      delete rest['normalizedRecord']
      return rest as never
    })
    const verdict = verifyGate8Evidence(input)
    expect(verdict.sealedComplete).toBe(false)
    expect(verdict.reasons.join('\n')).toMatch(/trial normalized record missing: sealed\//)
  })

  it('rejects a record whose own identity lives on a prototype rather than in digested content', () => {
    const input = complete()
    const template = input.sealedTrials[1]!.normalizedRecord as Record<string, unknown>
    const { candidateId, ...rest } = template
    const ghost: Record<string, unknown> = Object.create({
      candidateId,
      ...(rest as object),
    })
    // Since the #218 canonicalizer hardening, a prototype-carried record is
    // rejected at digest computation itself; the verifier converts that into
    // a fail-closed reason instead of a throw.
    expect(() => canonicalV011(ghost)).toThrow(/non-plain-object leaf/)
    input.sealedTrials[1]!.normalizedRecord = ghost
    input.evidenceCommitment = 'sha256:' + 'f'.repeat(64)
    expect(verifyGate8Evidence(input).reasons.join('\n')).toMatch(
      /trial normalized record digest cannot be computed: sealed\//,
    )
    // A PLAIN record with a non-enumerable own identity property still
    // exercises the own-enumerable comparison directly.
    const sneaky: Record<string, unknown> = { ...rest }
    Object.defineProperty(sneaky, 'candidateId', {
      value: candidateId,
      enumerable: false,
    })
    const second = complete()
    second.sealedTrials[1]!.normalizedRecord = sneaky
    second.sealedTrials[1]!.normalizedRecordHash = recordDigest(sneaky)
    second.evidenceCommitment = gate8EvidenceCommitment(second)
    expect(verifyGate8Evidence(second).reasons.join('\n')).toMatch(
      /trial record identity mismatch: sealed\//,
    )
  })

  it('rejects a post-hoc envelope edit that diverges from the recorded commitment (issue #111)', () => {
    const input = complete()
    // A still-well-formed receipt hash swap passes every field-level check;
    // only the recorded commitment catches it.
    input.formalSearchReceiptHash = digest('other-search-complete')
    const verdict = verifyGate8Evidence(input)
    expect(verdict.sealedComplete).toBe(false)
    expect(verdict.reasons.join('\n')).toMatch(
      /evidence envelope does not match its recorded commitment/,
    )
  })

  it('rejects a signature flag flipped after recording, even with a re-recorded commitment elsewhere (issue #111)', () => {
    const input = complete()
    input.lockedCandidate = { ...input.lockedCandidate!, signatureVerified: false }
    const verdict = verifyGate8Evidence(input)
    expect(verdict.reasons.join('\n')).toMatch(
      /signed immutable candidate lock is missing or invalid/,
    )
    expect(verdict.reasons.join('\n')).toMatch(/does not match its recorded commitment/)
  })

  it('rejects a record whose reward disagrees with the analyzed row reward, even fully re-forged (issue #111)', () => {
    const input = complete()
    const trial = input.sealedTrials[1] as unknown as {
      normalizedRecord: { reward: number }
    }
    trial.normalizedRecord.reward = 0
    input.sealedTrials[1]!.normalizedRecordHash = recordDigest(trial.normalizedRecord)
    input.evidenceCommitment = gate8EvidenceCommitment(input)
    const verdict = verifyGate8Evidence(input)
    expect(verdict.sealedComplete).toBe(false)
    expect(verdict.reasons.join('\n')).toMatch(/trial record outcome mismatch: sealed\//)
  })

  it('rejects a full-set record naming a different capsule than the row, fully re-forged (issue #111)', () => {
    const input = complete()
    input.fullSet = {
      ...input.fullSet!,
      trials: input.fullSet!.trials.map((trial) => {
        const record = trial.normalizedRecord as { capsuleDigest: string }
        record.capsuleDigest = digest('other-capsule')
        return {
          ...trial,
          normalizedRecordHash: recordDigest(record),
        }
      }),
    }
    input.evidenceCommitment = gate8EvidenceCommitment(input)
    const verdict = verifyGate8Evidence(input)
    expect(verdict.fullSetVerified).toBe(false)
    expect(verdict.reasons.join('\n')).toMatch(/trial record outcome mismatch: full-set\//)
  })

  it('rejects fractional attempt indexes on both row and record (issue #111)', () => {
    const input = complete()
    const trial = input.sealedTrials[1] as unknown as {
      attemptIndex: number
      normalizedRecord: { attemptIndex: number }
    }
    trial.attemptIndex = 1.5
    trial.normalizedRecord.attemptIndex = 1.5
    input.sealedTrials[1]!.normalizedRecordHash = recordDigest(trial.normalizedRecord)
    input.evidenceCommitment = gate8EvidenceCommitment(input)
    const verdict = verifyGate8Evidence(input)
    expect(verdict.sealedComplete).toBe(false)
    expect(verdict.reasons.join('\n')).toMatch(/sealed trial identity\/artifact invalid/)
  })

  it('returns a verdict, never throws, on circular or bigint record content (issue #217)', () => {
    const circular = complete()
    const record: Record<string, unknown> = {
      candidateId: circular.sealedTrials[1]!.candidateId,
      taskId: circular.sealedTrials[1]!.taskId,
      attemptIndex: 0,
      reward: 1,
    }
    record['self'] = record
    circular.sealedTrials[1]!.normalizedRecord = record
    circular.evidenceCommitment = 'sha256:' + 'a'.repeat(64)
    const circularVerdict = verifyGate8Evidence(circular)
    expect(circularVerdict.sealedComplete).toBe(false)
    expect(circularVerdict.reasons.join('\n')).toMatch(
      /digest cannot be computed|commitment cannot be computed/,
    )

    const big = complete()
    big.sealedTrials[1]!.normalizedRecord = {
      candidateId: big.sealedTrials[1]!.candidateId,
      taskId: big.sealedTrials[1]!.taskId,
      attemptIndex: 0,
      reward: 1n,
    }
    big.evidenceCommitment = 'sha256:' + 'a'.repeat(64)
    const bigVerdict = verifyGate8Evidence(big)
    expect(bigVerdict.sealedComplete).toBe(false)
    expect(bigVerdict.reasons.join('\n')).toMatch(
      /digest cannot be computed|commitment cannot be computed/,
    )
  })

  it('rejects missing sub-objects and array envelopes with verdicts, not TypeErrors (issue #217)', () => {
    for (const key of [
      'lockedCandidate',
      'splitReveal',
      'sealedPlan',
      'fullSet',
      'release',
    ] as const) {
      const input = complete()
      ;(input as unknown as Record<string, unknown>)[key] = undefined
      input.evidenceCommitment = 'sha256:' + 'c'.repeat(64)
      expect(() => verifyGate8Evidence(input)).not.toThrow()
      expect(verifyGate8Evidence(input).sealedComplete).toBe(false)
    }
    const arrayEnvelope = [] as unknown as ReturnType<typeof complete>
    expect(() => verifyGate8Evidence(arrayEnvelope)).not.toThrow()
    expect(verifyGate8Evidence(arrayEnvelope).reasons.join('\n')).toMatch(
      /evidence envelope is not an object/,
    )
  })

  it('rejects null rawEvidenceDigests, a null bootstrapSeed, null revealed ids, and non-array inventories (issue #217)', () => {
    const noDigests = complete()
    ;(noDigests.sealedTrials[1] as unknown as Record<string, unknown>)['rawEvidenceDigests'] = null
    noDigests.evidenceCommitment = 'sha256:' + 'd'.repeat(64)
    expect(() => verifyGate8Evidence(noDigests)).not.toThrow()
    expect(verifyGate8Evidence(noDigests).reasons.join('\n')).toMatch(
      /sealed trial identity\/artifact invalid/,
    )

    const nullSeed = complete()
    nullSeed.sealedPlan.bootstrapSeed = null as unknown as bigint
    nullSeed.evidenceCommitment = 'sha256:' + 'd'.repeat(64)
    expect(() => verifyGate8Evidence(nullSeed)).not.toThrow()
    expect(verifyGate8Evidence(nullSeed).reasons.join('\n')).toMatch(
      /sealed analysis\/schedule plan is missing, mutable, or underpowered/,
    )

    const nullRevealed = complete()
    nullRevealed.splitReveal.revealedTaskIds = [null as unknown as string]
    nullRevealed.evidenceCommitment = 'sha256:' + 'd'.repeat(64)
    expect(() => verifyGate8Evidence(nullRevealed)).not.toThrow()

    const noInventory = complete()
    ;(noInventory.splitReveal as unknown as Record<string, unknown>)['inventoryTaskIds'] = undefined
    noInventory.evidenceCommitment = 'sha256:' + 'd'.repeat(64)
    expect(() => verifyGate8Evidence(noInventory)).not.toThrow()

    const numericFullInventory = complete()
    numericFullInventory.fullSet.inventoryTaskIds = 5 as unknown as string[]
    numericFullInventory.evidenceCommitment = 'sha256:' + 'd'.repeat(64)
    expect(() => verifyGate8Evidence(numericFullInventory)).not.toThrow()
    expect(verifyGate8Evidence(numericFullInventory).reasons.join('\n')).toMatch(
      /official inventory list is missing or malformed/,
    )
  })

  it('rejects null trial matrices with reasons, not TypeErrors (issue #217)', () => {
    const nullSealed = complete()
    ;(nullSealed as unknown as Record<string, unknown>)['sealedTrials'] = null
    nullSealed.evidenceCommitment = 'sha256:' + 'b'.repeat(64)
    expect(() => verifyGate8Evidence(nullSealed)).not.toThrow()
    expect(verifyGate8Evidence(nullSealed).reasons.join('\n')).toMatch(
      /sealed trial matrix is missing or malformed/,
    )

    const nullFull = complete()
    ;(nullFull.fullSet as unknown as Record<string, unknown>)['trials'] = null
    nullFull.evidenceCommitment = 'sha256:' + 'b'.repeat(64)
    expect(() => verifyGate8Evidence(nullFull)).not.toThrow()
    expect(verifyGate8Evidence(nullFull).reasons.join('\n')).toMatch(
      /full-set trial matrix is missing or malformed/,
    )
  })
})
