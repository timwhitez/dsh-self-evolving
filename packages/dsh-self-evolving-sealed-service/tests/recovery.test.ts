/**
 * Sealed-service crash/recovery contracts (issues #43, #95, #96).
 *
 * - public receipts are published atomically: a complete record or nothing,
 *   reusable byte-identically, and stale staging siblings never block;
 * - only a confirmed ENOENT may initialize private ceremony state — any other
 *   read failure fails closed without regenerating or replacing bytes;
 * - the service lock is reclaimed only from a provably dead/crashed owner and
 *   a live owner's lock yields SERVICE_BUSY.
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { handleServiceRequest, type CeremonyRequest, type CeremonyTask } from '../src/service.js'

const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`

function tasks(): CeremonyTask[] {
  return Array.from({ length: 89 }, (_, index) => ({
    taskId: `task-${String(index).padStart(3, '0')}`,
    category: `category-${index % 7}`,
    difficulty: index % 2 === 0 ? 'easy' : 'hard',
    agentTimeoutSec: 900,
    allowInternet: index % 2 === 0,
  }))
}

async function fixture(): Promise<{ root: string; request: CeremonyRequest }> {
  const root = await mkdtemp(join(tmpdir(), 'sealed-service-recovery-'))
  await chmod(root, 0o755)
  return {
    root,
    request: {
      operation: 'ceremony',
      ceremonyId: 'recovery-ceremony',
      privateDir: join(root, 'private'),
      publicDir: join(root, 'public'),
      tasks: tasks(),
      datasetDigest: digest('dataset'),
      protocolHash: digest('protocol'),
      splitterCodeHash: digest('splitter-code'),
    },
  }
}

/** Synchronous twin of the service's /proc liveness probe (stat field 22). */
function processStartTicks(pid: number): string | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const suffix = raw
      .slice(raw.lastIndexOf(') ') + 2)
      .trim()
      .split(/\s+/)
    return suffix[19] ?? null
  } catch {
    return null
  }
}

describe('sealed-service recovery', () => {
  it('republishes a missing public receipt byte-identically (crash after private commit)', async () => {
    const { request } = await fixture()
    const first = await handleServiceRequest(request)
    expect(first.ok).toBe(true)
    const receiptPath = join(request.publicDir, 'split-commitment.json')
    const original = await readFile(receiptPath, 'utf8')
    await rm(receiptPath, { force: true })

    const second = await handleServiceRequest(request)
    expect(second.ok).toBe(true)
    await expect(readFile(receiptPath, 'utf8')).resolves.toBe(original)
  })

  it('never exposes a partial final receipt and ignores stale staging siblings', async () => {
    const { request } = await fixture()
    // A leftover staging file (crash before the atomic link) must neither
    // block publication nor leak its bytes to the final path.
    await mkdir(request.publicDir, { recursive: true })
    await writeFile(
      join(request.publicDir, '.split-commitment.json.staging-9999-abc'),
      'PARTIAL-BYTES',
    )
    const result = await handleServiceRequest(request)
    expect(result.ok).toBe(true)
    const receipt = await readFile(join(request.publicDir, 'split-commitment.json'), 'utf8')
    expect(receipt).not.toContain('PARTIAL-BYTES')
    expect(receipt.endsWith('\n')).toBe(true)
    expect((JSON.parse(receipt) as { commitment?: unknown }).commitment).toBeDefined()
  })

  it('fails closed on a truncated legacy final receipt instead of overwriting', async () => {
    const { request } = await fixture()
    await mkdir(request.publicDir, { recursive: true })
    await mkdir(request.privateDir, { recursive: true })
    await chmod(request.privateDir, 0o700)
    await writeFile(join(request.publicDir, 'split-commitment.json'), '')
    await expect(handleServiceRequest(request)).rejects.toThrow(/PUBLIC_RECEIPT_CONFLICT/)
  })

  it('treats an unreadable non-ENOENT private state as a hard failure, not uninitialized', async () => {
    const { request } = await fixture()
    const first = await handleServiceRequest(request)
    expect(first.ok).toBe(true)
    // Replace the state file with a directory: reads fail with EISDIR, which
    // must propagate instead of being mistaken for "no ceremony yet".
    const statePath = join(request.privateDir, 'ceremony-state.json')
    const before = await readFile(join(request.publicDir, 'split-commitment.json'), 'utf8')
    await rm(statePath, { force: true })
    await mkdir(statePath)
    await expect(handleServiceRequest(request)).rejects.toThrow()
    await expect(readFile(join(request.publicDir, 'split-commitment.json'), 'utf8')).resolves.toBe(
      before,
    )
  })

  it('refuses to steal a live owner lock and reports SERVICE_BUSY', async () => {
    const { request } = await fixture()
    await mkdir(request.privateDir, { recursive: true })
    await chmod(request.privateDir, 0o700)
    const start = processStartTicks(process.pid)
    expect(start).not.toBeNull()
    await writeFile(join(request.privateDir, '.service.lock'), `${process.pid}:${start}\n`, {
      mode: 0o600,
    })
    await expect(handleServiceRequest(request)).rejects.toThrow(/SERVICE_BUSY/)
    // The live owner's lock file must survive untouched.
    await expect(readFile(join(request.privateDir, '.service.lock'), 'utf8')).resolves.toBe(
      `${process.pid}:${start}\n`,
    )
  })

  it('reclaims a lock left by a process that crashed before writing its owner record', async () => {
    const { request } = await fixture()
    await mkdir(request.privateDir, { recursive: true })
    await chmod(request.privateDir, 0o700)
    // Empty lock file: equivalent to SIGKILL right after open(wx).
    await writeFile(join(request.privateDir, '.service.lock'), '', { mode: 0o600 })
    const result = await handleServiceRequest(request)
    expect(result.ok).toBe(true)
    await expect(stat(join(request.privateDir, 'ceremony-state.json'))).resolves.toBeTruthy()
  })

  it('reclaims a lock held by a provably dead pid', async () => {
    const { request } = await fixture()
    await mkdir(request.privateDir, { recursive: true })
    await chmod(request.privateDir, 0o700)
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
    await new Promise<void>((done) => child.once('exit', () => done()))
    await writeFile(join(request.privateDir, '.service.lock'), `${child.pid}:1234567\n`, {
      mode: 0o600,
    })
    const result = await handleServiceRequest(request)
    expect(result.ok).toBe(true)
  })
})
