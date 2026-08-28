import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { digestV011, isValidCandidateId } from '@dsh-self-evolving/candidate-sdk'
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
  const [admissionBytes, manifestBytes] = await Promise.all([
    readFile(join(root, 'admission-receipt.json'), 'utf8'),
    readFile(join(root, 'capsule', 'capsule.json'), 'utf8'),
  ])
  const admission = JSON.parse(admissionBytes) as {
    candidateDigest?: unknown
    buildCandidateId?: unknown
    capsuleDigest?: unknown
    admitted?: unknown
  }
  const manifest = JSON.parse(manifestBytes) as {
    candidateId?: unknown
    candidate?: { buildCandidateId?: unknown }
  }

  const expectedSourceRoot = resolve(root, 'tree')
  const expectedCapsuleRoot = resolve(root, 'capsule')
  const matches =
    typeof built.candidateId === 'string' &&
    DIGEST.test(built.candidateId) &&
    built.sourceDigest === built.candidateId &&
    admission.admitted === true &&
    admission.candidateDigest === built.candidateId &&
    typeof admission.buildCandidateId === 'string' &&
    isValidCandidateId(admission.buildCandidateId) &&
    manifest.candidateId === built.candidateId &&
    manifest.candidate?.buildCandidateId === admission.buildCandidateId &&
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
