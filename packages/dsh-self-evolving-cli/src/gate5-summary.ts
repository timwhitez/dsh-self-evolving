import { spawn } from 'node:child_process'
import { constants as fsConstants, type Stats } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, open, readdir, unlink, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export type Gate5SummaryPublishCheckpoint =
  | 'staging-created'
  | 'staging-partial-written'
  | 'staging-written'
  | 'staging-synced'
  | 'final-linked'
  | 'directory-synced'

export type Gate5SummaryReconciliation = 'published' | 'reused' | 'recovered'

type StableFile = {
  bytes: Buffer
  info: Stats
  pathPresent: boolean
}

type StableDirectory = {
  handle: FileHandle
  info: Stats
  namedPath: string
  pinnedPath: string
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function assertRegularSummaryFile(info: Stats, label: string): void {
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`gate5 summary: ${label} is not a regular file`)
  }
  if ((info.mode & 0o777) !== 0o600) {
    throw new Error(`gate5 summary: ${label} mode is not 0600`)
  }
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  return lstat(path).catch((error: unknown) => {
    if (isErrno(error, 'ENOENT')) return null
    throw error
  })
}

async function readStableFile(
  path: string,
  label: string,
  afterRead?: () => void | Promise<void>,
): Promise<StableFile | null> {
  const pathBefore = await lstatOrNull(path)
  if (pathBefore === null) return null
  assertRegularSummaryFile(pathBefore, label)
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const heldBefore = await handle.stat()
    assertRegularSummaryFile(heldBefore, label)
    if (!sameIdentity(pathBefore, heldBefore)) {
      throw new Error(`gate5 summary: ${label} identity changed before read`)
    }
    const bytes = await handle.readFile()
    const heldAfterRead = await handle.stat()
    assertRegularSummaryFile(heldAfterRead, label)
    if (
      !sameIdentity(heldBefore, heldAfterRead) ||
      heldBefore.size !== heldAfterRead.size ||
      heldAfterRead.size !== bytes.byteLength
    ) {
      throw new Error(`gate5 summary: ${label} changed during read`)
    }
    await afterRead?.()
    const pathAfter = await lstatOrNull(path)
    const heldAfterPathCheck = await handle.stat()
    assertRegularSummaryFile(heldAfterPathCheck, label)
    if (
      !sameIdentity(heldAfterRead, heldAfterPathCheck) ||
      heldAfterRead.size !== heldAfterPathCheck.size ||
      heldAfterRead.mtimeMs !== heldAfterPathCheck.mtimeMs
    ) {
      throw new Error(`gate5 summary: ${label} changed after read`)
    }
    if (pathAfter === null) {
      return { bytes, info: heldAfterPathCheck, pathPresent: false }
    }
    assertRegularSummaryFile(pathAfter, label)
    if (
      !sameIdentity(heldAfterPathCheck, pathAfter) ||
      heldAfterPathCheck.size !== pathAfter.size ||
      heldAfterPathCheck.mtimeMs !== pathAfter.mtimeMs
    ) {
      throw new Error(`gate5 summary: ${label} identity changed during read`)
    }
    return { bytes, info: heldAfterPathCheck, pathPresent: true }
  } finally {
    await handle.close()
  }
}

async function openStableDirectory(path: string): Promise<StableDirectory> {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  )
  try {
    const held = await handle.stat()
    const named = await lstat(path)
    if (!held.isDirectory() || !named.isDirectory() || !sameIdentity(held, named)) {
      throw new Error('gate5 summary: authority directory is not one stable directory')
    }
    return {
      handle,
      info: held,
      namedPath: path,
      // Gate 5 runs on the Linux Harbor host. Resolving entries through this
      // descriptor keeps mutations on the opened inode even if its name moves.
      pinnedPath: `/proc/self/fd/${String(handle.fd)}`,
    }
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
  }
}

async function assertDirectoryIdentity(directory: StableDirectory): Promise<void> {
  const [held, named] = await Promise.all([
    directory.handle.stat(),
    lstatOrNull(directory.namedPath),
  ])
  if (
    !held.isDirectory() ||
    !sameIdentity(held, directory.info) ||
    named === null ||
    !named.isDirectory() ||
    !sameIdentity(named, directory.info)
  ) {
    throw new Error('gate5 summary: authority directory changed during publication')
  }
}

function pinnedEntryPath(directory: StableDirectory, path: string): string {
  if (dirname(path) !== directory.namedPath) {
    throw new Error('gate5 summary: entry is outside the pinned authority directory')
  }
  return join(directory.pinnedPath, basename(path))
}

function acquireKernelLock(file: FileHandle): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    const child = spawn('/usr/bin/flock', ['--exclusive', '--wait', '120', '3'], {
      stdio: ['ignore', 'ignore', 'pipe', file.fd],
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', (error) => {
      reject(new Error('gate5 summary: failed to start kernel lock helper', { cause: error }))
    })
    child.once('close', (code, signal) => {
      if (code === 0 && signal === null) {
        resolve()
        return
      }
      const detail = stderr.trim() || `code=${String(code)} signal=${String(signal)}`
      reject(new Error(`gate5 summary: kernel lock acquisition failed: ${detail}`))
    })
  })
}

async function acquireReconciliationLock(directory: StableDirectory): Promise<void> {
  // A named sibling lock can be unlinked/replaced while its old inode remains
  // flocked. The already-open directory inode has no such split lock domain.
  await assertDirectoryIdentity(directory)
  await acquireKernelLock(directory.handle)
  await assertDirectoryIdentity(directory)
}

async function writeRange(
  handle: FileHandle,
  bytes: Buffer,
  start: number,
  end: number,
): Promise<void> {
  let position = start
  while (position < end) {
    const { bytesWritten } = await handle.write(bytes, position, end - position, position)
    if (bytesWritten === 0) throw new Error('gate5 summary: staging write made no progress')
    position += bytesWritten
  }
}

/**
 * Publish the derived Gate 5 summary without ever exposing partial bytes at
 * its final authority path. A complete fsynced staging inode is hard-linked
 * no-clobber, the parent directory is fsynced, and only then is staging
 * unlinked.
 */
async function publishGate5SummaryInDirectory(
  input: {
    path: string
    bytes: string
    afterCheckpoint?: (checkpoint: Gate5SummaryPublishCheckpoint) => void | Promise<void>
  },
  directory: StableDirectory,
): Promise<void> {
  const expected = Buffer.from(input.bytes)
  if (expected.byteLength < 2) throw new Error('gate5 summary: expected bytes are incomplete')
  const finalPath = pinnedEntryPath(directory, input.path)
  const staging = join(
    directory.pinnedPath,
    `.${basename(input.path)}.staging-${process.pid}-${randomUUID()}`,
  )
  let stagingHandle: FileHandle | undefined
  let publicationError: unknown
  try {
    await assertDirectoryIdentity(directory)
    await directory.handle.sync()
    await assertDirectoryIdentity(directory)
    stagingHandle = await open(
      staging,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    )
    await assertDirectoryIdentity(directory)
    await input.afterCheckpoint?.('staging-created')
    await assertDirectoryIdentity(directory)
    const split = Math.max(1, Math.floor(expected.byteLength / 2))
    await writeRange(stagingHandle, expected, 0, split)
    await input.afterCheckpoint?.('staging-partial-written')
    await assertDirectoryIdentity(directory)
    await writeRange(stagingHandle, expected, split, expected.byteLength)
    await input.afterCheckpoint?.('staging-written')
    await assertDirectoryIdentity(directory)
    await stagingHandle.sync()
    await input.afterCheckpoint?.('staging-synced')
    await assertDirectoryIdentity(directory)
    await link(staging, finalPath)
    await input.afterCheckpoint?.('final-linked')
    await assertDirectoryIdentity(directory)
    await directory.handle.sync()
    await input.afterCheckpoint?.('directory-synced')
    await assertDirectoryIdentity(directory)
  } catch (error) {
    publicationError = error
  }

  let cleanupError: unknown
  try {
    const stagingAtPath = await lstatOrNull(staging)
    if (stagingAtPath !== null) {
      if (stagingHandle === undefined) {
        throw new Error('gate5 summary: staging identity is unavailable during cleanup')
      }
      const heldStaging = await stagingHandle.stat()
      if (!sameIdentity(stagingAtPath, heldStaging)) {
        throw new Error('gate5 summary: staging path changed before cleanup')
      }
      await assertDirectoryIdentity(directory)
      await unlink(staging)
      await directory.handle.sync()
      await assertDirectoryIdentity(directory)
    }
  } catch (error) {
    cleanupError = error
  }

  try {
    if (publicationError !== undefined) throw publicationError
    if (cleanupError !== undefined) throw cleanupError
    await assertDirectoryIdentity(directory)
    const published = await readStableFile(finalPath, 'published summary')
    if (
      published === null ||
      !published.pathPresent ||
      !published.bytes.equals(expected) ||
      published.info.nlink !== 1
    ) {
      throw new Error('gate5 summary: published authority does not contain the expected bytes')
    }
    await directory.handle.sync()
    await assertDirectoryIdentity(directory)
  } finally {
    await stagingHandle?.close().catch(() => {})
  }
}

export async function publishGate5Summary(input: {
  path: string
  bytes: string
  afterCheckpoint?: (checkpoint: Gate5SummaryPublishCheckpoint) => void | Promise<void>
}): Promise<void> {
  const directory = await openStableDirectory(dirname(input.path))
  try {
    await publishGate5SummaryInDirectory(input, directory)
  } finally {
    await directory.handle.close().catch(() => {})
  }
}

async function cleanupLinkedStaging(
  path: string,
  final: StableFile,
  directory: StableDirectory,
): Promise<void> {
  if (!final.pathPresent) {
    throw new Error('gate5 summary: complete final disappeared after read')
  }
  const prefix = `.${basename(path)}.staging-`
  const finalPath = pinnedEntryPath(directory, path)
  await assertDirectoryIdentity(directory)
  for (const entry of await readdir(directory.pinnedPath, { withFileTypes: true })) {
    if (!entry.name.startsWith(prefix)) continue
    const stagingPath = join(directory.pinnedPath, entry.name)
    const stagingInfo = await lstatOrNull(stagingPath)
    if (stagingInfo === null) continue
    if (sameIdentity(stagingInfo, final.info)) {
      assertRegularSummaryFile(stagingInfo, 'linked staging residue')
      try {
        await assertDirectoryIdentity(directory)
        await unlink(stagingPath)
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error
      }
      await assertDirectoryIdentity(directory)
    }
  }
  await directory.handle.sync()
  await assertDirectoryIdentity(directory)
  const cleaned = await readStableFile(finalPath, 'reconciled summary')
  if (
    cleaned === null ||
    !cleaned.pathPresent ||
    !cleaned.bytes.equals(final.bytes) ||
    cleaned.info.nlink !== 1
  ) {
    throw new Error('gate5 summary: final authority retains an unknown hard link')
  }
  const finalHandle = await open(finalPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const held = await finalHandle.stat()
    if (!sameIdentity(held, cleaned.info)) {
      throw new Error('gate5 summary: final authority changed before fsync')
    }
    await finalHandle.sync()
  } finally {
    await finalHandle.close()
  }
  await directory.handle.sync()
  await assertDirectoryIdentity(directory)
}

async function quarantineTornFinal(
  path: string,
  observed: StableFile,
  directory: StableDirectory,
): Promise<void> {
  const finalPath = pinnedEntryPath(directory, path)
  const residue = join(
    directory.pinnedPath,
    `.${basename(path)}.crash-residue-sha256-${createHash('sha256')
      .update(observed.bytes)
      .digest('hex')}`,
  )
  await assertDirectoryIdentity(directory)
  if ((await lstatOrNull(residue)) === null) {
    if (!observed.pathPresent) {
      throw new Error('gate5 summary: torn final disappeared without a controlled crash residue')
    }
    if (observed.info.nlink !== 1) {
      throw new Error('gate5 summary: torn final has an unknown hard link')
    }
    try {
      await assertDirectoryIdentity(directory)
      await link(finalPath, residue)
      await directory.handle.sync()
      await assertDirectoryIdentity(directory)
    } catch (error) {
      if (!isErrno(error, 'EEXIST') && !isErrno(error, 'ENOENT')) throw error
      if ((await lstatOrNull(residue)) === null) {
        throw new Error(
          'gate5 summary: torn final disappeared without a controlled crash residue',
          { cause: error },
        )
      }
    }
  }

  const readControlledResidue = async (): Promise<StableFile> => {
    const retained = await readStableFile(residue, 'summary crash residue')
    if (
      retained === null ||
      !retained.pathPresent ||
      !retained.bytes.equals(observed.bytes) ||
      !sameIdentity(retained.info, observed.info)
    ) {
      throw new Error('gate5 summary: crash residue does not match the observed torn inode')
    }
    return retained
  }
  const syncControlledResidue = async (): Promise<void> => {
    const residueHandle = await open(residue, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    try {
      await residueHandle.sync()
    } finally {
      await residueHandle.close()
    }
  }

  await readControlledResidue()
  const current = await readStableFile(finalPath, 'torn summary')
  if (current === null || !current.pathPresent) {
    if (
      current !== null &&
      (!current.bytes.equals(observed.bytes) || !sameIdentity(current.info, observed.info))
    ) {
      throw new Error('gate5 summary: torn final changed while its path disappeared')
    }
    const retained = await readControlledResidue()
    if (retained.info.nlink !== 1) {
      throw new Error('gate5 summary: crash residue retains an unknown hard link')
    }
    await syncControlledResidue()
    await directory.handle.sync()
    await assertDirectoryIdentity(directory)
    return
  }
  const retained = await readControlledResidue()
  if (
    !current.bytes.equals(observed.bytes) ||
    !sameIdentity(current.info, observed.info) ||
    !sameIdentity(current.info, retained.info)
  ) {
    throw new Error('gate5 summary: torn final changed before quarantine')
  }
  if (
    current.info.nlink === 2 &&
    retained.info.nlink === 1 &&
    (await lstatOrNull(finalPath)) === null
  ) {
    await syncControlledResidue()
    await directory.handle.sync()
    await assertDirectoryIdentity(directory)
    return
  }
  if (current.info.nlink !== 2 || retained.info.nlink !== 2) {
    throw new Error('gate5 summary: torn final has an unknown hard link')
  }
  await syncControlledResidue()
  try {
    await assertDirectoryIdentity(directory)
    await unlink(finalPath)
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error
  }
  await directory.handle.sync()
  await assertDirectoryIdentity(directory)
  const retainedAfter = await readControlledResidue()
  if (retainedAfter.info.nlink !== 1) {
    throw new Error('gate5 summary: crash residue retains an unknown hard link')
  }
}

/**
 * Reconcile a summary derived from already revalidated terminal/raw evidence.
 * Exact bytes are reused, an exact-prefix torn write is retained as
 * content-addressed crash residue and rebuilt, and every other mismatch fails
 * closed as evidence tampering.
 */
export async function reconcileGate5Summary(input: {
  path: string
  bytes: string
  afterLockAcquired?: () => void | Promise<void>
  afterFinalRead?: () => void | Promise<void>
  afterTornQuarantined?: () => void | Promise<void>
}): Promise<Gate5SummaryReconciliation> {
  const expected = Buffer.from(input.bytes)
  if (expected.byteLength < 2) throw new Error('gate5 summary: expected bytes are incomplete')
  const directory = await openStableDirectory(dirname(input.path))
  const finalPath = pinnedEntryPath(directory, input.path)
  let recovered = false
  let finalReadHookUsed = false
  try {
    await acquireReconciliationLock(directory)
    await input.afterLockAcquired?.()
    await assertDirectoryIdentity(directory)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await assertDirectoryIdentity(directory)
      const afterRead =
        input.afterFinalRead === undefined || finalReadHookUsed
          ? undefined
          : async () => {
              finalReadHookUsed = true
              await input.afterFinalRead!()
            }
      const current = await readStableFile(finalPath, 'final summary', afterRead)
      await assertDirectoryIdentity(directory)
      if (current !== null) {
        if (current.bytes.equals(expected)) {
          await cleanupLinkedStaging(input.path, current, directory)
          await assertDirectoryIdentity(directory)
          return recovered ? 'recovered' : 'reused'
        }
        if (
          current.bytes.byteLength < expected.byteLength &&
          expected.subarray(0, current.bytes.byteLength).equals(current.bytes)
        ) {
          await quarantineTornFinal(input.path, current, directory)
          recovered = true
          await input.afterTornQuarantined?.()
          await assertDirectoryIdentity(directory)
          continue
        }
        throw new Error(
          'gate5 summary: existing final does not match the reconstructed terminal evidence',
        )
      }
      try {
        await publishGate5SummaryInDirectory({ path: input.path, bytes: input.bytes }, directory)
        await assertDirectoryIdentity(directory)
        return recovered ? 'recovered' : 'published'
      } catch (error) {
        if (isErrno(error, 'EEXIST')) continue
        throw error
      }
    }
    throw new Error('gate5 summary: concurrent publication did not converge')
  } finally {
    await directory.handle.close()
  }
}
