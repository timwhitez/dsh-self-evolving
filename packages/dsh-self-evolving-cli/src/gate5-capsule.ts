import { createHash } from 'node:crypto'
import { cp, lstat, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  CAPSULE_TREE_FORMAT,
  validateManifest,
  verifyCapsuleTreeManifest,
} from '@dsh-self-evolving/candidate-sdk'

const CANDIDATE_ID = /^(?:c_[a-z2-7]{26}|sha256:[0-9a-f]{64})$/
const DIGEST = /^sha256:[0-9a-f]{64}$/

export interface Gate5CapsuleIdentity {
  candidateId: string
  capsuleDigest: `sha256:${string}`
}

async function requiredRegularFile(path: string, label: string) {
  const info = await lstat(path).catch(() => null)
  if (info?.isFile() !== true || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error(`gate5 capsule: ${label} must be one regular, unlinked file`)
  }
  return info
}

/**
 * Revalidate a complete prebuilt capsule against the immutable identity in the
 * controller's evaluation plan. The current schema-2/tree-v2 verifier compares
 * the exact live entry set, binds evaluated modes and symlink-target bytes,
 * and rejects predecessor schemas, hard links plus special/unlisted entries.
 */
export async function assertGate5PrebuiltCapsule(input: {
  capsuleRoot: string
  expectedCandidateId: string
  expectedCapsuleDigest: string
}): Promise<Gate5CapsuleIdentity> {
  if (!CANDIDATE_ID.test(input.expectedCandidateId)) {
    throw new Error('gate5 capsule: expected candidate identity is invalid')
  }
  if (!DIGEST.test(input.expectedCapsuleDigest)) {
    throw new Error('gate5 capsule: expected capsule digest is invalid')
  }
  const rootInfo = await lstat(input.capsuleRoot).catch(() => null)
  if (rootInfo?.isDirectory() !== true || rootInfo.isSymbolicLink()) {
    throw new Error('gate5 capsule: prebuilt root must be one real directory')
  }
  const manifestPath = join(input.capsuleRoot, 'capsule.json')
  const sumsPath = join(input.capsuleRoot, 'SHA256SUMS')
  const launcherPath = join(input.capsuleRoot, 'runtime', 'dsh-self-evolving-acp')
  const [manifestInfo, sumsInfo, launcherInfo, forbiddenLauncher] = await Promise.all([
    requiredRegularFile(manifestPath, 'capsule.json'),
    requiredRegularFile(sumsPath, 'SHA256SUMS'),
    requiredRegularFile(launcherPath, 'runtime launcher'),
    lstat(join(input.capsuleRoot, 'runtime', 'credential-launcher.sh')).catch(() => null),
  ])
  if (manifestInfo.size === 0 || sumsInfo.size === 0 || (launcherInfo.mode & 0o111) === 0) {
    throw new Error('gate5 capsule: prebuilt broker-only capsule is incomplete')
  }
  if (forbiddenLauncher !== null) {
    throw new Error('gate5 capsule: credential-launcher capsules belong to the retired protocol')
  }

  const [manifestBytes, sumsBytes, verifiedTree] = await Promise.all([
    readFile(manifestPath),
    readFile(sumsPath),
    verifyCapsuleTreeManifest(input.capsuleRoot),
  ])
  let manifest: {
    schemaVersion?: unknown
    candidateId?: unknown
    sha256sums?: { ref?: unknown; hash?: unknown; format?: unknown }
  }
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8')) as typeof manifest
  } catch (error) {
    throw new Error('gate5 capsule: capsule manifest is invalid JSON', { cause: error })
  }
  if (verifiedTree.format !== CAPSULE_TREE_FORMAT) {
    throw new Error(`gate5 capsule: current evaluation requires ${CAPSULE_TREE_FORMAT}`)
  }
  if (!(await validateManifest('capsule', manifest)).valid) {
    throw new Error('gate5 capsule: current capsule manifest schema is invalid')
  }
  const sumsHash = createHash('sha256').update(sumsBytes).digest('hex')
  if (
    manifest.schemaVersion !== 2 ||
    manifest.candidateId !== input.expectedCandidateId ||
    manifest.sha256sums?.ref !== 'SHA256SUMS' ||
    manifest.sha256sums.hash !== sumsHash ||
    manifest.sha256sums.format !== CAPSULE_TREE_FORMAT ||
    verifiedTree.digest !== `sha256:${sumsHash}`
  ) {
    throw new Error('gate5 capsule: manifest, sums or candidate identity is inconsistent')
  }
  const capsuleDigest = `sha256:${createHash('sha256')
    .update(manifestBytes)
    .update(sumsBytes)
    .digest('hex')}` as const
  if (capsuleDigest !== input.expectedCapsuleDigest) {
    throw new Error('gate5 capsule: capsule digest differs from the evaluation plan')
  }
  return { candidateId: input.expectedCandidateId, capsuleDigest }
}

/**
 * Copy a validated prebuilt capsule into a host-private one-shot snapshot and
 * validate both sides again. Packaging only this snapshot prevents mutable
 * admission paths from racing Harbor artifact construction.
 */
export async function snapshotGate5PrebuiltCapsule(input: {
  sourceRoot: string
  snapshotRoot: string
  expectedCandidateId: string
  expectedCapsuleDigest: string
}): Promise<Gate5CapsuleIdentity & { snapshotRoot: string }> {
  if (resolve(input.sourceRoot) === resolve(input.snapshotRoot)) {
    throw new Error('gate5 capsule: source and private snapshot must differ')
  }
  const parentInfo = await lstat(dirname(resolve(input.snapshotRoot))).catch(() => null)
  if (
    parentInfo?.isDirectory() !== true ||
    parentInfo.isSymbolicLink() ||
    (parentInfo.mode & 0o077) !== 0
  ) {
    throw new Error('gate5 capsule: snapshot parent must be a private real directory')
  }
  if ((await lstat(input.snapshotRoot).catch(() => null)) !== null) {
    throw new Error('gate5 capsule: private snapshot path already exists')
  }
  const expected = {
    expectedCandidateId: input.expectedCandidateId,
    expectedCapsuleDigest: input.expectedCapsuleDigest,
  }
  await assertGate5PrebuiltCapsule({ capsuleRoot: input.sourceRoot, ...expected })
  try {
    await cp(input.sourceRoot, input.snapshotRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    })
    const [source, snapshot] = await Promise.all([
      assertGate5PrebuiltCapsule({ capsuleRoot: input.sourceRoot, ...expected }),
      assertGate5PrebuiltCapsule({ capsuleRoot: input.snapshotRoot, ...expected }),
    ])
    if (
      source.candidateId !== snapshot.candidateId ||
      source.capsuleDigest !== snapshot.capsuleDigest
    ) {
      throw new Error('gate5 capsule: private snapshot identity differs from source')
    }
    return { snapshotRoot: input.snapshotRoot, ...snapshot }
  } catch (error) {
    await rm(input.snapshotRoot, { recursive: true, force: true })
    throw error
  }
}
