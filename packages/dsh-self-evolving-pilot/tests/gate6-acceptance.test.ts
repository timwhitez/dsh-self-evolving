import { describe, expect, it } from 'vitest'
import {
  gate6EvidenceCommitment,
  verifyGate6Acceptance,
  type Gate6AcceptanceInput,
} from '../src/index.js'
import { canonicalV011, digestV011 } from '@dsh-self-evolving/candidate-sdk' 

const hash = (character: string) => `sha256:${character.repeat(64)}`

/** Canonical Candidate SDK identity: c_ + 26 lowercase base32 characters. */
const candidateId = (index: number) =>
  `c_${'abcdefghijklmnopqrstuvwxyz234567'[index % 32]!}${'abcdefghijklmnopqrstuvwxyz'[index % 26]!.repeat(25)}`

function complete(): Gate6AcceptanceInput {
  const candidates = Array.from({ length: 10 }, (_, index) => ({
    candidateId: candidateId(index),
    sourceDigest: hash(index.toString(16)),
    capsuleDigest: hash(((index + 1) % 16).toString(16)),
    buildManifestDigest: hash(((index + 2) % 16).toString(16)),
  }))
  const input = {
    runId: 'pilot-successor-20260814',
    targetK: 10,
    capabilityMode: 'real',
    candidates,
    observations: candidates.map((candidate, index) => {
      const normalizedRecord = {
        schemaVersion: 1,
        candidateId: candidate.candidateId,
        taskId: `dev-task-${index}`,
        attemptIndex: 0,
        status: 'pass',
        reward: 1,
      }
      return {
        candidateId: candidate.candidateId,
        taskId: `dev-task-${index}`,
        attemptIndex: 0,
        normalizedRecordHash: digestV011(canonicalV011(normalizedRecord)),
        rawEvidenceDigests: [hash('e')],
        costUsd: 0.02,
        normalizedRecord,
      }
    }),
    allActionsTerminalAndReconciled: true,
    journalReplayMatches: true,
    realCrashResumeReceipt: true,
    fixtures: { buildReject: true, runtimeFail: true, infraRetry: true, duplicateChild: true },
    proposerRawEvidenceReferences: 1,
    auditCriticalFindings: 0,
    costPredictionErrorFraction: 0.1,
    sealedAccessCount: 0,
  } as unknown as Gate6AcceptanceInput
  input.evidenceCommitment = gate6EvidenceCommitment(input)
  return input
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

  it('rejects digest-shaped candidate IDs that are not SDK-issued identities', () => {
    const input = complete()
    // A sha256 source digest relabeled as the candidate ID must fail: the
    // canonical identity is c_<base32>, never a digest (issue #77).
    const remap = new Map(input.candidates.map((row) => [row.candidateId, row.sourceDigest]))
    input.candidates = input.candidates.map((candidate) => ({
      ...candidate,
      candidateId: candidate.sourceDigest,
    }))
    input.observations = input.observations.map((observation) => ({
      ...observation,
      candidateId: remap.get(observation.candidateId)!,
    }))
    const verdict = verifyGate6Acceptance(input)
    expect(verdict.accepted).toBe(false)
    expect(verdict.reasons.join('\n')).toMatch(/lacks full immutable identity/)
  })

describe('Gate6 evidence binding (issue #121)', () => {
  it('rejects a post-hoc evidence edit that diverges from the commitment', () => {
    const input = complete()
    input.realCrashResumeReceipt = false
    const verdict = verifyGate6Acceptance(input)
    expect(verdict.accepted).toBe(false)
    expect(verdict.reasons).toContain('evidence envelope does not match its recorded commitment')
    expect(verdict.reasons.join('\n')).toMatch(/crash\/resume/)
  })

  it('rejects an observation whose record content does not hash to its claim', () => {
    const input = complete()
    const observation = input.observations[0] as unknown as {
      normalizedRecord: { reward: number }
    }
    observation.normalizedRecord.reward = 0
    const verdict = verifyGate6Acceptance(input)
    expect(verdict.accepted).toBe(false)
    expect(verdict.reasons.join('\n')).toMatch(/normalized record digest mismatch/)
  })

  it('rejects a record relabeled onto another observation, even with a recomputed hash and commitment', () => {
    const input = complete()
    const observation = input.observations[0] as unknown as {
      normalizedRecord: { candidateId: string }
    }
    observation.normalizedRecord.candidateId = candidateId(9)
    // Re-forging both the per-record hash and the envelope commitment must
    // not rescue a misattributed record.
    input.observations[0]!.normalizedRecordHash = digestV011(
      canonicalV011(observation.normalizedRecord),
    )
    input.evidenceCommitment = gate6EvidenceCommitment(input)
    const verdict = verifyGate6Acceptance(input)
    expect(verdict.accepted).toBe(false)
    expect(verdict.reasons.join('\n')).toMatch(/record identity mismatch/)
  })

  it('rejects an arbitrary blob reused as every record, even fully re-hashed', () => {
    const input = complete()
    const blob = { lie: 'i am a real trial' }
    input.observations = input.observations.map((observation) => {
      const row = observation as unknown as Record<string, unknown>
      row['normalizedRecord'] = blob
      row['normalizedRecordHash'] = digestV011(canonicalV011(blob))
      return observation
    })
    input.evidenceCommitment = gate6EvidenceCommitment(input)
    const verdict = verifyGate6Acceptance(input)
    expect(verdict.accepted).toBe(false)
    expect(verdict.reasons.join('\n')).toMatch(/record identity mismatch/)
  })

  it('rejects observations presented without record content', () => {
    const input = complete()
    input.observations = input.observations.map((observation) => {
      const rest = { ...(observation as unknown as Record<string, unknown>) }
      delete rest['normalizedRecord']
      return rest as never
    })
    const verdict = verifyGate6Acceptance(input)
    expect(verdict.reasons.join('\n')).toMatch(/normalized record missing/)
  })
})

})

describe('Gate6 malformed-envelope fail-closed (issue #217)', () => {
  it('returns a verdict, never throws, on a circular record', () => {
    const input = complete()
    const record: Record<string, unknown> = {
      candidateId: input.observations[0]!.candidateId,
      taskId: input.observations[0]!.taskId,
      attemptIndex: 0,
      reward: 1,
    }
    record['self'] = record
    input.observations[0]!.normalizedRecord = record
    input.evidenceCommitment = 'sha256:' + 'a'.repeat(64)
    const verdict = verifyGate6Acceptance(input)
    expect(verdict.accepted).toBe(false)
    expect(verdict.reasons.join('\n')).toMatch(/digest cannot be computed|commitment cannot be computed/)
  })

  it('rejects a bigint-bearing record without throwing', () => {
    const input = complete()
    input.observations[0]!.normalizedRecord = {
      candidateId: input.observations[0]!.candidateId,
      taskId: input.observations[0]!.taskId,
      attemptIndex: 0,
      reward: 1n,
    }
    input.evidenceCommitment = 'sha256:' + 'a'.repeat(64)
    const verdict = verifyGate6Acceptance(input)
    expect(verdict.accepted).toBe(false)
    expect(verdict.reasons.join('\n')).toMatch(/digest cannot be computed|commitment cannot be computed/)
  })

  it('rejects null/malformed matrices and fixtures with reasons, not TypeErrors', () => {
    const nullCandidates = complete()
    ;(nullCandidates as unknown as Record<string, unknown>)['candidates'] = null
    expect(() => verifyGate6Acceptance(nullCandidates)).not.toThrow()
    expect(verifyGate6Acceptance(nullCandidates).reasons.join('\n')).toMatch(/candidate matrix is missing or malformed/)

    const nullObservations = complete()
    ;(nullObservations as unknown as Record<string, unknown>)['observations'] = null
    expect(verifyGate6Acceptance(nullObservations).reasons.join('\n')).toMatch(
      /observation matrix is missing or malformed/,
    )

    const nullFixtures = complete()
    ;(nullFixtures as unknown as Record<string, unknown>)['fixtures'] = null
    expect(verifyGate6Acceptance(nullFixtures).reasons.join('\n')).toMatch(
      /required failure fixtures are missing or malformed/,
    )
  })

  it('rejects an empty or partial fixture object instead of sailing through the entries loop', () => {
    const emptyFixtures = complete()
    ;(emptyFixtures as unknown as Record<string, unknown>)['fixtures'] = {}
    emptyFixtures.evidenceCommitment = gate6EvidenceCommitment(emptyFixtures)
    const verdict = verifyGate6Acceptance(emptyFixtures)
    expect(verdict.accepted).toBe(false)
    expect(verdict.reasons.join('\n')).toMatch(/required failure fixture not covered: buildReject/)
  })

  it('rejects a record whose identity lives on a prototype (own-enumerable semantics)', () => {
    const input = complete()
    const template = input.observations[0]!.normalizedRecord as Record<string, unknown>
    const { candidateId, ...rest } = template
    const ghost: Record<string, unknown> = Object.create({
      candidateId,
      ...(rest as object),
    })
    input.observations[0]!.normalizedRecord = ghost
    input.observations[0]!.normalizedRecordHash = digestV011(canonicalV011(ghost))
    input.evidenceCommitment = gate6EvidenceCommitment(input)
    expect(verifyGate6Acceptance(input).reasons.join('\n')).toMatch(
      /record identity mismatch/,
    )
  })
})
