/**
 * Gate 0 fast-CI guards (spec 07 §12).
 *
 * These mirror the scripts/ checkers but run inside vitest so `pnpm test` is
 * the single green/red signal. Each test asserts one CI gate from spec 07 §12:
 *   - upstream worktrees unchanged (AGENTS.md rule 1)
 *   - AGENTS.md / CLAUDE.md byte-equal (no instruction drift)
 *   - provenance.lock.json present, valid JSON, and every upstream at its pin
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

describe('Gate 0 CI — upstream worktrees clean', () => {
  for (const up of ['deepseek-harness', 'harbor', 'tb']) {
    it(`${up} is a clean git checkout (read-only pin)`, () => {
      const dir = resolve(root, up)
      const dirty = git(dir, 'status', '--porcelain')
      expect(dirty, `${up} working tree is dirty`).toBe('')
    })
  }
})

describe('Gate 0 CI — instruction byte equality', () => {
  it('AGENTS.md and CLAUDE.md are byte-identical', async () => {
    const a = await readFile(resolve(root, 'AGENTS.md'))
    const b = await readFile(resolve(root, 'CLAUDE.md'))
    expect(a.equals(b)).toBe(true)
  })
})

describe('Gate 0 CI — provenance lock', () => {
  it('provenance.lock.json exists and parses', async () => {
    const raw = await readFile(resolve(root, 'provenance.lock.json'), 'utf8')
    const lock = JSON.parse(raw) as { upstreams: Record<string, { path: string; commit: string }> }
    expect(lock.upstreams).toBeDefined()
    expect(Object.keys(lock.upstreams).length).toBeGreaterThanOrEqual(3)
  })

  it('every upstream is checked out at its pinned commit', async () => {
    const raw = await readFile(resolve(root, 'provenance.lock.json'), 'utf8')
    const lock = JSON.parse(raw) as { upstreams: Record<string, { path: string; commit: string }> }
    for (const [name, up] of Object.entries(lock.upstreams)) {
      const dir = resolve(root, up.path)
      await expect(stat(dir), `${name} missing`).resolves.toBeTruthy()
      const head = git(dir, 'rev-parse', 'HEAD')
      expect(head, `${name} HEAD mismatch`).toBe(up.commit)
    }
  })

  it('referenced paper.pdf sha256 matches', async () => {
    const raw = await readFile(resolve(root, 'provenance.lock.json'), 'utf8')
    const lock = JSON.parse(raw) as {
      references?: Record<string, { path?: string; value?: string }>
    }
    const ref = lock.references?.['cordisPaper']
    if (!ref?.path || !ref.value) return // skip if not configured
    const data = await readFile(ref.path.startsWith('/') ? ref.path : resolve(root, ref.path))
    const hash = createHash('sha256').update(data).digest('hex')
    expect(hash).toBe(ref.value)
  })
})
