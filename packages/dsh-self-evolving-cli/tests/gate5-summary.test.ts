import { spawn } from 'node:child_process'
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
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

  it('rejects malformed or valid-JSON tampering that is not an exact expected prefix', async () => {
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
  })
})
