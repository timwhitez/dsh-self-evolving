/**
 * Builder staging claim / crash-recovery contracts (issue #71).
 *
 * A deterministic staging path used to fail forever after one crash ("zero
 * changed semantics later"): claims are now exclusive mkdirs stamped with a
 * durable owner intent, dead/foreign owners are quarantined aside instead of
 * poisoning retries, live owners report BUSY, and success removes its own
 * intent marker before atomic publication.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claimStagingDir, clearBuildIntent } from '../src/build-claim.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'build-claim-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function startTicks(pid: number): string | null {
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

describe('staging claims', () => {
  it('claims a fresh directory and stamps a durable intent', async () => {
    const staging = join(root!, 'attempt-1.staging')
    await claimStagingDir(staging, { attempt: 1, identity: 'sha256:abc' })
    const intent = JSON.parse(await readFile(join(staging, 'build-intent.json'), 'utf8')) as {
      pid: number
      processStartTicks: string
    }
    expect(intent.pid).toBe(process.pid)
    expect(intent.identity).toBe('sha256:abc')
    await clearBuildIntent(staging)
    await expect(readFile(join(staging, 'build-intent.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('quarantines a dead-owner staging and claims a fresh one on retry', async () => {
    const staging = join(root!, 'attempt-2.staging')
    await mkdir(staging, { recursive: true })
    // Stale debris from a crashed builder.
    await writeFile(
      join(staging, 'build-intent.json'),
      JSON.stringify({ pid: 999999, processStartTicks: '1234567' }) + '\n',
    )
    await writeFile(join(staging, 'torn-artifact'), 'partial')
    await claimStagingDir(staging, { attempt: 2 }, async () => root!)
    // Original residue quarantined aside, never silently merged.
    const entries = await readdir(root!)
    expect(entries.some((name) => name.startsWith('reclaimed-'))).toBe(true)
    const intent = JSON.parse(await readFile(join(staging, 'build-intent.json'), 'utf8'))
    expect(intent.pid).toBe(process.pid)
  })

  it('recovers a pre-intent empty crash residue without an owner record', async () => {
    const staging = join(root!, 'attempt-3.staging')
    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, 'src.ts'), 'truncated')
    await claimStagingDir(staging)
    // A brand-new tree is in place (old contents moved aside by reclaim).
    const entries = await readdir(staging)
    expect(entries).toEqual(['build-intent.json'])
  })

  it('reports BUSY for a provably alive owner', async () => {
    const staging = join(root!, 'attempt-4.staging')
    const ticks = startTicks(process.pid)
    expect(ticks).not.toBeNull()
    await mkdir(staging, { recursive: true })
    await writeFile(
      join(staging, 'build-intent.json'),
      JSON.stringify({ pid: process.pid, processStartTicks: ticks }) + '\n',
    )
    await expect(claimStagingDir(staging)).rejects.toThrow(/another builder owns/)
  })
})
