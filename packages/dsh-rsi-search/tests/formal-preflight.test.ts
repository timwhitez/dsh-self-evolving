import { generateKeyPairSync, sign } from 'node:crypto'
import { canonicalJson } from '@dsh-rsi/core'
import { describe, expect, it } from 'vitest'
import {
  formalSignerKeyId,
  verifyFormalPreflight,
  type FormalPreflightEvidence,
  type FormalRunManifest,
} from '../src/index.js'

const hash = (character: string) => `sha256:${character.repeat(64)}`
const commit = 'a'.repeat(40)

function manifest(signatureKeyId: string): FormalRunManifest {
  const route = {
    provider: 'deepseek',
    endpointHash: hash('1'),
    model: 'deepseek-v4-flash-free',
    reasoningEffort: 'high',
    contextWindowTokens: 200_000,
    requestDefaultsHash: hash('2'),
  }
  return {
    schemaVersion: 1,
    runId: 'formal-self-successor-001',
    track: 'self',
    targetK: 80,
    createdAt: '2026-08-14T05:00:00.000Z',
    signatureKeyId,
    code: {
      commit,
      tag: 'formal-self-successor-001-preflight',
      treeDigest: hash('3'),
      provenanceDigest: hash('4'),
    },
    solverRoute: route,
    proposerRoute: { ...route },
    benchmark: {
      registry: 'terminal-bench/terminal-bench-2-1',
      datasetDigest: 'sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a',
      sourceCommit: 'b'.repeat(40),
      orderedInventoryHash: hash('5'),
      taskCount: 89,
    },
    protocol: {
      protocolHash: hash('6'),
      evaluatorHash: hash('7'),
      statisticsHash: hash('8'),
      controllerHash: hash('9'),
      candidateSdkHash: hash('a'),
      sealedServiceHash: hash('b'),
    },
    split: { commitmentHash: hash('c'), merkleRoot: hash('d') },
    search: { parametersHash: hash('e'), masterSeedCommitment: hash('f') },
    budget: {
      maxCostUsd: 500,
      maxWallSec: 16 * 3600,
      reserveFraction: 0.2,
      includesSealedPairedBudget: true,
    },
    leaderboard: {
      snapshotHash: hash('0'),
      sourceUrl: 'https://example.test/immutable-snapshot',
      capturedAt: '2026-08-14T04:00:00.000Z',
      targetRowHash: hash('1'),
    },
  }
}

function evidence(signatureBase64: string, publicKeyPem: string): FormalPreflightEvidence {
  return {
    detachedSignatureBase64: signatureBase64,
    trustedSignerPublicKeyPem: publicKeyPem,
    git: {
      headCommit: commit,
      tagPointsAtHead: 'formal-self-successor-001-preflight',
      clean: true,
      noUnreviewedSourceOrConfig: true,
    },
    prerequisiteGateReceipts: { gate4: hash('4'), gate5: hash('5'), gate6: hash('6') },
    baseline: {
      receiptHash: hash('7'),
      exactManifestIdentity: true,
      developmentTaskCount: 60,
      minimumAttemptsPerTask: 2,
      capabilityMode: 'real',
    },
    providerRouteSmokeReceiptHash: hash('8'),
    split: {
      principalSeparated: true,
      assignmentExposedToController: false,
      sealedAccessCount: 0,
    },
    budgetReservationReceiptHash: hash('9'),
    runDirectoryFresh: true,
    operatorProcedures: {
      stopTested: true,
      incidentTested: true,
      secretRotationTested: true,
      backupRestoreTested: true,
    },
    statisticsProtocolPublished: true,
  }
}

function signedFixture(): {
  runManifest: FormalRunManifest
  preflight: FormalPreflightEvidence
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const runManifest = manifest(formalSignerKeyId(publicKeyPem))
  const signature = sign(null, Buffer.from(canonicalJson(runManifest)), privateKey).toString(
    'base64',
  )
  return { runManifest, preflight: evidence(signature, publicKeyPem) }
}

describe('Gate 7 formal preflight', () => {
  it('accepts a fully signed, identity-bound, prerequisite-complete self-track envelope', () => {
    const fixture = signedFixture()
    const verdict = verifyFormalPreflight(fixture.runManifest, fixture.preflight)
    expect(verdict.accepted, verdict.reasons.join('\n')).toBe(true)
    expect(verdict.status).toBe('PREFLIGHT_ACCEPTED')
    expect(verdict.manifestHash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('rejects a manifest changed after signing', () => {
    const fixture = signedFixture()
    fixture.runManifest.targetK = 79
    const verdict = verifyFormalPreflight(fixture.runManifest, fixture.preflight)
    expect(verdict.accepted).toBe(false)
    expect(verdict.reasons.join('\n')).toMatch(/signature is invalid/)
    expect(verdict.reasons.join('\n')).toMatch(/target K must equal 80/)
  })

  it('blocks the current missing-gate/tag/baseline/provider/budget/procedure state', () => {
    const fixture = signedFixture()
    fixture.preflight.git.tagPointsAtHead = ''
    fixture.preflight.git.clean = false
    fixture.preflight.prerequisiteGateReceipts = { gate4: null, gate5: null, gate6: null }
    fixture.preflight.baseline.receiptHash = null
    fixture.preflight.baseline.capabilityMode = 'nop'
    fixture.preflight.providerRouteSmokeReceiptHash = null
    fixture.preflight.budgetReservationReceiptHash = null
    fixture.preflight.operatorProcedures.backupRestoreTested = false
    fixture.preflight.statisticsProtocolPublished = false
    const verdict = verifyFormalPreflight(fixture.runManifest, fixture.preflight)
    expect(verdict.status).toBe('PREFLIGHT_BLOCKED')
    expect(verdict.reasons.join('\n')).toMatch(/gate4 acceptance receipt missing/)
    expect(verdict.reasons.join('\n')).toMatch(/real 60-task baseline is missing/)
    expect(verdict.reasons.join('\n')).toMatch(/provider route smoke receipt missing/)
    expect(verdict.reasons.join('\n')).toMatch(/budget reservation receipt missing/)
    expect(verdict.reasons.join('\n')).toMatch(/backupRestoreTested/)
  })
})
