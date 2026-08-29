import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  assertV011AdmissionResourceReceipt,
  CAPSULE_TREE_FORMAT,
  digestV011,
  isValidCandidateId,
  validateManifest,
  validateV011,
  verifyCapsuleTreeManifest,
} from '@dsh-self-evolving/candidate-sdk'
import type { BuiltCandidate } from './engine.js'

const DIGEST = /^sha256:[0-9a-f]{64}$/

interface V011Observation {
  candidateId: string
  taskId: string
  attemptIndex: number
  status: 'pass' | 'fail' | 'invalid'
  reward: number | null
}

export function v011BuiltIdentity(input: {
  candidateDigest: `sha256:${string}`
}): Pick<BuiltCandidate, 'candidateId' | 'sourceDigest'> {
  if (!DIGEST.test(input.candidateDigest)) {
    throw new Error('v0.1.1 stable build: invalid admission candidate digest')
  }
  return {
    candidateId: input.candidateDigest,
    sourceDigest: input.candidateDigest,
  }
}

/**
 * Resume only a stable build whose controller record, admission receipt and
 * packed capsule bind the same canonical digest and SDK build identity.
 * Pre-#198 state intentionally fails closed and requires a fresh state root.
 */
export async function readV011StableBuild(root: string): Promise<BuiltCandidate | null> {
  const recordPath = join(root, 'stable-build.json')
  const recordBytes = await readFile(recordPath, 'utf8').catch(() => null)
  if (recordBytes === null) return null

  const built = JSON.parse(recordBytes) as Partial<BuiltCandidate>
  const [admissionBytes, manifestBytes, resourceBytes, sumsBytes] = await Promise.all([
    readFile(join(root, 'admission-receipt.json'), 'utf8'),
    readFile(join(root, 'capsule', 'capsule.json')),
    readFile(join(root, 'resource-receipt.json'), 'utf8'),
    readFile(join(root, 'capsule', 'SHA256SUMS')),
  ])
  const admission = JSON.parse(admissionBytes) as {
    candidateDigest?: unknown
    buildCandidateId?: unknown
    capsuleDigest?: unknown
    resourceReceiptDigest?: unknown
    stageReceipts?: { offlineCapsule?: unknown }
    admitted?: unknown
  }
  const resource = JSON.parse(resourceBytes) as { candidateDigest?: unknown }
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
    candidateId?: unknown
    candidate?: { buildCandidateId?: unknown }
  }
  const admissionValidation = await validateV011('admission-receipt', admission)
  const capsuleSchema = await validateManifest('capsule', manifest)
  let resourceValid = false
  if (typeof built.candidateId === 'string' && DIGEST.test(built.candidateId)) {
    try {
      assertV011AdmissionResourceReceipt(resource, built.candidateId)
      resourceValid = true
    } catch {
      resourceValid = false
    }
  }

  const expectedSourceRoot = resolve(root, 'tree')
  const expectedCapsuleRoot = resolve(root, 'capsule')
  const liveTree = await verifyCapsuleTreeManifest(expectedCapsuleRoot).catch(() => null)
  const liveCapsuleDigest = `sha256:${createHash('sha256')
    .update(manifestBytes)
    .update(sumsBytes)
    .digest('hex')}`
  const matches =
    typeof built.candidateId === 'string' &&
    DIGEST.test(built.candidateId) &&
    resourceValid &&
    admissionValidation.valid &&
    capsuleSchema.valid &&
    typeof admission.resourceReceiptDigest === 'string' &&
    admission.resourceReceiptDigest === digestV011(resource) &&
    resource.candidateDigest === built.candidateId &&
    built.sourceDigest === built.candidateId &&
    admission.admitted === true &&
    admission.candidateDigest === built.candidateId &&
    typeof admission.buildCandidateId === 'string' &&
    isValidCandidateId(admission.buildCandidateId) &&
    manifest.candidateId === built.candidateId &&
    manifest.candidate?.buildCandidateId === admission.buildCandidateId &&
    liveTree?.format === CAPSULE_TREE_FORMAT &&
    admission.stageReceipts?.offlineCapsule === liveTree.digest &&
    admission.capsuleDigest === liveCapsuleDigest &&
    built.capsuleDigest === admission.capsuleDigest &&
    built.buildManifestDigest === digestV011(admission) &&
    typeof built.sourceRoot === 'string' &&
    resolve(built.sourceRoot) === expectedSourceRoot &&
    typeof built.capsuleRoot === 'string' &&
    resolve(built.capsuleRoot) === expectedCapsuleRoot

  if (!matches) {
    throw new Error(
      'v0.1.1 stable build: identity chain mismatch; use a fresh state directory for this run',
    )
  }
  return built as BuiltCandidate
}

export function createV011OutcomeObservationSelector(baselineCandidateId: string): (input: {
  childCandidateId: string
  taskId: string
  observations: V011Observation[]
}) => {
  baseline: V011Observation
  child: V011Observation
} {
  if (!DIGEST.test(baselineCandidateId)) {
    throw new Error('v0.1.1 outcome: invalid admitted baseline identity')
  }
  return (input) => {
    const baseline = input.observations.find(
      (row) => row.candidateId === baselineCandidateId && row.taskId === input.taskId,
    )
    const child = input.observations.find(
      (row) => row.candidateId === input.childCandidateId && row.taskId === input.taskId,
    )
    if (baseline === undefined || child === undefined) {
      throw new Error('v0.1.1 outcome: target observation pair incomplete')
    }
    return { baseline, child }
  }
}
