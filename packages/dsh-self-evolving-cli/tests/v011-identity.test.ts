import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { digestV011 } from '@dsh-self-evolving/candidate-sdk'
import {
  createV011OutcomeObservationSelector,
  readV011StableBuild,
  v011BuiltIdentity,
} from '../src/v011-identity.js'

const roots: string[] = []
const PARENT = `sha256:${'1'.repeat(64)}`
const CHILD = `sha256:${'2'.repeat(64)}`
const GRANDCHILD = `sha256:${'4'.repeat(64)}`
const BUILD_ID = `c_${'a'.repeat(26)}`

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function stableFixture(
  overrides: {
    builtCandidateId?: string
    manifestCandidateId?: string
    omitBuildCandidateId?: boolean
  } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-v011-identity-'))
  roots.push(root)
  await mkdir(join(root, 'capsule'), { recursive: true })
  await mkdir(join(root, 'tree'), { recursive: true })
  const candidateId = overrides.builtCandidateId ?? PARENT
  const admission = {
    schemaVersion: 1,
    protocol: 'dsh-self-evolving-candidate-tree-v2',
    candidateDigest: PARENT,
    ...(overrides.omitBuildCandidateId ? {} : { buildCandidateId: BUILD_ID }),
    capsuleDigest: `sha256:${'3'.repeat(64)}`,
    admitted: true,
  }
  await writeFile(join(root, 'admission-receipt.json'), JSON.stringify(admission) + '\n')
  await writeFile(
    join(root, 'capsule', 'capsule.json'),
    JSON.stringify({
      candidateId: overrides.manifestCandidateId ?? PARENT,
      candidate: overrides.omitBuildCandidateId ? {} : { buildCandidateId: BUILD_ID },
    }) + '\n',
  )
  await writeFile(
    join(root, 'stable-build.json'),
    JSON.stringify({
      candidateId,
      sourceDigest: candidateId,
      capsuleDigest: admission.capsuleDigest,
      buildManifestDigest: digestV011(admission),
      sourceRoot: join(root, 'tree'),
      capsuleRoot: join(root, 'capsule'),
      evidenceRefs: [],
    }) + '\n',
  )
  return root
}

describe('v0.1.1 canonical candidate identity (issue #198)', () => {
  it('uses the admission digest for both controller identity fields', () => {
    expect(v011BuiltIdentity({ candidateDigest: PARENT as `sha256:${string}` })).toEqual({
      candidateId: PARENT,
      sourceDigest: PARENT,
    })
  })

  it('loads a stable build only when record, admission and capsule identities cross-bind', async () => {
    const root = await stableFixture()
    await expect(readV011StableBuild(root)).resolves.toMatchObject({
      candidateId: PARENT,
      sourceDigest: PARENT,
    })
  })

  it('rejects both a mismatched capsule and a legacy baseline identity', async () => {
    const mismatch = await stableFixture({ manifestCandidateId: CHILD })
    await expect(readV011StableBuild(mismatch)).rejects.toThrow(/identity chain mismatch/)

    const legacy = await stableFixture({
      builtCandidateId: 'baseline',
      omitBuildCandidateId: true,
    })
    await expect(readV011StableBuild(legacy)).rejects.toThrow(/identity chain mismatch/)
  })

  it('keeps the admitted root baseline across generation 2/3 and distinct target tasks', () => {
    const observations = [
      {
        candidateId: PARENT,
        taskId: 'task-1',
        attemptIndex: 0,
        status: 'fail' as const,
        reward: 0,
      },
      { candidateId: CHILD, taskId: 'task-1', attemptIndex: 0, status: 'pass' as const, reward: 1 },
      {
        candidateId: PARENT,
        taskId: 'task-2',
        attemptIndex: 0,
        status: 'fail' as const,
        reward: 0,
      },
      {
        candidateId: CHILD,
        taskId: 'task-2',
        attemptIndex: 0,
        status: 'pass' as const,
        reward: 1,
      },
      {
        candidateId: GRANDCHILD,
        taskId: 'task-2',
        attemptIndex: 0,
        status: 'pass' as const,
        reward: 1,
      },
    ]
    const select = createV011OutcomeObservationSelector(PARENT)
    expect(
      select({
        childCandidateId: CHILD,
        taskId: 'task-1',
        observations,
      }),
    ).toEqual({ baseline: observations[0], child: observations[1] })
    expect(
      select({
        childCandidateId: GRANDCHILD,
        taskId: 'task-2',
        observations,
      }),
    ).toEqual({ baseline: observations[2], child: observations[4] })
  })
})
