import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { retainV011BuildRejection } from '../src/v011-real-capabilities.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('v0.1.1 build rejection evidence', () => {
  it('retains the exact deterministic reason for the next proposal attempt', async () => {
    const stateDir = await mkdtemp(`${tmpdir()}/dsh-rsi-build-rejection-`)
    roots.push(stateDir)
    await chmod(stateDir, 0o700)
    const input = {
      stateDir,
      generation: 1,
      attempt: 2,
      proposalId: 'p_11111111111111111111111111111111',
      message: "Module './nested' has no exported member 'nestedComponent'.",
    }
    const path = await retainV011BuildRejection(input)
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(parsed).toMatchObject({
      classification: 'BUILD_REJECT',
      proposalId: input.proposalId,
      reason: input.message,
      retained: true,
    })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await expect(retainV011BuildRejection(input)).resolves.toBe(path)
    await expect(
      retainV011BuildRejection({ ...input, message: 'different failure' }),
    ).rejects.toThrow(/conflicting evidence/)
  })
})
