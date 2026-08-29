import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reconcileGate5Summary, type Gate5SummaryPublishCheckpoint } from '../src/gate5-summary.js'

let root: string | undefined
const worker = fileURLToPath(new URL('./fixtures/gate5-summary-worker.mjs', import.meta.url))

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gate5-summary-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const summaryBytes =
  JSON.stringify(
    {
      schemaVersion: 2,
      protocol: 'gate5-host-credential-broker-v2',
      runId: 'gate5-summary-fixture',
      collectedTrials: 1,
      reconciledFromTerminalRaw: true,
    },
    null,
    2,
  ) + '\n'

const conflictingSummaryBytes =
  JSON.stringify(
    {
      schemaVersion: 2,
      protocol: 'gate5-host-credential-broker-v2',
      runId: 'gate5-summary-conflicting-fixture',
      collectedTrials: 1,
      reconciledFromTerminalRaw: true,
    },
    null,
    2,
  ) + '\n'

async function readOrNull(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
}

async function crashPublication(
  path: string,
  checkpoint: Gate5SummaryPublishCheckpoint,
): Promise<void> {
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [worker], {
        env: {
          ...process.env,
          DSH_GATE5_SUMMARY_PATH: path,
          DSH_GATE5_SUMMARY_BYTES: summaryBytes,
          DSH_GATE5_SUMMARY_KILL_AT: checkpoint,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })
      child.once('error', reject)
      child.once('close', (code, signal) => {
        if (code !== null || signal !== 'SIGKILL') {
          reject(
            new Error(
              `worker did not stop at ${checkpoint}: code=${code} signal=${signal}\n${stderr}`,
            ),
          )
          return
        }
        resolve({ code, signal })
      })
    },
  )
  expect(result).toEqual({ code: null, signal: 'SIGKILL' })
}

async function reconcileInChild(path: string, bytes = summaryBytes): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [worker], {
      env: {
        ...process.env,
        DSH_GATE5_SUMMARY_MODE: 'reconcile',
        DSH_GATE5_SUMMARY_PATH: path,
        DSH_GATE5_SUMMARY_BYTES: bytes,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code !== 0 || signal !== null) {
        reject(
          new Error(
            `reconcile worker failed: code=${String(code)} signal=${String(signal)}\n${stderr}`,
          ),
        )
        return
      }
      resolve(stdout.trim())
    })
  })
}

async function canAcquireDirectoryLock(path: string): Promise<boolean> {
  const directory = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  )
  try {
    return await new Promise<boolean>((resolve, reject) => {
      let stderr = ''
      const child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], {
        stdio: ['ignore', 'ignore', 'pipe', directory.fd],
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })
      child.once('error', reject)
      child.once('close', (code, signal) => {
        if (signal !== null || (code !== 0 && code !== 1)) {
          reject(
            new Error(
              `directory lock probe failed: code=${String(code)} signal=${String(signal)} ${stderr}`,
            ),
          )
          return
        }
        resolve(code === 0)
      })
    })
  } finally {
    await directory.close()
  }
}

async function crashReconciliationLock(path: string): Promise<void> {
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [worker], {
        env: {
          ...process.env,
          DSH_GATE5_SUMMARY_MODE: 'crash-reconcile-lock',
          DSH_GATE5_SUMMARY_PATH: path,
          DSH_GATE5_SUMMARY_BYTES: summaryBytes,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })
      child.once('error', reject)
      child.once('close', (code, signal) => {
        if (code !== null || signal !== 'SIGKILL') {
          reject(
            new Error(
              `lock worker did not stop: code=${String(code)} signal=${String(signal)}\n${stderr}`,
            ),
          )
          return
        }
        resolve({ code, signal })
      })
    },
  )
  expect(result).toEqual({ code: null, signal: 'SIGKILL' })
}

describe('Gate 5 summary crash/replay publication', () => {
  it('exposes either no final summary or all bytes at every publication checkpoint', async () => {
    const checkpoints: Gate5SummaryPublishCheckpoint[] = [
      'staging-created',
      'staging-partial-written',
      'staging-written',
      'staging-synced',
      'final-linked',
      'directory-synced',
    ]

    for (const checkpoint of checkpoints) {
      const directory = join(root!, checkpoint)
      const path = join(directory, 'summary.json')
      await mkdir(directory, { mode: 0o700 })
      await crashPublication(path, checkpoint)

      const afterCrash = await readOrNull(path)
      if (checkpoint === 'final-linked' || checkpoint === 'directory-synced') {
        expect(afterCrash).toBe(summaryBytes)
      } else {
        expect(afterCrash).toBeNull()
      }

      await expect(reconcileGate5Summary({ path, bytes: summaryBytes })).resolves.toMatch(
        /^(published|reused)$/,
      )
      await expect(reconcileGate5Summary({ path, bytes: summaryBytes })).resolves.toBe('reused')
      expect(await readFile(path, 'utf8')).toBe(summaryBytes)
      expect((await lstat(path)).nlink).toBe(1)
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      const staging = (await readdir(directory)).filter((name) => name.includes('.staging-'))
      if (checkpoint === 'final-linked' || checkpoint === 'directory-synced') {
        expect(staging).toEqual([])
      } else {
        expect(staging).toHaveLength(1)
        const residue = await readFile(join(directory, staging[0]!))
        expect(Buffer.from(summaryBytes).subarray(0, residue.byteLength)).toEqual(residue)
        expect((await lstat(join(directory, staging[0]!))).ino).not.toBe((await lstat(path)).ino)
      }
    }

    const lockDirectory = join(root!, 'reconciliation-lock-crash')
    const lockSummary = join(lockDirectory, 'summary.json')
    await mkdir(lockDirectory, { mode: 0o700 })
    const directoryBefore = await lstat(lockDirectory)
    await crashReconciliationLock(lockSummary)
    await expect(reconcileGate5Summary({ path: lockSummary, bytes: summaryBytes })).resolves.toBe(
      'published',
    )
    const directoryAfter = await lstat(lockDirectory)
    expect([directoryAfter.dev, directoryAfter.ino]).toEqual([
      directoryBefore.dev,
      directoryBefore.ino,
    ])
    expect(await readdir(lockDirectory)).toEqual(['summary.json'])
  })

  it('recovers exact-prefix torn final summaries and converges on repeated resume', async () => {
    const expected = Buffer.from(summaryBytes)
    const prefixes = [expected.subarray(0, 0), expected.subarray(0, 2), expected.subarray(0, 41)]

    for (const [index, prefix] of prefixes.entries()) {
      const directory = join(root!, `torn-${index}`)
      const path = join(directory, 'summary.json')
      await mkdir(directory, { mode: 0o700 })
      await writeFile(path, prefix, { mode: 0o600, flag: 'wx' })

      await expect(reconcileGate5Summary({ path, bytes: summaryBytes })).resolves.toBe('recovered')
      expect(await readFile(path, 'utf8')).toBe(summaryBytes)
      await expect(reconcileGate5Summary({ path, bytes: summaryBytes })).resolves.toBe('reused')

      const residue = (await readdir(directory)).filter((name) =>
        name.startsWith('.summary.json.crash-residue-sha256-'),
      )
      expect(residue).toHaveLength(1)
      expect(await readFile(join(directory, residue[0]!))).toEqual(prefix)
    }

    const controlledDirectory = join(root!, 'controlled-read-disappearance')
    const controlledPath = join(controlledDirectory, 'summary.json')
    const controlledPrefix = expected.subarray(0, 41)
    const controlledResidue = join(
      controlledDirectory,
      `.summary.json.crash-residue-sha256-${createHash('sha256')
        .update(controlledPrefix)
        .digest('hex')}`,
    )
    await mkdir(controlledDirectory, { mode: 0o700 })
    await writeFile(controlledPath, controlledPrefix, { mode: 0o600, flag: 'wx' })
    await expect(
      reconcileGate5Summary({
        path: controlledPath,
        bytes: summaryBytes,
        async afterFinalRead() {
          await link(controlledPath, controlledResidue)
          await unlink(controlledPath)
        },
      }),
    ).resolves.toBe('recovered')
    expect(await readFile(controlledPath, 'utf8')).toBe(summaryBytes)
    expect(await readFile(controlledResidue)).toEqual(controlledPrefix)
    expect((await lstat(controlledResidue)).nlink).toBe(1)
  })

  it('finishes cleanup after a crash between no-clobber link and staging unlink', async () => {
    const directory = join(root!, 'linked-staging')
    const path = join(directory, 'summary.json')
    const staging = join(directory, '.summary.json.staging-999-crash')
    await mkdir(directory, { mode: 0o700 })
    await writeFile(staging, summaryBytes, { mode: 0o600, flag: 'wx' })
    await link(staging, path)
    expect((await lstat(path)).nlink).toBe(2)

    await expect(reconcileGate5Summary({ path, bytes: summaryBytes })).resolves.toBe('reused')
    expect(await stat(staging).catch(() => null)).toBeNull()
    expect(await readFile(path, 'utf8')).toBe(summaryBytes)
    expect((await lstat(path)).nlink).toBe(1)
  })

  it('rejects content tampering and uncontrolled read-after-open disappearance', async () => {
    for (const [name, bytes] of [
      ['malformed', Buffer.from('not-json\n')],
      ['valid-json', Buffer.from('{"schemaVersion":2,"tampered":true}\n')],
    ] as const) {
      const directory = join(root!, name)
      const path = join(directory, 'summary.json')
      await mkdir(directory, { mode: 0o700 })
      await writeFile(path, bytes, { mode: 0o600, flag: 'wx' })
      await expect(reconcileGate5Summary({ path, bytes: summaryBytes })).rejects.toThrow(
        /does not match the reconstructed terminal evidence/,
      )
      expect(await readFile(path)).toEqual(bytes)
    }

    for (const withUnknownHardlink of [false, true]) {
      const directory = join(root!, `uncontrolled-disappearance-${withUnknownHardlink}`)
      const path = join(directory, 'summary.json')
      const alias = join(directory, 'unknown-hardlink')
      const prefix = Buffer.from(summaryBytes).subarray(0, 41)
      await mkdir(directory, { mode: 0o700 })
      await writeFile(path, prefix, { mode: 0o600, flag: 'wx' })
      if (withUnknownHardlink) await link(path, alias)
      await expect(
        reconcileGate5Summary({
          path,
          bytes: summaryBytes,
          async afterFinalRead() {
            await unlink(path)
          },
        }),
      ).rejects.toThrow(/disappeared without a controlled crash residue/)
      expect(await stat(path).catch(() => null)).toBeNull()
      expect(
        (await readdir(directory)).filter((name) =>
          name.startsWith('.summary.json.crash-residue-sha256-'),
        ),
      ).toEqual([])
      if (withUnknownHardlink) {
        expect(await readFile(alias)).toEqual(prefix)
        expect((await lstat(alias)).nlink).toBe(1)
      }
    }

    const replacementDirectory = join(root!, 'read-replacement')
    const replacementPath = join(replacementDirectory, 'summary.json')
    const replacementPrefix = Buffer.from(summaryBytes).subarray(0, 41)
    await mkdir(replacementDirectory, { mode: 0o700 })
    await writeFile(replacementPath, replacementPrefix, { mode: 0o600, flag: 'wx' })
    await expect(
      reconcileGate5Summary({
        path: replacementPath,
        bytes: summaryBytes,
        async afterFinalRead() {
          await unlink(replacementPath)
          await writeFile(replacementPath, replacementPrefix, { mode: 0o600, flag: 'wx' })
        },
      }),
    ).rejects.toThrow(/identity changed during read/)

    const linkedDirectory = join(root!, 'unknown-hardlink-before-recovery')
    const linkedPath = join(linkedDirectory, 'summary.json')
    const linkedAlias = join(linkedDirectory, 'unknown-hardlink')
    await mkdir(linkedDirectory, { mode: 0o700 })
    await writeFile(linkedPath, replacementPrefix, { mode: 0o600, flag: 'wx' })
    await link(linkedPath, linkedAlias)
    await expect(reconcileGate5Summary({ path: linkedPath, bytes: summaryBytes })).rejects.toThrow(
      /unknown hard link/,
    )
    expect((await lstat(linkedPath)).nlink).toBe(2)

    const forgedDirectory = join(root!, 'forged-residue')
    const forgedPath = join(forgedDirectory, 'summary.json')
    const forgedResidue = join(
      forgedDirectory,
      `.summary.json.crash-residue-sha256-${createHash('sha256')
        .update(replacementPrefix)
        .digest('hex')}`,
    )
    await mkdir(forgedDirectory, { mode: 0o700 })
    await writeFile(forgedPath, replacementPrefix, { mode: 0o600, flag: 'wx' })
    await writeFile(forgedResidue, replacementPrefix, { mode: 0o600, flag: 'wx' })
    await expect(reconcileGate5Summary({ path: forgedPath, bytes: summaryBytes })).rejects.toThrow(
      /does not match the observed torn inode/,
    )

    const authorityDirectory = join(root!, 'authority-directory')
    const movedAuthority = join(root!, 'authority-directory-moved')
    const authorityPath = join(authorityDirectory, 'summary.json')
    await mkdir(authorityDirectory, { mode: 0o700 })
    await writeFile(authorityPath, replacementPrefix, { mode: 0o600, flag: 'wx' })
    await expect(
      reconcileGate5Summary({
        path: authorityPath,
        bytes: summaryBytes,
        async afterTornQuarantined() {
          await rename(authorityDirectory, movedAuthority)
          await mkdir(authorityDirectory, { mode: 0o700 })
        },
      }),
    ).rejects.toThrow(/authority directory changed/)
    expect(await readdir(authorityDirectory)).toEqual([])
    expect(
      (await readdir(movedAuthority)).some((name) =>
        name.startsWith('.summary.json.crash-residue-sha256-'),
      ),
    ).toBe(true)
  })

  it('keeps cross-process reconciliation on the pinned authority-directory lock inode', async () => {
    for (const attack of ['replace-obsolete-lock', 'hardlink-directory'] as const) {
      const directory = join(root!, `directory-lock-${attack}`)
      const path = join(directory, 'summary.json')
      const obsoleteLock = join(directory, '.summary.json.reconcile.lock')
      await mkdir(directory, { mode: 0o700 })
      await writeFile(obsoleteLock, '', { mode: 0o600, flag: 'wx' })
      const obsoleteBefore = await lstat(obsoleteLock)

      let child: Promise<string> | undefined
      await expect(
        reconcileGate5Summary({
          path,
          bytes: summaryBytes,
          async afterLockAcquired() {
            if (attack === 'replace-obsolete-lock') {
              await link(obsoleteLock, join(directory, '.obsolete-lock-retained'))
              await unlink(obsoleteLock)
              await writeFile(obsoleteLock, '', { mode: 0o600, flag: 'wx' })
              expect((await lstat(obsoleteLock)).ino).not.toBe(obsoleteBefore.ino)
            } else {
              await expect(
                link(directory, join(root!, 'forbidden-directory-hardlink')),
              ).rejects.toMatchObject({ code: 'EPERM' })
            }
            await expect(canAcquireDirectoryLock(directory)).resolves.toBe(false)
            child = reconcileInChild(path, conflictingSummaryBytes)
          },
        }),
      ).resolves.toBe('published')

      expect(child).toBeDefined()
      await expect(child!).rejects.toThrow(/existing final does not match/)
      expect(await readFile(path, 'utf8')).toBe(summaryBytes)
      expect((await lstat(path)).nlink).toBe(1)
    }
  })

  it('publishes no-clobber under concurrent reconciliation', async () => {
    for (let iteration = 0; iteration < 12; iteration += 1) {
      const directory = join(root!, `concurrent-${iteration}`)
      const path = join(directory, 'summary.json')
      await mkdir(directory, { mode: 0o700 })
      const results = await Promise.all([
        reconcileGate5Summary({ path, bytes: summaryBytes }),
        reconcileGate5Summary({ path, bytes: summaryBytes }),
      ])
      expect(results.sort()).toEqual(['published', 'reused'])
      expect(await readFile(path, 'utf8')).toBe(summaryBytes)
      expect((await lstat(path)).nlink).toBe(1)

      const tornDirectory = join(root!, `concurrent-torn-${iteration}`)
      const tornPath = join(tornDirectory, 'summary.json')
      await mkdir(tornDirectory, { mode: 0o700 })
      await writeFile(tornPath, Buffer.from(summaryBytes).subarray(0, 2), {
        mode: 0o600,
        flag: 'wx',
      })
      const recovered = await Promise.all([
        reconcileGate5Summary({ path: tornPath, bytes: summaryBytes }),
        reconcileGate5Summary({ path: tornPath, bytes: summaryBytes }),
      ])
      expect(recovered).toContain('recovered')
      expect(await readFile(tornPath, 'utf8')).toBe(summaryBytes)
      expect((await lstat(tornPath)).nlink).toBe(1)
    }

    const processDirectory = join(root!, 'concurrent-processes')
    const processPath = join(processDirectory, 'summary.json')
    await mkdir(processDirectory, { mode: 0o700 })
    expect(
      (await Promise.all([reconcileInChild(processPath), reconcileInChild(processPath)])).sort(),
    ).toEqual(['published', 'reused'])

    const tornProcessDirectory = join(root!, 'concurrent-torn-processes')
    const tornProcessPath = join(tornProcessDirectory, 'summary.json')
    await mkdir(tornProcessDirectory, { mode: 0o700 })
    await writeFile(tornProcessPath, Buffer.from(summaryBytes).subarray(0, 41), {
      mode: 0o600,
      flag: 'wx',
    })
    expect(
      (
        await Promise.all([reconcileInChild(tornProcessPath), reconcileInChild(tornProcessPath)])
      ).sort(),
    ).toEqual(['recovered', 'reused'])
  })
})
