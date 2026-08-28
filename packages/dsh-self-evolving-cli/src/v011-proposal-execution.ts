import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assertCompletedResourceDomainReceipt,
  canonicalV011,
  digestV011,
  type ResourceDomainReceipt,
} from '@dsh-self-evolving/candidate-sdk'
import {
  PROPOSAL_RESOURCE_POLICY_V1,
  PROPOSAL_WRITABLE_MOUNTS_V1,
  type V011MaterializationReceipt,
} from '@dsh-self-evolving/core'
import {
  assertCompletedProposalGatewayReceipts,
  type ProposalGatewayReceipt,
  type ProposalGatewayRoute,
} from '@dsh-self-evolving/proposer'
import { loadPublishedBundle, publishBundle } from './publish.js'

const EXECUTION_DIRECTORY = 'proposal-execution-v1'
const EXECUTION_FILES = [
  'gateway-receipts.json',
  'proposal-diagnostic.json',
  'proposal-resource-receipt.json',
  'worker-output.json',
] as const

export interface V011ProposalExecution {
  workerOutputBytes: string
  worker: Record<string, unknown>
  resource: ResourceDomainReceipt
  gatewayReceipts: ProposalGatewayReceipt[]
  diagnostic: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export function v011ProposalExecutionDirectory(action: string): string {
  return join(action, EXECUTION_DIRECTORY)
}

export async function loadV011ProposalExecution(input: {
  action: string
  route: ProposalGatewayRoute
  workerOutputPath?: string
}): Promise<V011ProposalExecution | null> {
  const bundle = await loadPublishedBundle(v011ProposalExecutionDirectory(input.action))
  if (bundle === null) return null
  if (JSON.stringify(Object.keys(bundle).sort()) !== JSON.stringify([...EXECUTION_FILES])) {
    throw new Error('v0.1.1 proposal execution: committed bundle inventory mismatch')
  }
  const workerOutputBytes = bundle['worker-output.json']!
  if (input.workerOutputPath !== undefined) {
    const installed = await readFile(input.workerOutputPath, 'utf8').catch(() => null)
    if (installed !== workerOutputBytes) {
      throw new Error('v0.1.1 proposal execution: installed worker output differs from commit')
    }
  }
  let worker: unknown
  let resource: unknown
  let gatewayReceipts: unknown
  let diagnostic: unknown
  try {
    worker = JSON.parse(workerOutputBytes)
    resource = JSON.parse(bundle['proposal-resource-receipt.json']!)
    gatewayReceipts = JSON.parse(bundle['gateway-receipts.json']!)
    diagnostic = JSON.parse(bundle['proposal-diagnostic.json']!)
  } catch (cause) {
    throw new Error('v0.1.1 proposal execution: committed JSON is invalid', { cause })
  }
  if (!isRecord(worker) || !isRecord(diagnostic)) {
    throw new Error('v0.1.1 proposal execution: committed evidence shape is invalid')
  }
  const verifiedGatewayReceipts = assertCompletedProposalGatewayReceipts(
    gatewayReceipts,
    input.route,
    'v0.1.1 proposal execution',
  )
  const verifiedResource = assertCompletedResourceDomainReceipt(resource, {
    policy: PROPOSAL_RESOURCE_POLICY_V1,
    writableMounts: PROPOSAL_WRITABLE_MOUNTS_V1,
    label: 'v0.1.1 proposal execution resource receipt',
  })
  return {
    workerOutputBytes,
    worker,
    resource: verifiedResource,
    gatewayReceipts: verifiedGatewayReceipts,
    diagnostic,
  }
}

/**
 * Load one materialized proposal's committed execution and bind every byte of
 * that execution to the materialization authority. Final audit uses this for
 * every completed proposal attempt, including attempts whose later build was
 * rejected and therefore never became a generation candidate.
 */
export async function loadBoundV011ProposalExecution(input: {
  action: string
  materialization: V011MaterializationReceipt
  route: ProposalGatewayRoute
}): Promise<V011ProposalExecution> {
  const execution = await loadV011ProposalExecution({
    action: input.action,
    route: input.route,
    workerOutputPath: join(
      input.action,
      'children',
      input.materialization.proposalId,
      'worker-output.json',
    ),
  })
  if (execution === null) {
    throw new Error('v0.1.1 proposal execution: committed execution is missing')
  }
  assertV011ProposalExecutionBinding(input.materialization, execution, input.route)
  return execution
}

export async function publishV011ProposalExecution(input: {
  action: string
  workerOutputBytes: string
  resource: ResourceDomainReceipt
  gatewayReceipts: unknown[]
  diagnostic: Record<string, unknown>
}): Promise<void> {
  const directory = v011ProposalExecutionDirectory(input.action)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await publishBundle(directory, {
    'worker-output.json': input.workerOutputBytes,
    'proposal-resource-receipt.json': `${canonicalV011(input.resource)}\n`,
    'gateway-receipts.json': `${JSON.stringify(input.gatewayReceipts, null, 2)}\n`,
    'proposal-diagnostic.json': `${JSON.stringify(input.diagnostic, null, 2)}\n`,
  })
}

export function assertV011ProposalExecutionBinding(
  materialization: V011MaterializationReceipt,
  execution: V011ProposalExecution,
  route: ProposalGatewayRoute,
): void {
  const usage = materialization.proposerUsage
  const transcript = execution.worker['transcript']
  const sandbox = execution.diagnostic['sandbox']
  let gatewayValid = true
  try {
    assertCompletedProposalGatewayReceipts(
      execution.gatewayReceipts,
      route,
      'v0.1.1 proposal execution binding',
    )
  } catch {
    gatewayValid = false
  }
  if (
    !gatewayValid ||
    materialization.proposerResourceReceiptDigest !== digestV011(execution.resource) ||
    !isRecord(usage) ||
    !exactKeys(usage, ['eventCount', 'gatewayReceipts']) ||
    usage['gatewayReceipts'] !== execution.gatewayReceipts.length ||
    !nonNegativeSafeInteger(usage['eventCount']) ||
    !isRecord(transcript) ||
    transcript['eventCount'] !== usage['eventCount'] ||
    !exactKeys(execution.diagnostic, [
      'schemaVersion',
      'providerFailure',
      'gatewayReceiptCount',
      'sandbox',
    ]) ||
    execution.diagnostic['schemaVersion'] !== 1 ||
    execution.diagnostic['providerFailure'] !== null ||
    execution.diagnostic['gatewayReceiptCount'] !== execution.gatewayReceipts.length ||
    !isRecord(sandbox) ||
    sandbox['exitCode'] !== 0 ||
    sandbox['signal'] !== null ||
    canonicalV011(sandbox['resource']) !== canonicalV011(execution.resource)
  ) {
    throw new Error('v0.1.1 proposal execution: materialization/evidence binding mismatch')
  }
}

/**
 * An exported child without the execution commit marker is not authority. Keep
 * every byte for audit, move it out of the deterministic paths, and let the
 * caller recreate the child slot from its immutable parent. Gateway durable
 * request records stay at action/gateway/requests and therefore replay rather
 * than issue a second paid call.
 */
export async function quarantineIncompleteV011ProposalExecution(input: {
  action: string
  childrenRoot: string
  workerOutputPath: string
  route: ProposalGatewayRoute
}): Promise<boolean> {
  if ((await loadV011ProposalExecution({ action: input.action, route: input.route })) !== null) {
    return false
  }
  const execution = v011ProposalExecutionDirectory(input.action)
  const [executionInfo, workerInfo] = await Promise.all([
    stat(execution).catch(() => null),
    stat(input.workerOutputPath).catch(() => null),
  ])
  if (executionInfo === null && workerInfo === null) return false
  const quarantine = join(input.action, 'incomplete-executions', randomUUID())
  await mkdir(quarantine, { recursive: true, mode: 0o700 })
  if (executionInfo !== null) await rename(execution, join(quarantine, EXECUTION_DIRECTORY))
  if (workerInfo !== null) await rename(input.childrenRoot, join(quarantine, 'children'))
  await fsyncDirectory(quarantine)
  await fsyncDirectory(input.action)
  return true
}
