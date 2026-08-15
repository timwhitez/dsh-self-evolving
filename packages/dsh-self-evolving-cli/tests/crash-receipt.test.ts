import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createStableDemoConfig, finalizeCrashResumeReceipt } from '../src/index.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('real crash receipt verifier', () => {
  it('refuses to mint a receipt without a preserved stale writer lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-crash-receipt-'))
    roots.push(root)
    const config = createStableDemoConfig({
      runId: 'crash-test',
      stateDir: root,
      repoRoot: '/root/dsh-self-evolving',
      codeCommit: 'a'.repeat(40),
    })
    await writeFile(
      join(root, 'crash-injection-request.json'),
      JSON.stringify({ schemaVersion: 1, actionId: 'eval:candidate:1', boundary: 'launch' }) + '\n',
    )
    await mkdir(join(root, 'journal'), { recursive: true })
    await expect(finalizeCrashResumeReceipt(config)).rejects.toThrow('stale writer lock')
  })
})
