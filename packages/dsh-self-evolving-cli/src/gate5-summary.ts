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

async function openStableDirectory(path: string): Promise<{ handle: FileHandle; info: Stats }> {
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
    return { handle, info: held }
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
  }
}

async function assertDirectoryIdentity(path: string, expected: Stats): Promise<void> {
  const current = await lstat(path)
  if (!current.isDirectory() || !sameIdentity(current, expected)) {
    throw new Error('gate5 summary: authority directory changed during publication')
  }
}

async function verifyReconciliationLock(path: string, handle: FileHandle): Promise<void> {
  const [held, named] = await Promise.all([handle.stat(), lstat(path)])
  assertRegularSummaryFile(held, 'reconciliation lock')
  assertRegularSummaryFile(named, 'reconciliation lock')
  if (
    !sameIdentity(held, named) ||
    held.nlink !== 1 ||
    named.nlink !== 1 ||
    held.size !== 0 ||
    named.size !== 0
  ) {
    throw new Error('gate5 summary: reconciliation lock identity changed')
  }
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

async function acquireReconciliationLock(input: {
  summaryPath: string
  directoryHandle: FileHandle
  directoryInfo: Stats
}): Promise<FileHandle> {
  const directory = dirname(input.summaryPath)
  const lockPath = join(directory, `.${basename(input.summaryPath)}.reconcile.lock`)
  const lock = await open(
    lockPath,
    fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
    0o600,
  )
  try {
    await verifyReconciliationLock(lockPath, lock)
    await lock.sync()
    await input.directoryHandle.sync()
    await assertDirectoryIdentity(directory, input.directoryInfo)
    await acquireKernelLock(lock)
    await verifyReconciliationLock(lockPath, lock)
    await assertDirectoryIdentity(directory, input.directoryInfo)
    return lock
  } catch (error) {
    await lock.close().catch(() => {})
    throw error
  }
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
export async function publishGate5Summary(input: {
  path: string
  bytes: string
  afterCheckpoint?: (checkpoint: Gate5SummaryPublishCheckpoint) => void | Promise<void>
}): Promise<void> {
  const expected = Buffer.from(input.bytes)
  if (expected.byteLength < 2) throw new Error('gate5 summary: expected bytes are incomplete')
  const directory = dirname(input.path)
  const { handle: directoryHandle, info: directoryInfo } = await openStableDirectory(directory)
  const staging = join(directory, `.${basename(input.path)}.staging-${process.pid}-${randomUUID()}`)
  let stagingHandle: FileHandle | undefined
  let publicationError: unknown
  try {
    await directoryHandle.sync()
    stagingHandle = await open(
      staging,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    )
    await input.afterCheckpoint?.('staging-created')
    const split = Math.max(1, Math.floor(expected.byteLength / 2))
    await writeRange(stagingHandle, expected, 0, split)
    await input.afterCheckpoint?.('staging-partial-written')
    await writeRange(stagingHandle, expected, split, expected.byteLength)
    await input.afterCheckpoint?.('staging-written')
    await stagingHandle.sync()
    await input.afterCheckpoint?.('staging-synced')
    await link(staging, input.path)
    await input.afterCheckpoint?.('final-linked')
    await directoryHandle.sync()
    await input.afterCheckpoint?.('directory-synced')
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
      await unlink(staging)
      await directoryHandle.sync()
    }
  } catch (error) {
    cleanupError = error
  }

  try {
    if (publicationError !== undefined) throw publicationError
    if (cleanupError !== undefined) throw cleanupError
    await assertDirectoryIdentity(directory, directoryInfo)
    const published = await readStableFile(input.path, 'published summary')
    if (
      published === null ||
      !published.pathPresent ||
      !published.bytes.equals(expected) ||
      published.info.nlink !== 1
    ) {
      throw new Error('gate5 summary: published authority does not contain the expected bytes')
    }
    await directoryHandle.sync()
    await assertDirectoryIdentity(directory, directoryInfo)
  } finally {
    await stagingHandle?.close().catch(() => {})
    await directoryHandle.close().catch(() => {})
  }
}

async function cleanupLinkedStaging(path: string, final: StableFile): Promise<void> {
  if (!final.pathPresent) {
    throw new Error('gate5 summary: complete final disappeared after read')
  }
  const directory = dirname(path)
  const prefix = `.${basename(path)}.staging-`
  const { handle: directoryHandle, info: directoryInfo } = await openStableDirectory(directory)
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.name.startsWith(prefix)) continue
      const stagingPath = join(directory, entry.name)
      const stagingInfo = await lstatOrNull(stagingPath)
      if (stagingInfo === null) continue
      if (sameIdentity(stagingInfo, final.info)) {
        assertRegularSummaryFile(stagingInfo, 'linked staging residue')
        try {
          await unlink(stagingPath)
        } catch (error) {
          if (!isErrno(error, 'ENOENT')) throw error
        }
      }
    }
    await directoryHandle.sync()
    await assertDirectoryIdentity(directory, directoryInfo)
    const cleaned = await readStableFile(path, 'reconciled summary')
    if (
      cleaned === null ||
      !cleaned.pathPresent ||
      !cleaned.bytes.equals(final.bytes) ||
      cleaned.info.nlink !== 1
    ) {
      throw new Error('gate5 summary: final authority retains an unknown hard link')
    }
    const finalHandle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    try {
      const held = await finalHandle.stat()
      if (!sameIdentity(held, cleaned.info)) {
        throw new Error('gate5 summary: final authority changed before fsync')
      }
      await finalHandle.sync()
    } finally {
      await finalHandle.close()
    }
    await directoryHandle.sync()
    await assertDirectoryIdentity(directory, directoryInfo)
  } finally {
    await directoryHandle.close()
  }
}

async function quarantineTornFinal(path: string, observed: StableFile): Promise<void> {
  const directory = dirname(path)
  const residue = join(
    directory,
    `.${basename(path)}.crash-residue-sha256-${createHash('sha256')
      .update(observed.bytes)
      .digest('hex')}`,
  )
  const { handle: directoryHandle, info: directoryInfo } = await openStableDirectory(directory)
  try {
    if ((await lstatOrNull(residue)) === null) {
      if (!observed.pathPresent) {
        throw new Error('gate5 summary: torn final disappeared without a controlled crash residue')
      }
      if (observed.info.nlink !== 1) {
        throw new Error('gate5 summary: torn final has an unknown hard link')
      }
      try {
        await link(path, residue)
        await directoryHandle.sync()
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
    const current = await readStableFile(path, 'torn summary')
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
      await directoryHandle.sync()
      await assertDirectoryIdentity(directory, directoryInfo)
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
      (await lstatOrNull(path)) === null
    ) {
      await syncControlledResidue()
      await directoryHandle.sync()
      await assertDirectoryIdentity(directory, directoryInfo)
      return
    }
    if (current.info.nlink !== 2 || retained.info.nlink !== 2) {
      throw new Error('gate5 summary: torn final has an unknown hard link')
    }
    await syncControlledResidue()
    try {
      await unlink(path)
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error
    }
    await directoryHandle.sync()
    await assertDirectoryIdentity(directory, directoryInfo)
    const retainedAfter = await readControlledResidue()
    if (retainedAfter.info.nlink !== 1) {
      throw new Error('gate5 summary: crash residue retains an unknown hard link')
    }
  } finally {
    await directoryHandle.close()
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
  const directory = dirname(input.path)
  const { handle: directoryHandle, info: directoryInfo } = await openStableDirectory(directory)
  let reconciliationLock: FileHandle | undefined
  let recovered = false
  let finalReadHookUsed = false
  try {
    reconciliationLock = await acquireReconciliationLock({
      summaryPath: input.path,
      directoryHandle,
      directoryInfo,
    })
    await input.afterLockAcquired?.()
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await assertDirectoryIdentity(directory, directoryInfo)
      const afterRead =
        input.afterFinalRead === undefined || finalReadHookUsed
          ? undefined
          : async () => {
              finalReadHookUsed = true
              await input.afterFinalRead!()
            }
      const current = await readStableFile(input.path, 'final summary', afterRead)
      if (current !== null) {
        if (current.bytes.equals(expected)) {
          await cleanupLinkedStaging(input.path, current)
          await assertDirectoryIdentity(directory, directoryInfo)
          return recovered ? 'recovered' : 'reused'
        }
        if (
          current.bytes.byteLength < expected.byteLength &&
          expected.subarray(0, current.bytes.byteLength).equals(current.bytes)
        ) {
          await quarantineTornFinal(input.path, current)
          recovered = true
          await input.afterTornQuarantined?.()
          await assertDirectoryIdentity(directory, directoryInfo)
          continue
        }
        throw new Error(
          'gate5 summary: existing final does not match the reconstructed terminal evidence',
        )
      }
      try {
        await publishGate5Summary({ path: input.path, bytes: input.bytes })
        await assertDirectoryIdentity(directory, directoryInfo)
        return recovered ? 'recovered' : 'published'
      } catch (error) {
        if (isErrno(error, 'EEXIST')) continue
        throw error
      }
    }
    throw new Error('gate5 summary: concurrent publication did not converge')
  } finally {
    await reconciliationLock?.close().catch(() => {})
    await directoryHandle.close()
  }
}
