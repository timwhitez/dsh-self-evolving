import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CANDIDATE_BUILD_RESOURCE_POLICY_V1,
  CANDIDATE_BUILD_WRITABLE_MOUNTS_V1,
  resourcePolicyDigest,
  type ResourceDomainReceipt,
} from '@dsh-self-evolving/candidate-sdk'
import { readResourceBoundStableBuild } from '../src/real-capabilities.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'stable-resource-publication-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const sha = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`

function stage(): ResourceDomainReceipt {
  return {
    schemaVersion: 1,
    policyDigest: resourcePolicyDigest(CANDIDATE_BUILD_RESOURCE_POLICY_V1),
    policy: CANDIDATE_BUILD_RESOURCE_POLICY_V1,
    enforcement: {
      cgroup: 'v2-delegated',
      rlimits: true,
      ioDevices: ['259:0'],
      writableStorage: 'tmpfs-size-inode-hard-limit',
      writableStoragePeakSamplingMs: 10,
      writableMounts: CANDIDATE_BUILD_WRITABLE_MOUNTS_V1.map(({ path, maxBytes, maxFiles }) => ({
        path,
        maxBytes,
        maxFiles,
      })),
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
      memoryPeakBytes: 1,
      pidsPeak: 1,
      cpuUsageUsec: 2,
      cpuUserUsec: 1,
      cpuSystemUsec: 1,
      cpuThrottledUsec: 0,
      cpuThrottledPeriods: 0,
      ioReadBytes: 0,
      ioWriteBytes: 0,
      ioReadOps: 0,
      ioWriteOps: 0,
      writableStoragePeakBytes: 1,
      writableStoragePeakFiles: 1,
    },
    events: { memoryMaxEvents: 0, memoryOomEvents: 0, memoryOomKills: 0, pidsMaxEvents: 0 },
    terminationCause: 'COMPLETED',
    exitCode: 0,
    signal: null,
  }
}

async function writePublication(failed = false): Promise<void> {
  const candidateId = `sha256:${'1'.repeat(64)}`
  const first = stage()
  if (failed) {
    first.terminationCause = 'CONTROL_PROTOCOL_FAILURE'
    first.exitCode = null
    first.signal = 'SIGKILL'
  }
  const resource = { schemaVersion: 1, candidateId, builds: [first, stage()] }
  const built = {
    candidateId,
    sourceDigest: candidateId,
    capsuleDigest: `sha256:${'2'.repeat(64)}`,
    buildManifestDigest: `sha256:${'3'.repeat(64)}`,
    resourceReceiptDigest: sha(JSON.stringify(resource)),
    sourceRoot: join(root!, 'candidate'),
    evidenceRefs: [],
  }
  await mkdir(root!, { recursive: true })
  await writeFile(join(root!, 'build-resource.json'), `${JSON.stringify(resource)}\n`)
  await writeFile(join(root!, 'stable-build.json'), `${JSON.stringify(built)}\n`)
}

describe('stable build resource publication', () => {
  it('requires the exact candidate-bound digest and complete build receipts on resume', async () => {
    await writePublication()
    await expect(readResourceBoundStableBuild(root!)).resolves.toMatchObject({
      candidateId: `sha256:${'1'.repeat(64)}`,
    })
  })

  it('rejects a self-consistently rehashed failed build receipt', async () => {
    await writePublication(true)
    await expect(readResourceBoundStableBuild(root!)).rejects.toThrow(/exit code zero/)
  })
})
