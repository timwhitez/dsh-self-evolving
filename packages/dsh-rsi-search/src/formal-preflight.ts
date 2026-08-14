import { createHash, createPublicKey, verify } from 'node:crypto'
import { canonicalJson } from '@dsh-rsi/core'

const sha256Pattern = /^sha256:[0-9a-f]{64}$/
const gitCommitPattern = /^[0-9a-f]{40}$/
const EXPECTED_DATASET_DIGEST =
  'sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a'

export interface FormalRunManifest {
  schemaVersion: 1
  runId: string
  track: 'self' | 'sota'
  targetK: number
  createdAt: string
  signatureKeyId: string
  code: {
    commit: string
    tag: string
    treeDigest: string
    provenanceDigest: string
  }
  solverRoute: {
    provider: string
    endpointHash: string
    model: string
    effectiveModel: string
    reasoningEffort: string
    contextWindowTokens: number
    requestDefaultsHash: string
  }
  proposerRoute: {
    provider: string
    endpointHash: string
    model: string
    effectiveModel: string
    reasoningEffort: string
    contextWindowTokens: number
    requestDefaultsHash: string
  }
  benchmark: {
    registry: string
    datasetDigest: string
    sourceCommit: string
    orderedInventoryHash: string
    taskCount: number
  }
  protocol: {
    protocolHash: string
    evaluatorHash: string
    statisticsHash: string
    controllerHash: string
    candidateSdkHash: string
    sealedServiceHash: string
  }
  split: {
    commitmentHash: string
    merkleRoot: string
  }
  search: {
    parametersHash: string
    masterSeedCommitment: string
  }
  budget: {
    maxCostUsd: number
    maxWallSec: number
    reserveFraction: number
    includesSealedPairedBudget: boolean
  }
  leaderboard: {
    snapshotHash: string
    sourceUrl: string
    capturedAt: string
    targetRowHash: string
  }
}

export interface FormalPreflightEvidence {
  detachedSignatureBase64: string
  trustedSignerPublicKeyPem: string
  git: {
    headCommit: string
    tagPointsAtHead: string
    clean: boolean
    noUnreviewedSourceOrConfig: boolean
  }
  prerequisiteGateReceipts: {
    gate4: string | null
    gate5: string | null
    gate6: string | null
  }
  baseline: {
    receiptHash: string | null
    exactManifestIdentity: boolean
    developmentTaskCount: number
    minimumAttemptsPerTask: number
    capabilityMode: 'real' | 'stub' | 'nop'
  }
  providerRouteSmokeReceiptHash: string | null
  split: {
    principalSeparated: boolean
    assignmentExposedToController: boolean
    sealedAccessCount: number
  }
  budgetReservationReceiptHash: string | null
  runDirectoryFresh: boolean
  operatorProcedures: {
    stopTested: boolean
    incidentTested: boolean
    secretRotationTested: boolean
    backupRestoreTested: boolean
  }
  statisticsProtocolPublished: boolean
}

export interface FormalPreflightVerdict {
  accepted: boolean
  status: 'PREFLIGHT_ACCEPTED' | 'PREFLIGHT_BLOCKED'
  reasons: string[]
  manifestHash: string
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function validHash(value: string | null): value is string {
  return value !== null && sha256Pattern.test(value)
}

function publicKeyId(publicKeyPem: string): string {
  const key = createPublicKey(publicKeyPem)
  return sha256(key.export({ type: 'spki', format: 'der' }))
}

function routeIdentity(route: FormalRunManifest['solverRoute']): string {
  return canonicalJson(route)
}

export function verifyFormalPreflight(
  manifest: FormalRunManifest,
  evidence: FormalPreflightEvidence,
): FormalPreflightVerdict {
  const reasons: string[] = []
  const manifestBytes = canonicalJson(manifest)
  const manifestHash = sha256(manifestBytes)
  if (manifest.schemaVersion !== 1) reasons.push('unsupported formal manifest schema')
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(manifest.runId)) {
    reasons.push('formal run id missing or unsafe')
  }
  if (manifest.track !== 'self') reasons.push('first formal run must use self track')
  if (manifest.targetK !== 80)
    reasons.push(`formal target K must equal 80; got ${manifest.targetK}`)
  if (!Number.isFinite(Date.parse(manifest.createdAt)))
    reasons.push('manifest createdAt is invalid')

  try {
    if (publicKeyId(evidence.trustedSignerPublicKeyPem) !== manifest.signatureKeyId) {
      reasons.push('manifest signer key id does not match trusted key')
    } else {
      const signature = Buffer.from(evidence.detachedSignatureBase64, 'base64')
      if (
        signature.length === 0 ||
        !verify(null, Buffer.from(manifestBytes), evidence.trustedSignerPublicKeyPem, signature)
      ) {
        reasons.push('manifest detached signature is invalid')
      }
    }
  } catch {
    reasons.push('manifest signer/signature cannot be parsed')
  }

  if (!gitCommitPattern.test(manifest.code.commit)) reasons.push('manifest code commit is invalid')
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(manifest.code.tag)) {
    reasons.push('manifest Git tag is missing or unsafe')
  }
  for (const [field, value] of Object.entries({
    treeDigest: manifest.code.treeDigest,
    provenanceDigest: manifest.code.provenanceDigest,
    endpointHash: manifest.solverRoute.endpointHash,
    solverDefaults: manifest.solverRoute.requestDefaultsHash,
    proposerEndpointHash: manifest.proposerRoute.endpointHash,
    proposerDefaults: manifest.proposerRoute.requestDefaultsHash,
    orderedInventoryHash: manifest.benchmark.orderedInventoryHash,
    protocolHash: manifest.protocol.protocolHash,
    evaluatorHash: manifest.protocol.evaluatorHash,
    statisticsHash: manifest.protocol.statisticsHash,
    controllerHash: manifest.protocol.controllerHash,
    candidateSdkHash: manifest.protocol.candidateSdkHash,
    sealedServiceHash: manifest.protocol.sealedServiceHash,
    splitCommitmentHash: manifest.split.commitmentHash,
    splitMerkleRoot: manifest.split.merkleRoot,
    searchParametersHash: manifest.search.parametersHash,
    masterSeedCommitment: manifest.search.masterSeedCommitment,
    leaderboardSnapshotHash: manifest.leaderboard.snapshotHash,
    leaderboardTargetRowHash: manifest.leaderboard.targetRowHash,
  })) {
    if (!sha256Pattern.test(value)) reasons.push(`manifest identity invalid: ${field}`)
  }
  if (
    manifest.benchmark.registry !== 'terminal-bench/terminal-bench-2-1' ||
    manifest.benchmark.datasetDigest !== EXPECTED_DATASET_DIGEST ||
    !gitCommitPattern.test(manifest.benchmark.sourceCommit) ||
    manifest.benchmark.taskCount !== 89
  ) {
    reasons.push('frozen Terminal-Bench 2.1 identity is incomplete or mismatched')
  }
  if (
    manifest.solverRoute.provider !== 'deepseek' ||
    manifest.solverRoute.model !== 'deepseek-v4-flash-zen' ||
    manifest.solverRoute.effectiveModel !== 'deepseek-v4-flash' ||
    manifest.solverRoute.reasoningEffort !== 'high' ||
    manifest.solverRoute.contextWindowTokens !== 1_048_576
  ) {
    reasons.push('solver route is not the frozen Zen-request/Flash-effective/high/1m identity')
  }
  if (routeIdentity(manifest.solverRoute) !== routeIdentity(manifest.proposerRoute)) {
    reasons.push('self track proposer and solver routes differ')
  }
  if (
    !Number.isFinite(manifest.budget.maxCostUsd) ||
    manifest.budget.maxCostUsd <= 0 ||
    manifest.budget.maxCostUsd > 500 ||
    !Number.isFinite(manifest.budget.maxWallSec) ||
    manifest.budget.maxWallSec <= 0 ||
    manifest.budget.maxWallSec > 16 * 3600 ||
    !Number.isFinite(manifest.budget.reserveFraction) ||
    manifest.budget.reserveFraction < 0.2 ||
    manifest.budget.reserveFraction >= 1 ||
    !manifest.budget.includesSealedPairedBudget
  ) {
    reasons.push('formal budget exceeds limits or omits sealed/20% reserve')
  }
  try {
    const url = new URL(manifest.leaderboard.sourceUrl)
    if (url.protocol !== 'https:') reasons.push('leaderboard snapshot source must use HTTPS')
  } catch {
    reasons.push('leaderboard snapshot URL is invalid')
  }
  if (!Number.isFinite(Date.parse(manifest.leaderboard.capturedAt))) {
    reasons.push('leaderboard snapshot capturedAt is invalid')
  } else if (Date.parse(manifest.leaderboard.capturedAt) > Date.parse(manifest.createdAt)) {
    reasons.push('leaderboard snapshot was captured after manifest freeze')
  }

  if (
    !evidence.git.clean ||
    !evidence.git.noUnreviewedSourceOrConfig ||
    evidence.git.headCommit !== manifest.code.commit ||
    evidence.git.tagPointsAtHead !== manifest.code.tag ||
    !manifest.code.tag
  ) {
    reasons.push('Git implementation is not clean, reviewed, tagged, and manifest-bound')
  }
  for (const [gate, receipt] of Object.entries(evidence.prerequisiteGateReceipts)) {
    if (!validHash(receipt)) reasons.push(`${gate} acceptance receipt missing`)
  }
  if (
    !validHash(evidence.baseline.receiptHash) ||
    !evidence.baseline.exactManifestIdentity ||
    evidence.baseline.developmentTaskCount !== 60 ||
    !Number.isSafeInteger(evidence.baseline.minimumAttemptsPerTask) ||
    evidence.baseline.minimumAttemptsPerTask < 2 ||
    evidence.baseline.capabilityMode !== 'real'
  ) {
    reasons.push('fresh/exact-identity real 60-task baseline is missing')
  }
  if (!validHash(evidence.providerRouteSmokeReceiptHash)) {
    reasons.push('frozen provider route smoke receipt missing')
  }
  if (
    !evidence.split.principalSeparated ||
    evidence.split.assignmentExposedToController ||
    evidence.split.sealedAccessCount !== 0
  ) {
    reasons.push('split principal/concealment/pre-lock sealed-access invariant failed')
  }
  if (!validHash(evidence.budgetReservationReceiptHash)) {
    reasons.push('formal budget reservation receipt missing')
  }
  if (!evidence.runDirectoryFresh) reasons.push('formal run directory is not fresh')
  for (const [procedure, tested] of Object.entries(evidence.operatorProcedures)) {
    if (!tested) reasons.push(`operator procedure not tested: ${procedure}`)
  }
  if (!evidence.statisticsProtocolPublished) {
    reasons.push('primary metric/statistical protocol was not published before reveal')
  }
  const uniqueReasons = [...new Set(reasons)].sort()
  return {
    accepted: uniqueReasons.length === 0,
    status: uniqueReasons.length === 0 ? 'PREFLIGHT_ACCEPTED' : 'PREFLIGHT_BLOCKED',
    reasons: uniqueReasons,
    manifestHash,
  }
}

export function formalSignerKeyId(publicKeyPem: string): string {
  return publicKeyId(publicKeyPem)
}
