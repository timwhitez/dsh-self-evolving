import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  canonicalizeV011Tree,
  digestV011,
  resourcePolicyDigest,
  snapshotV011Tree,
  type ResourceDomainReceipt,
} from '@dsh-self-evolving/candidate-sdk'
import {
  PROPOSAL_RESOURCE_POLICY_V1,
  PROPOSAL_WRITABLE_MOUNTS_V1,
  type V011MaterializationReceipt,
} from '@dsh-self-evolving/core'
import { proposalGatewayRouteHash, type ProposalGatewayRoute } from '@dsh-self-evolving/proposer'
import { verifyV011ProposalExecutionInventory } from '../src/v011-audit.js'
import {
  assertV011ProposalExecutionBinding,
  loadBoundV011ProposalExecution,
  loadV011ProposalExecution,
  publishV011ProposalExecution,
  quarantineIncompleteV011ProposalExecution,
  v011ProposalExecutionDirectory,
} from '../src/v011-proposal-execution.js'

let root: string | undefined

const route: ProposalGatewayRoute = {
  provider: 'deepseek',
  endpoint: 'https://api.deepseek.com/v1',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
  maxTokens: 32_768,
}

function gatewayReceipt() {
  return {
    requestId: `llm-${'1'.repeat(64)}`,
    requestHash: `sha256:${'2'.repeat(64)}`,
    responseHash: `sha256:${'3'.repeat(64)}`,
    routeHash: proposalGatewayRouteHash(route),
    attempts: [
      {
        attemptIndex: 0,
        status: 200,
        retryable: false,
        ambiguous: false,
        discardedUsage: null,
        responseId: null,
      },
    ],
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'v011-proposal-execution-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function resource(): ResourceDomainReceipt {
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

describe('v0.1.1 proposal execution commit', () => {
  it('rejects every manifest-committed execution outside the materialization inventory', () => {
    const actionsRoot = join(root!, 'actions')
    const bound = join(actionsRoot, 'proposal-1-1')
    const dangling = join(actionsRoot, 'proposal-9-9')
    const quarantined = join(
      bound,
      'incomplete-executions',
      'retained-crash',
      'proposal-execution-v1',
      'publish-manifest.json',
    )
    expect(
      verifyV011ProposalExecutionInventory({
        actionsRoot,
        actionTreeFiles: [
          join(bound, 'materialization.json'),
          join(bound, 'proposal-execution-v1', 'publish-manifest.json'),
          join(dangling, 'proposal-execution-v1', 'publish-manifest.json'),
          quarantined,
        ],
      }),
    ).toEqual([`committed proposal execution has no materialization: ${dangling}`])
  })

  it('adopts only one manifest-committed execution whose worker bytes match the installed tree', async () => {
    const action = join(root!, 'action')
    const workerPath = join(action, 'children', 'p_1', 'worker-output.json')
    const workerBytes = '{"finishedTreeDigest":"sha256:abc"}\n'
    await mkdir(join(workerPath, '..'), { recursive: true })
    await writeFile(workerPath, workerBytes)
    await publishV011ProposalExecution({
      action,
      workerOutputBytes: workerBytes,
      resource: resource(),
      gatewayReceipts: [gatewayReceipt()],
      diagnostic: { schemaVersion: 1 },
    })

    const loaded = await loadV011ProposalExecution({ action, route, workerOutputPath: workerPath })
    expect(loaded?.workerOutputBytes).toBe(workerBytes)
    expect(loaded?.gatewayReceipts).toEqual([gatewayReceipt()])
    await writeFile(workerPath, '{"finishedTreeDigest":"sha256:changed"}\n')
    await expect(
      loadV011ProposalExecution({ action, route, workerOutputPath: workerPath }),
    ).rejects.toThrow(/worker output differs/)
  })

  it('quarantines child-export/receipt residue and permits a clean committed retry', async () => {
    const action = join(root!, 'action')
    const children = join(action, 'children')
    const workerPath = join(children, 'p_1', 'worker-output.json')
    const execution = v011ProposalExecutionDirectory(action)
    await mkdir(join(workerPath, '..'), { recursive: true })
    await mkdir(execution, { recursive: true })
    await writeFile(workerPath, '{"partial":true}\n')
    await writeFile(join(execution, 'proposal-resource-receipt.json'), '{"partial":true')

    expect(
      await quarantineIncompleteV011ProposalExecution({
        action,
        childrenRoot: children,
        workerOutputPath: workerPath,
        route,
      }),
    ).toBe(true)
    expect(await stat(children).catch(() => null)).toBeNull()
    expect(await stat(execution).catch(() => null)).toBeNull()
    const quarantined = await readdir(join(action, 'incomplete-executions'))
    expect(quarantined).toHaveLength(1)

    const workerBytes = '{"finishedTreeDigest":"sha256:retry"}\n'
    await mkdir(join(workerPath, '..'), { recursive: true })
    await writeFile(workerPath, workerBytes)
    await publishV011ProposalExecution({
      action,
      workerOutputBytes: workerBytes,
      resource: resource(),
      gatewayReceipts: [gatewayReceipt()],
      diagnostic: { schemaVersion: 1 },
    })
    expect(
      (await loadV011ProposalExecution({ action, route, workerOutputPath: workerPath }))
        ?.workerOutputBytes,
    ).toBe(workerBytes)
    expect(await readFile(join(execution, 'worker-output.json'), 'utf8')).toBe(workerBytes)
  })

  it('quarantines a committed execution when its installed worker tree disappeared', async () => {
    const action = join(root!, 'committed-missing-tree')
    const children = join(action, 'children')
    const slot = join(children, 'p_1')
    const tree = join(slot, 'tree')
    const workerPath = join(slot, 'worker-output.json')
    await mkdir(join(tree, 'src'), { recursive: true })
    await writeFile(join(tree, 'src', 'index.ts'), 'export const value = 1\n')
    const finishedTreeDigest = digestV011(
      (await canonicalizeV011Tree(await snapshotV011Tree(tree))).bytes,
    )
    const workerBytes = `${JSON.stringify({ finishedTreeDigest })}\n`
    await writeFile(workerPath, workerBytes)
    await publishV011ProposalExecution({
      action,
      workerOutputBytes: workerBytes,
      resource: resource(),
      gatewayReceipts: [gatewayReceipt()],
      diagnostic: { schemaVersion: 1 },
    })
    await rm(tree, { recursive: true })

    expect(
      await quarantineIncompleteV011ProposalExecution({
        action,
        childrenRoot: children,
        workerOutputPath: workerPath,
        workerTreePath: tree,
        route,
      }),
    ).toBe(true)
    expect(await stat(children).catch(() => null)).toBeNull()
    expect(await stat(v011ProposalExecutionDirectory(action)).catch(() => null)).toBeNull()
    const quarantined = await readdir(join(action, 'incomplete-executions'))
    expect(quarantined).toHaveLength(1)
    expect(
      await stat(join(action, 'incomplete-executions', quarantined[0]!, 'proposal-execution-v1')),
    ).not.toBeNull()
  })

  it('quarantines a crash residue left between child-tree replacement renames', async () => {
    const action = join(root!, 'interrupted-export-rename')
    const children = join(action, 'children')
    const backup = join(action, '.children-resource-backup-crash-boundary')
    await mkdir(backup, { recursive: true })
    await writeFile(join(backup, 'seed.txt'), 'retained-before-rename\n')

    expect(
      await quarantineIncompleteV011ProposalExecution({
        action,
        childrenRoot: children,
        workerOutputPath: join(children, 'p_1', 'worker-output.json'),
        workerTreePath: join(children, 'p_1', 'tree'),
        route,
      }),
    ).toBe(true)
    expect(await stat(backup).catch(() => null)).toBeNull()
    const quarantined = await readdir(join(action, 'incomplete-executions'))
    expect(quarantined).toHaveLength(1)
    expect(
      await readFile(
        join(
          action,
          'incomplete-executions',
          quarantined[0]!,
          '.children-resource-backup-crash-boundary',
          'seed.txt',
        ),
        'utf8',
      ),
    ).toBe('retained-before-rename\n')
  })

  it('recovers every pre-manifest receipt publication boundary', async () => {
    const files = [
      'gateway-receipts.json',
      'proposal-diagnostic.json',
      'proposal-resource-receipt.json',
      'worker-output.json',
    ]
    for (let boundary = 0; boundary < files.length; boundary += 1) {
      const action = join(root!, `boundary-${boundary}`)
      const children = join(action, 'children')
      const workerPath = join(children, 'p_1', 'worker-output.json')
      const execution = v011ProposalExecutionDirectory(action)
      await mkdir(join(workerPath, '..'), { recursive: true })
      await mkdir(execution, { recursive: true })
      await writeFile(workerPath, '{"exported":true}\n')
      for (const name of files.slice(0, boundary + 1)) {
        await writeFile(join(execution, name), '{"uncommitted":true}\n')
      }
      expect(
        await quarantineIncompleteV011ProposalExecution({
          action,
          childrenRoot: children,
          workerOutputPath: workerPath,
          route,
        }),
      ).toBe(true)
      expect(await stat(children).catch(() => null)).toBeNull()
      expect(await stat(execution).catch(() => null)).toBeNull()
    }
  })

  it('binds materialization usage, diagnostic, transcript, gateway count and resource digest', async () => {
    const action = join(root!, 'binding')
    const workerPath = join(action, 'children', 'p_1', 'worker-output.json')
    const receipt = resource()
    const workerBytes = '{"transcript":{"eventCount":2}}\n'
    const gatewayReceipts = [gatewayReceipt()]
    const diagnostic = {
      schemaVersion: 1,
      providerFailure: null,
      gatewayReceiptCount: 1,
      sandbox: { exitCode: 0, signal: null, resource: receipt },
    }
    await mkdir(join(workerPath, '..'), { recursive: true })
    await writeFile(workerPath, workerBytes)
    await publishV011ProposalExecution({
      action,
      workerOutputBytes: workerBytes,
      resource: receipt,
      gatewayReceipts,
      diagnostic,
    })
    const execution = await loadV011ProposalExecution({
      action,
      route,
      workerOutputPath: workerPath,
    })
    expect(execution).not.toBeNull()
    const materialization = {
      proposerResourceReceiptDigest: digestV011(receipt),
      proposerUsage: { gatewayReceipts: 1, eventCount: 2 },
    } as V011MaterializationReceipt
    expect(() =>
      assertV011ProposalExecutionBinding(materialization, execution!, route),
    ).not.toThrow()
    expect(() =>
      assertV011ProposalExecutionBinding(
        { ...materialization, proposerUsage: { gatewayReceipts: 2, eventCount: 2 } },
        execution!,
        route,
      ),
    ).toThrow(/binding mismatch/)
  })

  it('rejects a manifest-committed malformed gateway matrix before V011 adoption', async () => {
    const action = join(root!, 'malformed-gateway')
    const workerPath = join(action, 'children', 'p_1', 'worker-output.json')
    const workerBytes = '{"transcript":{"eventCount":1}}\n'
    await mkdir(join(workerPath, '..'), { recursive: true })
    await writeFile(workerPath, workerBytes)
    await publishV011ProposalExecution({
      action,
      workerOutputBytes: workerBytes,
      resource: resource(),
      gatewayReceipts: [null],
      diagnostic: { schemaVersion: 1 },
    })
    await expect(
      loadV011ProposalExecution({ action, route, workerOutputPath: workerPath }),
    ).rejects.toThrow(/gateway receipt/i)
  })

  it('replays every materialized attempt execution, including an unretained build attempt', async () => {
    const action = join(root!, 'proposal-2-2')
    const proposalId = `p_${'7'.repeat(32)}`
    const workerPath = join(action, 'children', proposalId, 'worker-output.json')
    const tree = join(action, 'children', proposalId, 'tree')
    await mkdir(join(tree, 'src'), { recursive: true })
    await writeFile(join(tree, 'src', 'index.ts'), 'export const attempt = 2\n')
    const sourceDigest = digestV011(
      (await canonicalizeV011Tree(await snapshotV011Tree(tree))).bytes,
    )
    const workerBytes = `${JSON.stringify({
      transcript: { eventCount: 1 },
      finishedTreeDigest: sourceDigest,
    })}\n`
    const receipt = resource()
    await writeFile(workerPath, workerBytes)
    await publishV011ProposalExecution({
      action,
      workerOutputBytes: workerBytes,
      resource: receipt,
      gatewayReceipts: [gatewayReceipt()],
      diagnostic: {
        schemaVersion: 1,
        providerFailure: null,
        gatewayReceiptCount: 1,
        sandbox: { exitCode: 0, signal: null, resource: receipt },
      },
    })
    const materialization = {
      proposalId,
      sourceDigest,
      proposerResourceReceiptDigest: digestV011(receipt),
      proposerUsage: { gatewayReceipts: 1, eventCount: 1 },
    } as V011MaterializationReceipt
    await expect(
      loadBoundV011ProposalExecution({ action, materialization, route }),
    ).resolves.toMatchObject({ gatewayReceipts: [gatewayReceipt()] })

    await writeFile(workerPath, '{"tampered":true}\n')
    await expect(
      loadBoundV011ProposalExecution({ action, materialization, route }),
    ).rejects.toThrow(/worker output differs/)
  })
})
