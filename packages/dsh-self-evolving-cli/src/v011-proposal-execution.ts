import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { link, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  assertCompletedResourceDomainReceipt,
  canonicalizeV011Tree,
  canonicalV011,
  digestV011,
  snapshotV011Tree,
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
import { loadPublishedBundle, PUBLISH_MANIFEST, publishBundle } from './publish.js'

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

async function lstatOrNull(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
}

function sameStableSingleLinkFile(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.nlink === 1 &&
    right.nlink === 1 &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function sameRegularFileIdentity(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino
}

function sameDirectoryIdentity(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    left.isDirectory() &&
    right.isDirectory() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino
  )
}

async function readStableSingleLinkTextFile(path: string): Promise<{
  bytes: string
  info: Awaited<ReturnType<typeof lstat>>
}> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    const pathBefore = await lstat(path)
    if (!sameStableSingleLinkFile(before, pathBefore)) {
      throw new Error('v0.1.1 materialization cache is not one stable single-link file')
    }
    const contents = await handle.readFile()
    const after = await handle.stat()
    const pathAfter = await lstat(path)
    if (
      !sameStableSingleLinkFile(before, after) ||
      !sameStableSingleLinkFile(after, pathAfter) ||
      contents.byteLength !== after.size
    ) {
      throw new Error('v0.1.1 materialization cache changed while it was read')
    }
    return { bytes: contents.toString('utf8'), info: after }
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
  workerTreePath?: string
}): Promise<V011ProposalExecution | null> {
  const executionDirectory = v011ProposalExecutionDirectory(input.action)
  const directoryInfo = await lstatOrNull(executionDirectory)
  if (directoryInfo === null) return null
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error('v0.1.1 proposal execution: commit root is not a real directory')
  }
  const expectedNames = [...EXECUTION_FILES, PUBLISH_MANIFEST].sort()
  const actualEntries = await readdir(executionDirectory, { withFileTypes: true })
  if (
    actualEntries.some((entry) => !entry.isFile()) ||
    JSON.stringify(actualEntries.map((entry) => entry.name).sort()) !==
      JSON.stringify(expectedNames)
  ) {
    throw new Error('v0.1.1 proposal execution: committed directory inventory mismatch')
  }
  for (const name of expectedNames) {
    const info = await lstatOrNull(join(executionDirectory, name))
    if (info === null || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new Error(`v0.1.1 proposal execution: committed file is not canonical: ${name}`)
    }
  }
  const bundle = await loadPublishedBundle(executionDirectory)
  if (bundle === null) return null
  if (JSON.stringify(Object.keys(bundle).sort()) !== JSON.stringify([...EXECUTION_FILES])) {
    throw new Error('v0.1.1 proposal execution: committed bundle inventory mismatch')
  }
  const workerOutputBytes = bundle['worker-output.json']!
  if (input.workerOutputPath !== undefined) {
    const workerInfo = await lstatOrNull(input.workerOutputPath)
    if (
      workerInfo === null ||
      !workerInfo.isFile() ||
      workerInfo.isSymbolicLink() ||
      workerInfo.nlink !== 1
    ) {
      throw new Error('v0.1.1 proposal execution: installed worker output is not canonical')
    }
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
  const finishedTreeDigest = worker['finishedTreeDigest']
  if (typeof finishedTreeDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(finishedTreeDigest)) {
    throw new Error('v0.1.1 proposal execution: worker tree digest is invalid')
  }
  if (input.workerTreePath !== undefined) {
    const snapshot = await snapshotV011Tree(input.workerTreePath)
    const actual = digestV011((await canonicalizeV011Tree(snapshot)).bytes)
    if (actual !== finishedTreeDigest) {
      throw new Error('v0.1.1 proposal execution: installed worker tree differs from commit')
    }
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
    workerTreePath: join(input.action, 'children', input.materialization.proposalId, 'tree'),
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
  // The bundle fsyncs its own files/directory; the action parent must also
  // persist the first creation of proposal-execution-v1.
  await fsyncDirectory(input.action)
  await publishBundle(directory, {
    'worker-output.json': input.workerOutputBytes,
    'proposal-resource-receipt.json': `${canonicalV011(input.resource)}\n`,
    'gateway-receipts.json': `${JSON.stringify(input.gatewayReceipts, null, 2)}\n`,
    'proposal-diagnostic.json': `${JSON.stringify(input.diagnostic, null, 2)}\n`,
  })
  await fsyncDirectory(input.action)
}

export type V011MaterializationPublishCheckpoint =
  'staging-fsynced' | 'final-linked' | 'directory-fsynced'

/**
 * Publish the materialization cache without ever writing partial bytes at its
 * final authority path. The fsynced staging inode is hard-linked no-clobber,
 * then the action directory is synced before the call can succeed.
 */
export async function publishV011MaterializationCache(input: {
  path: string
  bytes: string
  afterCheckpoint?: (checkpoint: V011MaterializationPublishCheckpoint) => void | Promise<void>
}): Promise<void> {
  const directory = dirname(input.path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const directoryHandle = await open(
    directory,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  )
  let heldDirectoryInfo: Awaited<ReturnType<typeof lstat>>
  try {
    heldDirectoryInfo = await directoryHandle.stat()
    const pathDirectoryInfo = await lstat(directory)
    if (!sameDirectoryIdentity(heldDirectoryInfo, pathDirectoryInfo)) {
      throw new Error('v0.1.1 materialization cache directory is not one stable directory')
    }
    await directoryHandle.sync()
  } catch (error) {
    await directoryHandle.close().catch(() => {})
    throw error
  }
  const staging = join(directory, `.${basename(input.path)}.staging-${process.pid}-${randomUUID()}`)
  let publicationError: unknown
  let stagingHandle: Awaited<ReturnType<typeof open>> | undefined
  try {
    stagingHandle = await open(
      staging,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    )
    await stagingHandle.writeFile(input.bytes)
    await stagingHandle.sync()
    await input.afterCheckpoint?.('staging-fsynced')
    try {
      await link(staging, input.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`v0.1.1 materialization cache already exists: ${input.path}`, {
          cause: error,
        })
      }
      throw error
    }
    await input.afterCheckpoint?.('final-linked')
    await directoryHandle.sync()
    await input.afterCheckpoint?.('directory-fsynced')
  } catch (error) {
    publicationError = error
  }
  let cleanupError: unknown
  let stagingInfo: Awaited<ReturnType<typeof lstatOrNull>>
  try {
    stagingInfo = await lstatOrNull(staging)
  } catch (error) {
    cleanupError = error
    stagingInfo = null
  }
  if (stagingInfo !== null) {
    try {
      if (stagingHandle === undefined) {
        throw new Error('v0.1.1 materialization cache staging identity is unavailable')
      }
      const heldStagingInfo = await stagingHandle.stat()
      if (!sameRegularFileIdentity(heldStagingInfo, stagingInfo)) {
        throw new Error('v0.1.1 materialization cache staging path changed before cleanup')
      }
      await rm(staging, { force: true })
      await directoryHandle.sync()
    } catch (error) {
      cleanupError = error
    }
  }
  try {
    if (publicationError !== undefined) throw publicationError
    if (cleanupError !== undefined) throw cleanupError
    if (stagingHandle === undefined) {
      throw new Error('v0.1.1 materialization cache staging identity is unavailable')
    }
    const verifyFinalAuthority = async (): Promise<void> => {
      const currentDirectory = await lstat(directory)
      if (!sameDirectoryIdentity(heldDirectoryInfo, currentDirectory)) {
        throw new Error('v0.1.1 materialization cache authority directory changed')
      }
      const finalHandle = await open(input.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      try {
        const heldStagingInfo = await stagingHandle!.stat()
        const before = await finalHandle.stat()
        const pathBefore = await lstat(input.path)
        if (
          !sameStableSingleLinkFile(heldStagingInfo, before) ||
          !sameStableSingleLinkFile(before, pathBefore)
        ) {
          throw new Error('v0.1.1 materialization cache final authority identity changed')
        }
        const contents = await finalHandle.readFile()
        const after = await finalHandle.stat()
        const pathAfter = await lstat(input.path)
        if (
          !sameStableSingleLinkFile(before, after) ||
          !sameStableSingleLinkFile(after, pathAfter) ||
          !contents.equals(Buffer.from(input.bytes))
        ) {
          throw new Error('v0.1.1 materialization cache final authority bytes changed')
        }
      } finally {
        await finalHandle.close()
      }
    }
    await verifyFinalAuthority()
    await directoryHandle.sync()
    await verifyFinalAuthority()
  } finally {
    await stagingHandle?.close().catch(() => {})
    await directoryHandle.close().catch(() => {})
  }
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
    typeof materialization.sourceDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(materialization.sourceDigest) ||
    execution.worker['finishedTreeDigest'] !== materialization.sourceDigest ||
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
 * An exported child/cache without a mutually valid execution commit is not
 * authority. Keep every byte for audit, move deterministic authority paths and
 * publication residue aside, and let the caller recreate the slot from its
 * immutable parent. Gateway durable request records remain in place and replay
 * rather than issue a second paid call.
 */
export async function quarantineIncompleteV011ProposalExecution(input: {
  action: string
  childrenRoot: string
  workerOutputPath: string
  workerTreePath?: string
  materializationPath?: string
  force?: boolean
  route: ProposalGatewayRoute
}): Promise<boolean> {
  const execution = v011ProposalExecutionDirectory(input.action)
  const [executionInfo, childrenInfo, materializationInfo] = await Promise.all([
    lstatOrNull(execution),
    lstatOrNull(input.childrenRoot),
    input.materializationPath === undefined
      ? Promise.resolve(null)
      : lstatOrNull(input.materializationPath),
  ])
  const executionIsRealDirectory =
    executionInfo?.isDirectory() === true && !executionInfo.isSymbolicLink()
  const childrenIsRealDirectory =
    childrenInfo?.isDirectory() === true && !childrenInfo.isSymbolicLink()
  const materializationIsRealFile =
    materializationInfo === null ||
    (materializationInfo.isFile() &&
      !materializationInfo.isSymbolicLink() &&
      materializationInfo.nlink === 1)
  let executionAdoptable = false
  if (
    input.force !== true &&
    executionIsRealDirectory &&
    childrenIsRealDirectory &&
    materializationIsRealFile
  ) {
    try {
      if (
        (await loadV011ProposalExecution({
          action: input.action,
          route: input.route,
          workerOutputPath: input.workerOutputPath,
          ...(input.workerTreePath === undefined ? {} : { workerTreePath: input.workerTreePath }),
        })) !== null
      ) {
        executionAdoptable = true
      }
    } catch {
      // A manifest is not adoptable authority when its installed worker bytes
      // or tree are absent/corrupt.
    }
  }
  const exportPrefix = `.${basename(input.childrenRoot)}-resource-`
  const materializationStagingPrefix =
    input.materializationPath === undefined
      ? null
      : `.${basename(input.materializationPath)}.staging-`
  const exportResidues = await readdir(input.action, { withFileTypes: true })
    .then((entries) =>
      entries
        .filter(
          (entry) =>
            entry.name.startsWith(`${exportPrefix}export-`) ||
            entry.name.startsWith(`${exportPrefix}backup-`) ||
            (materializationStagingPrefix !== null &&
              entry.name.startsWith(materializationStagingPrefix)),
        )
        .map((entry) => entry.name)
        .sort(),
    )
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
  const quarantineExecution = !executionAdoptable && executionInfo !== null
  const quarantineChildren = !executionAdoptable && childrenInfo !== null
  const quarantineMaterialization =
    !executionAdoptable && materializationInfo !== null && input.materializationPath !== undefined
  if (
    !quarantineExecution &&
    !quarantineChildren &&
    !quarantineMaterialization &&
    exportResidues.length === 0
  )
    return false
  const quarantineRoot = join(input.action, 'incomplete-executions')
  await mkdir(quarantineRoot, { recursive: true, mode: 0o700 })
  await fsyncDirectory(input.action)
  const quarantine = join(quarantineRoot, randomUUID())
  await mkdir(quarantine, { mode: 0o700 })
  await fsyncDirectory(quarantineRoot)
  if (quarantineExecution) await rename(execution, join(quarantine, EXECUTION_DIRECTORY))
  if (quarantineChildren) await rename(input.childrenRoot, join(quarantine, 'children'))
  if (quarantineMaterialization) {
    await retainQuarantinedPath(
      input.materializationPath!,
      join(quarantine, 'materialization.json'),
    )
  }
  for (const residue of exportResidues) {
    await retainQuarantinedPath(join(input.action, residue), join(quarantine, residue))
  }
  await fsyncDirectory(quarantine)
  await fsyncDirectory(input.action)
  return true
}

async function retainQuarantinedPath(source: string, destination: string): Promise<void> {
  const info = await lstat(source)
  if (info.isFile() && info.nlink > 1) {
    // Moving one name would retain the external mutable alias. Copy fsynced
    // bytes into a fresh inode, then remove only the active/staging name.
    const bytes = await readFile(source)
    const handle = await open(destination, 'wx', 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rm(source)
    return
  }
  await rename(source, destination)
}

/**
 * Validate cache bytes and every bound execution/tree byte before adoption.
 * Any present but invalid cache is de-authorized together with its execution
 * and child; a missing cache still triggers normal incomplete-publication
 * recovery. The loader runs again after residue cleanup to close TOCTOU gaps.
 */
export async function recoverV011ProposalCache<T>(input: {
  action: string
  childrenRoot: string
  workerOutputPath: string
  workerTreePath: string
  materializationPath: string
  route: ProposalGatewayRoute
  load: (bytes: string) => Promise<T>
}): Promise<T | null> {
  const cacheInfo = await lstatOrNull(input.materializationPath)
  if (cacheInfo === null) {
    await quarantineIncompleteV011ProposalExecution({
      action: input.action,
      childrenRoot: input.childrenRoot,
      workerOutputPath: input.workerOutputPath,
      workerTreePath: input.workerTreePath,
      materializationPath: input.materializationPath,
      route: input.route,
    })
    return null
  }
  try {
    if (!cacheInfo.isFile() || cacheInfo.isSymbolicLink() || cacheInfo.nlink !== 1) {
      throw new Error('v0.1.1 materialization cache is not a canonical single-link file')
    }
    await quarantineIncompleteV011ProposalExecution({
      action: input.action,
      childrenRoot: input.childrenRoot,
      workerOutputPath: input.workerOutputPath,
      workerTreePath: input.workerTreePath,
      materializationPath: input.materializationPath,
      route: input.route,
    })
    const stableCache = await readStableSingleLinkTextFile(input.materializationPath)
    const loaded = await input.load(stableCache.bytes)
    const adoptedInfo = await lstatOrNull(input.materializationPath)
    if (adoptedInfo === null || !sameStableSingleLinkFile(stableCache.info, adoptedInfo)) {
      throw new Error('v0.1.1 materialization cache changed during adoption')
    }
    return loaded
  } catch {
    await quarantineIncompleteV011ProposalExecution({
      action: input.action,
      childrenRoot: input.childrenRoot,
      workerOutputPath: input.workerOutputPath,
      workerTreePath: input.workerTreePath,
      materializationPath: input.materializationPath,
      force: true,
      route: input.route,
    })
    return null
  }
}
