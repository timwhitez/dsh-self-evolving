import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { computeTotals, reserve, type BudgetLedger, type BudgetLimits } from '../src/index.js'

let root: string | undefined
const holders = new Set<ChildProcessWithoutNullStreams>()

const LIMITS: BudgetLimits = {
  usd: 10,
  solverTokens: 1_000_000,
  proposerTokens: 500_000,
  taskTrials: 100,
  proposalCalls: 50,
  wallClockSec: 57_600,
  concurrencySlots: 4,
  storageBytes: 10_000_000_000,
}

const HOLDER_READY = 'TEST_BUDGET_LOCK_READY\n'
const HOLDER_SOURCE =
  `process.stdout.write(${JSON.stringify(HOLDER_READY)});` +
  "process.stdin.resume();process.stdin.once('end',()=>process.exit(0));"

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-budget-stale-lock-'))
})

afterEach(async () => {
  for (const holder of holders) {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL')
  }
  holders.clear()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function ledger(): BudgetLedger {
  return { ledgerPath: join(root!, 'budget-ledger.jsonl'), limits: LIMITS }
}

async function writeLock(raw: string): Promise<string> {
  const path = `${ledger().ledgerPath}.lock`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, raw, { mode: 0o600 })
  return path
}

async function currentProcessStartTicks(): Promise<string> {
  const raw = await readFile(`/proc/${process.pid}/stat`, 'utf8')
  const close = raw.lastIndexOf(') ')
  const start = raw
    .slice(close + 2)
    .trim()
    .split(/\s+/)[19]
  if (close === -1 || start === undefined || !/^\d+$/.test(start)) {
    throw new Error('test: cannot read current process start identity')
  }
  return start
}

function closeOutcome(
  child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
}

async function startExternalHolder(lockPath: string): Promise<{
  child: ChildProcessWithoutNullStreams
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}> {
  await mkdir(dirname(lockPath), { recursive: true })
  const child = spawn(
    '/usr/bin/flock',
    [
      '--exclusive',
      '--nonblock',
      '--no-fork',
      '--',
      lockPath,
      process.execPath,
      '--input-type=commonjs',
      '--eval',
      HOLDER_SOURCE,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  holders.add(child)
  child.stdin.on('error', () => undefined)
  const closed = closeOutcome(child)
  await new Promise<void>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (stdout.includes(HOLDER_READY)) resolve()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      reject(
        new Error(
          `test lock holder exited before ready: code=${String(code)} signal=${String(signal)} ${stderr}`,
        ),
      )
    })
  })
  return { child, closed }
}

async function stopHolder(
  holder: Awaited<ReturnType<typeof startExternalHolder>>,
  signal?: NodeJS.Signals,
): Promise<void> {
  if (signal === undefined) holder.child.stdin.end()
  else holder.child.kill(signal)
  await holder.closed
  holders.delete(holder.child)
}

async function runProcess(
  file: string,
  args: string[],
): Promise<{
  code: number | null
  signal: NodeJS.Signals | null
  stderr: string
}> {
  const child = spawn(file, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stderr }))
  })
}

async function probeKernelLock(lockPath: string): Promise<boolean> {
  const result = await runProcess('/usr/bin/flock', [
    '--exclusive',
    '--nonblock',
    '--',
    lockPath,
    '/bin/true',
  ])
  if (result.code === 0 && result.signal === null) return false
  if (result.code === 1 && result.signal === null) return true
  throw new Error(
    `test lock probe failed: code=${String(result.code)} signal=${String(result.signal)} ${result.stderr}`,
  )
}

async function waitForKernelLock(lockPath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await probeKernelLock(lockPath)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('test: budget mutation lock was not acquired in time')
}

/**
 * Kernel lock release after a holder's SIGKILL is asynchronous (fd teardown),
 * so an immediate probe can still observe the lock under load. Poll with a
 * bounded deadline instead of asserting instantaneous release (issue #191).
 */
async function waitForKernelLockRelease(lockPath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!(await probeKernelLock(lockPath))) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('test: budget mutation lock was not released in time')
}

describe('budget OS mutation lock recovery', () => {
  it('ignores a stale legacy PID record because ownership is kernel-backed', async () => {
    const lockPath = await writeLock('2147483647\n')

    await reserve(ledger(), 'legacy-after-crash', 'usd', 1)

    expect(await readFile(lockPath, 'utf8')).toBe('')
    expect((await computeTotals(ledger())).totals.reserved.usd).toBe(1)
  })

  it('does not mistake PID reuse text for a live lock owner', async () => {
    const reusedPidRecord =
      JSON.stringify({
        pid: process.pid,
        processStartTicks: '0',
        acquiredAt: '2026-08-23T00:00:00.000Z',
      }) + '\n'
    await writeLock(reusedPidRecord)

    await reserve(ledger(), 'pid-reuse-safe', 'usd', 1)

    expect((await computeTotals(ledger())).totals.reserved.usd).toBe(1)
  })

  it('fails closed while a compatible legacy owner identity is still alive', async () => {
    const activeRecord =
      JSON.stringify({
        pid: process.pid,
        processStartTicks: await currentProcessStartTicks(),
        acquiredAt: '2026-08-23T00:00:00.000Z',
      }) + '\n'
    const lockPath = await writeLock(activeRecord)

    await expect(reserve(ledger(), 'cross-version-contender', 'usd', 1)).rejects.toThrow(
      /locked by legacy pid/,
    )

    expect(await readFile(lockPath, 'utf8')).toBe(activeRecord)
    expect((await computeTotals(ledger())).entries).toEqual([])
  })

  it('fails closed for malformed legacy ownership evidence', async () => {
    const malformed = '{not-json\n'
    const lockPath = await writeLock(malformed)

    await expect(reserve(ledger(), 'malformed-contender', 'usd', 1)).rejects.toThrow(
      /no verifiable owner identity/,
    )

    expect(await readFile(lockPath, 'utf8')).toBe(malformed)
  })

  it('rejects a lock-path symlink without touching its target', async () => {
    const target = join(root!, 'unrelated-target')
    await writeFile(target, 'do not touch\n', { mode: 0o640 })
    const before = await stat(target)
    const lockPath = `${ledger().ledgerPath}.lock`
    await symlink(target, lockPath)

    await expect(reserve(ledger(), 'symlink-contender', 'usd', 1)).rejects.toMatchObject({
      code: 'ELOOP',
    })

    expect(await readFile(target, 'utf8')).toBe('do not touch\n')
    expect((await stat(target)).mode).toBe(before.mode)
  })

  it('rejects a contender while another process holds the kernel lock', async () => {
    const lockPath = await writeLock('')
    const holder = await startExternalHolder(lockPath)

    await expect(reserve(ledger(), 'contender', 'usd', 1)).rejects.toThrow(/already locked/)
    expect((await computeTotals(ledger())).entries).toEqual([])

    await stopHolder(holder)
  })

  it('recovers immediately after a SIGKILL while the lock is held', async () => {
    const currentLedger = ledger()
    const lockPath = `${currentLedger.ledgerPath}.lock`
    const fifo = await runProcess('/usr/bin/mkfifo', [currentLedger.ledgerPath])
    expect(fifo, fifo.stderr).toMatchObject({ code: 0, signal: null })
    const coreUrl = new URL('../lib/index.js', import.meta.url).href
    const workerSource = `import { reserve } from ${JSON.stringify(coreUrl)};await reserve(JSON.parse(process.argv[1]),'crash-owner','usd',1)`
    const worker = spawn(
      process.execPath,
      ['--input-type=module', '--eval', workerSource, JSON.stringify(currentLedger)],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    holders.add(worker)
    let stderr = ''
    worker.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    const closed = closeOutcome(worker)

    await waitForKernelLock(lockPath)
    worker.kill('SIGKILL')
    const outcome = await closed
    holders.delete(worker)
    expect(outcome, stderr).toMatchObject({ code: null, signal: 'SIGKILL' })
    await waitForKernelLockRelease(lockPath)

    await rm(currentLedger.ledgerPath)
    await reserve(currentLedger, 'after-process-death', 'usd', 1)

    expect((await computeTotals(currentLedger)).totals.reserved.usd).toBe(1)
  })

  it('never unlinks a newly acquired owner while recovering an old death', async () => {
    const lockPath = await writeLock('')
    const originalInode = (await stat(lockPath)).ino
    const oldHolder = await startExternalHolder(lockPath)
    await stopHolder(oldHolder, 'SIGKILL')
    const newHolder = await startExternalHolder(lockPath)

    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        expect(reserve(ledger(), `contender-${index}`, 'usd', 1)).rejects.toThrow(/already locked/),
      ),
    )
    expect((await stat(lockPath)).ino).toBe(originalInode)
    expect((await computeTotals(ledger())).entries).toEqual([])

    await stopHolder(newHolder)
    await reserve(ledger(), 'after-new-owner-release', 'usd', 1)
    expect((await computeTotals(ledger())).totals.reserved.usd).toBe(1)
  })
})
