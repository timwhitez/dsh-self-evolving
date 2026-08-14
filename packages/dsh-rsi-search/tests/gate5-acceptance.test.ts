/** Gate 5 acceptance verifier and current-artifact quarantine. */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  verifyGate5Acceptance,
  type Gate5AcceptanceInput,
  type Gate5TrialEvidence,
} from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const evidenceDir = join(here, '..', '..', '..', 'evidence')

function trial(
  candidateId: string,
  taskId: string,
  attemptIndex: number,
  stratum = 'core/easy',
): Gate5TrialEvidence {
  return {
    candidateId,
    taskId,
    attemptIndex,
    stratum,
    capabilityMode: 'real',
    normalizedRecordHash: `sha256:${'a'.repeat(64)}`,
    costUsd: 0.01,
    priced: true,
    wallSec: 30,
  }
}

function completeInput(): Gate5AcceptanceInput {
  const developmentTaskIds = Array.from({ length: 60 }, (_, index) => `task-${index}`)
  const baselineTrials = developmentTaskIds.flatMap((taskId) => [
    trial('baseline', taskId, 0),
    trial('baseline', taskId, 1),
  ])
  const requiredStrata = ['short', 'network-resource', 'long']
  const calibrationTrials = ['candidate-a', 'candidate-b', 'candidate-c'].flatMap((candidateId) =>
    requiredStrata.map((stratum, index) =>
      trial(candidateId, `calibration-${stratum}`, index, stratum),
    ),
  )
  return {
    baselineCandidateId: 'baseline',
    developmentTaskIds,
    requiredAttempts: 2,
    requiredStrata,
    baselineTrials,
    calibrationTrials,
    requiredCalibrationCandidates: 3,
    splitCeremony: {
      workerReceiptHash: `sha256:${'b'.repeat(64)}`,
      controllerViewHash: `sha256:${'c'.repeat(64)}`,
      privateStoreIdentityHash: `sha256:${'d'.repeat(64)}`,
      merkleRoot: `sha256:${'f'.repeat(64)}`,
      principalSeparated: true,
      assignmentExposedToController: false,
      difficultyDimension: 'OMITTED',
      observedCount: 48,
      guardCount: 12,
      sealedCount: 29,
    },
    informationFlowFixtures: {
      selectorSealedAbort: true,
      proposerSealedAbort: true,
      canaryAbort: true,
    },
    candidateLockFixture: {
      receiptHash: `sha256:${'e'.repeat(64)}`,
      splitMerkleRoot: `sha256:${'f'.repeat(64)}`,
      proposerRefused: true,
      selectorRefused: true,
      mismatchRelockRefused: true,
    },
    sealedAccessCount: 0,
    budgetModel: {
      feasible: true,
      reserveFraction: 0.2,
      predictedP90CostUsd: 100,
      predictedP90WallSec: 8 * 3600,
    },
  }
}

describe('Gate 5 fail-closed acceptance', () => {
  it('accepts only a complete 60x2 real baseline plus 3-candidate stratum calibration', () => {
    const verdict = verifyGate5Acceptance(completeInput())
    expect(verdict.accepted, verdict.reasons.join('\n')).toBe(true)
    expect(verdict.expectedBaselineTrials).toBe(120)
    expect(verdict.observedBaselineTrials).toBe(120)
  })

  it('rejects nop/stub evidence, incomplete matrices, public split assignment, and unpriced use', () => {
    const input = completeInput()
    input.baselineTrials = [
      {
        ...input.baselineTrials[0]!,
        capabilityMode: 'nop',
        priced: false,
        costUsd: 0,
        normalizedRecordHash: null,
      },
    ]
    input.splitCeremony.assignmentExposedToController = true
    const verdict = verifyGate5Acceptance(input)
    expect(verdict.accepted).toBe(false)
    expect(verdict.reasons.join('\n')).toMatch(/incomplete/)
    expect(verdict.reasons.join('\n')).toMatch(/real\/priced\/normalized/)
    expect(verdict.reasons.join('\n')).toMatch(/split assignment/)
  })

  it('requires separate-principal ceremony and fail-closed lock/info-flow receipts', () => {
    const input = completeInput()
    input.splitCeremony.principalSeparated = false
    input.informationFlowFixtures.canaryAbort = false
    input.candidateLockFixture.proposerRefused = false
    const verdict = verifyGate5Acceptance(input)
    expect(verdict.accepted).toBe(false)
    expect(verdict.reasons.join('\n')).toMatch(/principal is not separated/)
    expect(verdict.reasons.join('\n')).toMatch(/canaryAbort/)
    expect(verdict.reasons.join('\n')).toMatch(/candidate lock fixture/)
  })

  it('does not let the caller weaken fixed calibration and budget gates', () => {
    const input = completeInput()
    input.requiredCalibrationCandidates = 0
    input.requiredStrata = []
    input.budgetModel!.predictedP90CostUsd = Number.NaN
    input.budgetModel!.predictedP90WallSec = 0
    const verdict = verifyGate5Acceptance(input)
    expect(verdict.accepted).toBe(false)
    expect(verdict.reasons.join('\n')).toMatch(/at least 3 candidates/)
    expect(verdict.reasons.join('\n')).toMatch(/at least 3 unique declared strata/)
    expect(verdict.reasons.join('\n')).toMatch(/cost is invalid/)
    expect(verdict.reasons.join('\n')).toMatch(/wall time is invalid/)
  })

  it('marks the existing calibration and pilot artifacts as quarantined, not accepted', async () => {
    for (const scope of ['calibration', 'pilot']) {
      const status = JSON.parse(
        await readFile(join(evidenceDir, scope, 'STATUS.json'), 'utf8'),
      ) as { status: string; artifactsPreserved: boolean }
      expect(status.status).toBe('QUARANTINED_NOT_ACCEPTED')
      expect(status.artifactsPreserved).toBe(true)
    }
  })
})
