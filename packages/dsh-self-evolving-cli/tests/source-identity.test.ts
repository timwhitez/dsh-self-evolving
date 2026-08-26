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
      await writeFile(
        join(root, '.dsh-self-evolving-source-identity.json'),
        JSON.stringify(identity),
      )
      return { root, identity }
    }

    it('reports SELF_CONSISTENT without a trust anchor', async () => {
      const { root, identity } = await fixture()
      const result = await verifySourceArchiveIdentity(root, identity)
      expect(result.valid).toBe(true)
      expect(result.status).toBe('SELF_CONSISTENT')
      expect(result.detail).toMatch(/no external trust anchor/)
    })

    it('reports COMMIT_ANCHORED — not AUTHENTICATED — for a bare commit match', async () => {
      const { root, identity } = await fixture()
      const result = await verifySourceArchiveIdentity(root, identity, {
        trustedCommit: identity.commit,
      })
      expect(result.valid).toBe(true)
      expect(result.status).toBe('COMMIT_ANCHORED')
      expect(result.detail).toMatch(/not byte-authenticated/)
    })

    it('an in-archive rewrite that keeps the commit must NOT be AUTHENTICATED', async () => {
      const { root, identity } = await fixture()
      // Strong attacker: malicious source + recomputed manifest digests, same commit.
      await writeFile(join(root, 'packages', 'demo', 'index.ts'), 'export const evil = 1\n')
      const forged: SourceArchiveIdentity = {
        ...identity,
        files: {
          ...identity.files,
          'packages/demo/index.ts': digest('export const evil = 1\n'),
        },
      }
      // Without a byte anchor this is only self-consistent.
      expect((await verifySourceArchiveIdentity(root, forged)).status).toBe('SELF_CONSISTENT')
      // And a commit anchor does not upgrade it.
      expect(
        (await verifySourceArchiveIdentity(root, forged, { trustedCommit: forged.commit })).status,
      ).toBe('COMMIT_ANCHORED')
    })

    it('reports AUTHENTICATED only when the archive bytes match the trusted digest', async () => {
      const { root, identity } = await fixture()
      const archivePath = join(root!, '..', 'release.tar.gz')
      await writeFile(archivePath, 'ARCHIVE-BYTES')
      const trusted = digest('ARCHIVE-BYTES')
      const result = await verifySourceArchiveIdentity(root, identity, {
        trustedArchiveDigest: trusted,
        archivePath,
      })
      expect(result.valid).toBe(true)
      expect(result.status).toBe('AUTHENTICATED')
      expect(result.detail).toMatch(/bytes match the trusted digest/)
      // A rewritten archive fails hard.
      await writeFile(archivePath, 'REWRITTEN-BYTES')
      const failed = await verifySourceArchiveIdentity(root, identity, {
        trustedArchiveDigest: trusted,
        archivePath,
      })
      expect(failed.valid).toBe(false)
      expect(failed.status).toBe('INVALID')
      expect(failed.detail).toMatch(/do not match the trusted archive digest/)
    })

    it('treats a trusted-commit mismatch as a hard failure', async () => {
      const { root, identity } = await fixture()
      const result = await verifySourceArchiveIdentity(root, identity, {
        trustedCommit: 'c'.repeat(40),
      })
      expect(result.valid).toBe(false)
      expect(result.status).toBe('INVALID')
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

    it('rejects an extra file anywhere outside the declared release inventory', async () => {
      const { root, identity } = await fixture()
      await writeFile(join(root, 'planted-top-level.sh'), 'evil\n')
      const result = await verifySourceArchiveIdentity(root, identity)
      expect(result.valid).toBe(false)
      expect(result.detail).toMatch(/outside the declared release inventory/)
    })

    it('rejects malformed anchors outright', async () => {
      const { root, identity } = await fixture()
      await expect(
        verifySourceArchiveIdentity(root, identity, { trustedCommit: 'not-a-commit' }),
      ).rejects.toThrow(/trusted commit anchor/)
      await expect(
        verifySourceArchiveIdentity(root, identity, { trustedArchiveDigest: 'sha256:short' }),
      ).rejects.toThrow(/both digest and path/)
      // A well-formed digest with an unreadable archive resolves to INVALID.
      const unreadable = await verifySourceArchiveIdentity(root, identity, {
        trustedArchiveDigest: digest('x'),
        archivePath: join(root, 'nonexistent'),
      })
      expect(unreadable.valid).toBe(false)
      expect(unreadable.status).toBe('INVALID')
    })
  })
})
