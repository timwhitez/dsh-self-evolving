import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  readSourceArchiveIdentity,
  verifySourceArchiveIdentity,
  type SourceArchiveIdentity,
} from '../src/source-identity.js'

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

describe('source archive identity', () => {
  it('accepts exact source and rejects tampering or unexpected code files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-source-identity-'))
    await mkdir(join(root, 'packages', 'example', 'src'), { recursive: true })
    await writeFile(join(root, 'packages', 'example', 'src', 'index.ts'), 'export const x = 1\n')
    const identity: SourceArchiveIdentity = {
      schemaVersion: 1,
      commit: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      files: {
        'packages/example/src/index.ts': digest('export const x = 1\n'),
      },
    }
    await writeFile(
      join(root, '.dsh-self-evolving-source-identity.json'),
      JSON.stringify(identity) + '\n',
    )
    const loaded = await readSourceArchiveIdentity(root)
    expect(loaded).toEqual(identity)
    await expect(verifySourceArchiveIdentity(root, identity)).resolves.toMatchObject({
      valid: true,
    })

    await writeFile(join(root, 'packages', 'example', 'src', 'index.ts'), 'export const x = 2\n')
    await expect(verifySourceArchiveIdentity(root, identity)).resolves.toMatchObject({
      valid: false,
      detail: expect.stringContaining('hash mismatch'),
    })
    await writeFile(join(root, 'packages', 'example', 'src', 'index.ts'), 'export const x = 1\n')
    await writeFile(join(root, 'packages', 'example', 'src', 'extra.ts'), 'export {}\n')
    await expect(verifySourceArchiveIdentity(root, identity)).resolves.toMatchObject({
      valid: false,
      detail: expect.stringContaining('inventory'),
    })
  })

  describe('trust anchors and release inventory (issue #72)', () => {
    async function fixture(): Promise<{ root: string; identity: SourceArchiveIdentity }> {
      const root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-source-anchor-'))
      await mkdir(join(root, 'packages', 'demo'), { recursive: true })
      await mkdir(join(root, 'scripts'), { recursive: true })
      await writeFile(join(root, 'packages', 'demo', 'index.ts'), 'export const a = 1\n')
      await writeFile(join(root, 'scripts', 'run.ts'), 'void 0\n')
      await writeFile(join(root, 'README.md'), 'release readme\n')
      const identity: SourceArchiveIdentity = {
        schemaVersion: 1,
        commit: 'a'.repeat(40),
        tree: 'b'.repeat(40),
        files: {
          'packages/demo/index.ts': digest('export const a = 1\n'),
          'scripts/run.ts': digest('void 0\n'),
        },
        releaseFiles: ['README.md', 'packages/demo/index.ts', 'scripts/run.ts'],
      }
      return { root, identity }
    }

    it('reports SELF_CONSISTENT without a trust anchor', async () => {
      const { root, identity } = await fixture()
      const result = await verifySourceArchiveIdentity(root, identity)
      expect(result.valid).toBe(true)
      expect(result.status).toBe('SELF_CONSISTENT')
      expect(result.detail).toMatch(/no external trust anchor/)
    })

    it('reports AUTHENTICATED when the trusted commit anchor matches', async () => {
      const { root, identity } = await fixture()
      const result = await verifySourceArchiveIdentity(root, identity, {
        trustedCommit: identity.commit,
      })
      expect(result.valid).toBe(true)
      expect(result.status).toBe('AUTHENTICATED')
      expect(result.detail).toMatch(/trusted anchor/)
    })

    it('treats a trusted-anchor mismatch as a hard failure', async () => {
      const { root, identity } = await fixture()
      const result = await verifySourceArchiveIdentity(root, identity, {
        trustedCommit: 'c'.repeat(40),
      })
      expect(result.valid).toBe(false)
      expect(result.detail).toMatch(/does not match the trusted anchor/)
    })

    it('rejects a missing release inventory entry outside the hashed code paths', async () => {
      const { root, identity } = await fixture()
      const { rm } = await import('node:fs/promises')
      await rm(join(root, 'README.md'))
      const result = await verifySourceArchiveIdentity(root, identity)
      expect(result.valid).toBe(false)
      expect(result.detail).toMatch(/release file is missing/)
    })

    it('rejects a malformed trusted anchor outright', async () => {
      const { root, identity } = await fixture()
      await expect(
        verifySourceArchiveIdentity(root, identity, { trustedCommit: 'not-a-commit' }),
      ).rejects.toThrow(/trusted commit anchor/)
    })
  })
})
