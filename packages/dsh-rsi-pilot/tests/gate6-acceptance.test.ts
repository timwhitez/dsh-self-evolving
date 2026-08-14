import { describe, expect, it } from 'vitest'
import { verifyGate6Acceptance, type Gate6AcceptanceInput } from '../src/index.js'

const hash = (character: string) => `sha256:${character.repeat(64)}`

function complete(): Gate6AcceptanceInput {
  const candidates = Array.from({ length: 10 }, (_, index) => ({
    candidateId: hash(index.toString(16)),
    sourceDigest: hash(index.toString(16)),
    capsuleDigest: hash(((index + 1) % 16).toString(16)),
    buildManifestDigest: hash(((index + 2) % 16).toString(16)),
  }))
  return {
    runId: 'pilot-successor-20260814',
    targetK: 10,
    capabilityMode: 'real',
    candidates,
    observations: candidates.map((candidate, index) => ({
      candidateId: candidate.candidateId,
      taskId: `dev-task-${index}`,
      attemptIndex: 0,
      normalizedRecordHash: hash('d'),
      rawEvidenceDigests: [hash('e')],
      costUsd: 0.02,
    })),
    allActionsTerminalAndReconciled: true,
    journalReplayMatches: true,
    realCrashResumeReceipt: true,
    fixtures: { buildReject: true, runtimeFail: true, infraRetry: true, duplicateChild: true },
    proposerRawEvidenceReferences: 1,
    auditCriticalFindings: 0,
    costPredictionErrorFraction: 0.1,
    sealedAccessCount: 0,
  }
}

describe('Gate 6 fail-closed acceptance', () => {
  it('accepts a complete real K=10 pilot evidence envelope', () => {
    const verdict = verifyGate6Acceptance(complete())
    expect(verdict.accepted, verdict.reasons.join('\n')).toBe(true)
  })

  it('rejects the defining properties of the historical stub pilot', () => {
    const input = complete()
    input.runId = 'pilot-001'
    input.capabilityMode = 'stub'
    input.candidates = input.candidates.map((candidate) => ({
      ...candidate,
      sourceDigest: candidate.candidateId,
    }))
    input.realCrashResumeReceipt = false
    input.proposerRawEvidenceReferences = 0
    input.costPredictionErrorFraction = null
    const verdict = verifyGate6Acceptance(input)
    expect(verdict.accepted).toBe(false)
    expect(verdict.reasons.join('\n')).toMatch(/not real/)
    expect(verdict.reasons.join('\n')).toMatch(/crash\/resume/)
    expect(verdict.reasons.join('\n')).toMatch(/cost prediction/)
  })

  it('rejects candidates without observations, raw refs, or unique source identity', () => {
    const input = complete()
    input.observations = input.observations.slice(1)
    input.observations[0]!.rawEvidenceDigests = []
    input.candidates[1]!.sourceDigest = input.candidates[0]!.sourceDigest
    const verdict = verifyGate6Acceptance(input)
    expect(verdict.accepted).toBe(false)
    expect(verdict.reasons.join('\n')).toMatch(/no attributable observation/)
    expect(verdict.reasons.join('\n')).toMatch(/cost\/raw evidence invalid/)
    expect(verdict.reasons.join('\n')).toMatch(/unique source digests/)
  })
})
