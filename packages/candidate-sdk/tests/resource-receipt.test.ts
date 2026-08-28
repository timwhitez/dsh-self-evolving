import { describe, expect, it } from 'vitest'
import {
  assertCompletedResourceDomainReceipt,
  CANDIDATE_RUNTIME_RESOURCE_POLICY_V1,
  resourcePolicyDigest,
  type ResourceDomainReceipt,
} from '../src/resource-domain.js'

const mounts = [{ path: '/tmp', maxBytes: 1024, maxFiles: 16 }]

function validReceipt(): ResourceDomainReceipt {
  return {
    schemaVersion: 1,
    policyDigest: resourcePolicyDigest(CANDIDATE_RUNTIME_RESOURCE_POLICY_V1),
    policy: CANDIDATE_RUNTIME_RESOURCE_POLICY_V1,
    enforcement: {
      cgroup: 'v2-delegated',
      rlimits: true,
      ioDevices: ['259:0'],
      writableStorage: 'tmpfs-size-inode-hard-limit',
      writableStoragePeakSamplingMs: 10,
      writableMounts: mounts.map((mount) => ({ ...mount })),
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
      memoryPeakBytes: 1024,
      pidsPeak: 2,
      cpuUsageUsec: 30,
      cpuUserUsec: 20,
      cpuSystemUsec: 10,
      cpuThrottledUsec: 0,
      cpuThrottledPeriods: 0,
      ioReadBytes: 0,
      ioWriteBytes: 0,
      ioReadOps: 0,
      ioWriteOps: 0,
      writableStoragePeakBytes: 32,
      writableStoragePeakFiles: 1,
    },
    events: {
      memoryMaxEvents: 0,
      memoryOomEvents: 0,
      memoryOomKills: 0,
      pidsMaxEvents: 0,
    },
    terminationCause: 'COMPLETED',
    exitCode: 0,
    signal: null,
  }
}

const verify = (value: unknown) =>
  assertCompletedResourceDomainReceipt(value, {
    policy: CANDIDATE_RUNTIME_RESOURCE_POLICY_V1,
    writableMounts: mounts,
    label: 'test stage',
  })

describe('completed resource receipt authority', () => {
  it('accepts a complete receipt bound to the exact frozen policy and mounts', () => {
    expect(verify(validReceipt())).toEqual(validReceipt())
  })

  it('rejects digest-only fixtures and missing storage peaks', () => {
    expect(() => verify({ schemaVersion: 1, fixture: true })).toThrow(/invalid envelope/)
    const receipt = validReceipt()
    receipt.usage.writableStoragePeakBytes = null
    expect(() => verify(receipt)).toThrow(/usage metrics/)
  })

  it('rejects limit events, failed termination, and mount drift', () => {
    const event = validReceipt()
    event.events.memoryMaxEvents = 1
    expect(() => verify(event)).toThrow(/limit events/)

    const failed = validReceipt()
    failed.terminationCause = 'CONTROL_PROTOCOL_FAILURE'
    failed.exitCode = null
    failed.signal = 'SIGKILL'
    expect(() => verify(failed)).toThrow(/exit code zero/)

    const drift = validReceipt()
    drift.enforcement.writableMounts[0]!.maxBytes += 1
    expect(() => verify(drift)).toThrow(/enforcement\/mount contract/)
  })
})
