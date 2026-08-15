/** Gate 3: the controller is a lifecycle-owned Cordis bundle/service. */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as SelfEvolvingBundle from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const statusCli = join(packageRoot, 'lib', 'status-cli.js')
const execFileAsync = promisify(execFile)

let root: string | undefined
let ctx: Context | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-controller-service-'))
})

afterEach(async () => {
  await ctx?.fiber.dispose().catch(() => {})
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('Gate 3 — Cordis controller service lifecycle', () => {
  it('ships a DSH bundle patch that mounts the single controller row', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const patch = await readFile(join(packageRoot, 'cordis.patch.yml'), 'utf8')
    expect(patch.match(/name: '@dsh-self-evolving\/core'/g)).toHaveLength(1)
    expect(patch).toContain('DSH_SELF_EVOLVING_STATE_DIR')
    expect(patch).toContain('DSH_SELF_EVOLVING_RUN_ID')
  })

  it('provides only ctx.selfEvolving, durably records state, and releases its writer lock on unload', async () => {
    const baselineHandles = activeHandleNames()
    ctx = new Context()
    await ctx.plugin(SelfEvolvingBundle, {
      stateDir: root!,
      runId: 'run-service-e2e',
      segmentMaxBytes: 1_000_000,
    })
    const service = ctx.get<SelfEvolvingBundle.SelfEvolvingService>('selfEvolving')
    expect(service).toBeDefined()
    expect(SelfEvolvingBundle.name).toBe('dsh-self-evolving')
    expect(await stat(join(root!, 'journal', 'lock.json'))).toBeDefined()

    await service!.record({
      eventId: 'event-1',
      occurredAt: '2026-08-14T00:00:00.000Z',
      type: 'run.preflight',
      causationId: null,
      correlationId: null,
      actor: 'controller-service-e2e',
      payload: {},
    })
    const status = await service!.status()
    expect(status.eventCount).toBe(1)
    expect(status.head?.seq).toBe(1)
    expect(status.stateHash).toMatch(/^sha256:[0-9a-f]{64}$/)

    await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        service!.record({
          eventId: `concurrent-${index}`,
          occurredAt: '2026-08-14T00:00:00.000Z',
          type: 'audit.concurrent',
          causationId: null,
          correlationId: 'same-wave',
          actor: 'controller-service-e2e',
          payload: { index },
        }),
      ),
    )
    expect((await service!.status()).eventCount).toBe(17)

    await ctx.fiber.dispose()
    expect(ctx.get('selfEvolving')).toBeUndefined()
    await expect(stat(join(root!, 'journal', 'lock.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect((await readFile(join(root!, 'journal', 'HEAD'), 'utf8')).trim()).not.toBe('')

    const headBeforeStatus = await readFile(join(root!, 'journal', 'HEAD'), 'utf8')
    const { stdout } = await execFileAsync(
      process.execPath,
      [statusCli, '--state-dir', root!, '--run-id', 'run-service-e2e'],
      { encoding: 'utf8' },
    )
    expect((JSON.parse(stdout) as { eventCount: number }).eventCount).toBe(17)
    expect(await readFile(join(root!, 'journal', 'HEAD'), 'utf8')).toBe(headBeforeStatus)

    // A fresh controller can acquire the same durable run and replay it.
    ctx = new Context()
    await ctx.plugin(SelfEvolvingBundle, {
      stateDir: root!,
      runId: 'run-service-e2e',
      segmentMaxBytes: 1_000_000,
    })
    expect(
      (await ctx.get<SelfEvolvingBundle.SelfEvolvingService>('selfEvolving')!.status()).eventCount,
    ).toBe(17)
    await ctx.fiber.dispose()
    ctx = undefined
    const leaked = activeHandleNames().filter((handle) => !baselineHandles.includes(handle))
    expect(leaked, `controller handles leaked after unload: ${leaked.join(',')}`).toEqual([])
  })
})

function activeHandleNames(): string[] {
  return (
    (
      process as unknown as {
        _getActiveHandles?: () => { constructor?: { name?: string } }[]
      }
    )._getActiveHandles?.() ?? []
  )
    .map((handle) => handle.constructor?.name ?? 'anon')
    .sort()
}
