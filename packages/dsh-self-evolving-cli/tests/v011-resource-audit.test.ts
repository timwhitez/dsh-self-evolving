import { describe, expect, it } from 'vitest'
import {
  digestV011,
  resourcePolicyDigest,
  type ResourceDomainReceipt,
} from '@dsh-self-evolving/candidate-sdk'
import { PROPOSAL_RESOURCE_POLICY_V1, PROPOSAL_WRITABLE_MOUNTS_V1 } from '@dsh-self-evolving/core'
import { verifyV011ProposalResourceBinding } from '../src/v011-audit.js'

function receipt(): ResourceDomainReceipt {
  return {
    schemaVersion: 1,
    policyDigest: resourcePolicyDigest(PROPOSAL_RESOURCE_POLICY_V1),
    policy: PROPOSAL_RESOURCE_POLICY_V1,
    enforcement: {
      cgroup: 'v2-delegated',
      rlimits: true,
      ioDevices: ['259:0'],
      writableStorage: 'tmpfs-size-inode-hard-limit',
      writableStoragePeakSamplingMs: 10,
      writableMounts: PROPOSAL_WRITABLE_MOUNTS_V1.map(({ path, maxBytes, maxFiles }) => ({
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

describe('v0.1.1 proposal resource audit binding', () => {
  it('requires a semantically valid receipt with the exact materialization digest', () => {
    const value = receipt()
    expect(
      verifyV011ProposalResourceBinding(
        { proposerResourceReceiptDigest: digestV011(value) },
        value,
      ),
    ).toBe(true)
    expect(
      verifyV011ProposalResourceBinding(
        { proposerResourceReceiptDigest: digestV011('different') },
        value,
      ),
    ).toBe(false)
  })

  it('rejects a self-consistently rehashed failed receipt', () => {
    const value = receipt()
    value.terminationCause = 'CONTROL_PROTOCOL_FAILURE'
    value.exitCode = null
    value.signal = 'SIGKILL'
    expect(
      verifyV011ProposalResourceBinding(
        { proposerResourceReceiptDigest: digestV011(value) },
        value,
      ),
    ).toBe(false)
  })
})
