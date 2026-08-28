import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CANDIDATE_BUILD_RESOURCE_POLICY_V1,
  CANDIDATE_BUILD_WRITABLE_MOUNTS_V1,
  CANDIDATE_RUNTIME_RESOURCE_POLICY_V1,
  CANDIDATE_TEST_RESOURCE_POLICY_V1,
  digestV011,
  resourcePolicyDigest,
  type ResourceDomainReceipt,
  type ResourcePolicyV1,
} from '@dsh-self-evolving/candidate-sdk'
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

function stage(
  policy: ResourcePolicyV1,
  mounts: Array<{ path: string; maxBytes: number; maxFiles: number }>,
): ResourceDomainReceipt {
  return {
    schemaVersion: 1,
    policyDigest: resourcePolicyDigest(policy),
    policy,
    enforcement: {
      cgroup: 'v2-delegated',
      rlimits: true,
      ioDevices: ['259:0'],
      writableStorage: 'tmpfs-size-inode-hard-limit',
      writableStoragePeakSamplingMs: 10,
      writableMounts: mounts,
      sandbox: {
        filesystemRoot: 'read-only',
        writablePaths: 'bounded-tmpfs-only',
        nestedUserNamespaces: 'disabled',
        targetPidNamespace: 'private-descendant',
        targetCapabilities: 'none',
        noNewPrivileges: true,
      },
    },
    usage: {
      memoryPeakBytes: 0,
      pidsPeak: 0,
      cpuUsageUsec: 0,
      cpuUserUsec: 0,
      cpuSystemUsec: 0,
      cpuThrottledUsec: 0,
      cpuThrottledPeriods: 0,
      ioReadBytes: 0,
      ioWriteBytes: 0,
      ioReadOps: 0,
      ioWriteOps: 0,
      writableStoragePeakBytes: 0,
      writableStoragePeakFiles: 0,
    },
    events: { memoryMaxEvents: 0, memoryOomEvents: 0, memoryOomKills: 0, pidsMaxEvents: 0 },
    terminationCause: 'COMPLETED',
    exitCode: 0,
    signal: null,
  }
}

function validResourceReceipt() {
  const buildMounts = CANDIDATE_BUILD_WRITABLE_MOUNTS_V1.map(({ path, maxBytes, maxFiles }) => ({
    path,
    maxBytes,
    maxFiles,
  }))
  const testMounts = [
    { path: '/tmp', maxBytes: 96 * 1024 * 1024, maxFiles: 3072 },
    { path: '/dev/shm', maxBytes: 32 * 1024 * 1024, maxFiles: 1024 },
  ]
  const loaderMounts = [
    { path: '/tmp', maxBytes: 32 * 1024 * 1024, maxFiles: 1024 },
    { path: '/dev/shm', maxBytes: 16 * 1024 * 1024, maxFiles: 512 },
  ]
  return {
    schemaVersion: 1,
    candidateDigest: PARENT,
    candidateTests: stage(CANDIDATE_TEST_RESOURCE_POLICY_V1, testMounts),
    builds: [
      stage(CANDIDATE_BUILD_RESOURCE_POLICY_V1, buildMounts),
      stage(CANDIDATE_BUILD_RESOURCE_POLICY_V1, buildMounts),
    ],
    loaderSolve: stage(CANDIDATE_RUNTIME_RESOURCE_POLICY_V1, loaderMounts),
    loaderPropose: stage(CANDIDATE_RUNTIME_RESOURCE_POLICY_V1, loaderMounts),
    packedOverlayBoot: stage(CANDIDATE_RUNTIME_RESOURCE_POLICY_V1, [
      ...loaderMounts,
      { path: '/workspace', maxBytes: 64 * 1024 * 1024, maxFiles: 2048 },
      { path: '/logs', maxBytes: 64 * 1024 * 1024, maxFiles: 2048 },
    ]),
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function stableFixture(
  overrides: {
    builtCandidateId?: string
    manifestCandidateId?: string
    omitBuildCandidateId?: boolean
    omitPackedOverlayBoot?: boolean
  } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-v011-identity-'))
  roots.push(root)
  await mkdir(join(root, 'capsule'), { recursive: true })
  await mkdir(join(root, 'tree'), { recursive: true })
  const candidateId = overrides.builtCandidateId ?? PARENT
  const resource = validResourceReceipt()
  const admission = {
    schemaVersion: 1,
    protocol: 'dsh-self-evolving-candidate-tree-v2',
    candidateDigest: PARENT,
    ...(overrides.omitBuildCandidateId ? {} : { buildCandidateId: BUILD_ID }),
    materializationDigest: `sha256:${'5'.repeat(64)}`,
    capabilityCatalogDigest: `sha256:${'6'.repeat(64)}`,
    resourceReceiptDigest: digestV011(resource),
    stageReceipts: {
      containment: `sha256:${'7'.repeat(64)}`,
      schema: `sha256:${'8'.repeat(64)}`,
      policy: `sha256:${'9'.repeat(64)}`,
      candidateTests: `sha256:${'a'.repeat(64)}`,
      doubleBuild: `sha256:${'b'.repeat(64)}`,
      loaderSolve: `sha256:${'c'.repeat(64)}`,
      loaderPropose: `sha256:${'d'.repeat(64)}`,
      ...(overrides.omitPackedOverlayBoot ? {} : { packedOverlayBoot: `sha256:${'e'.repeat(64)}` }),
      fixedReplay: `sha256:${'f'.repeat(64)}`,
      offlineCapsule: `sha256:${'0'.repeat(64)}`,
    },
    capsuleDigest: `sha256:${'3'.repeat(64)}`,
    admitted: true,
  }
  await writeFile(join(root, 'admission-receipt.json'), JSON.stringify(admission) + '\n')
  await writeFile(join(root, 'resource-receipt.json'), JSON.stringify(resource) + '\n')
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

  it('rejects a self-consistent pre-#197 receipt that lacks packed-overlay boot evidence', async () => {
    const legacy = await stableFixture({ omitPackedOverlayBoot: true })
    await expect(readV011StableBuild(legacy)).rejects.toThrow(/identity chain mismatch/)
  })

  it('rejects a resource receipt that no longer matches the admitted digest', async () => {
    const root = await stableFixture()
    await writeFile(
      join(root, 'resource-receipt.json'),
      JSON.stringify({ schemaVersion: 1, candidateDigest: CHILD, fixture: true }) + '\n',
    )
    await expect(readV011StableBuild(root)).rejects.toThrow(/identity chain mismatch/)
  })

  it('rejects a self-consistent failed or incomplete resource receipt', async () => {
    for (const mutate of [
      (resource: ReturnType<typeof validResourceReceipt>) => {
        resource.packedOverlayBoot.terminationCause = 'CONTROL_PROTOCOL_FAILURE'
        resource.packedOverlayBoot.exitCode = null
        resource.packedOverlayBoot.signal = 'SIGKILL'
      },
      (resource: ReturnType<typeof validResourceReceipt>) => {
        resource.loaderSolve.usage.writableStoragePeakBytes = null
      },
    ]) {
      const root = await stableFixture()
      const resource = validResourceReceipt()
      mutate(resource)
      const admissionPath = join(root, 'admission-receipt.json')
      const admission = JSON.parse(await readFile(admissionPath, 'utf8')) as {
        resourceReceiptDigest: string
      }
      admission.resourceReceiptDigest = digestV011(resource)
      await writeFile(join(root, 'resource-receipt.json'), JSON.stringify(resource) + '\n')
      await writeFile(admissionPath, JSON.stringify(admission) + '\n')
      const builtPath = join(root, 'stable-build.json')
      const built = JSON.parse(await readFile(builtPath, 'utf8')) as {
        buildManifestDigest: string
      }
      built.buildManifestDigest = digestV011(admission)
      await writeFile(builtPath, JSON.stringify(built) + '\n')
      await expect(readV011StableBuild(root)).rejects.toThrow(/identity chain mismatch/)
    }
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
