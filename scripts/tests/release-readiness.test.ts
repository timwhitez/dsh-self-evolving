import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REQUIRED_RELEASE_FILES, resolveReleaseFiles } from '../check-release-readiness.js'

describe('release readiness checker', () => {
  it('keeps the required public documentation list explicit', () => {
    expect(REQUIRED_RELEASE_FILES).toEqual(
      expect.arrayContaining([
        'CONTRIBUTING.md',
        'SECURITY.md',
        'CODE_OF_CONDUCT.md',
        'CHANGELOG.md',
        'docs/quickstart.md',
        'docs/evidence-guide.md',
      ]),
    )
  })

  it('uses the embedded release inventory when Git metadata is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rsi-release-no-git-'))
    const releaseFiles = ['README.md', 'docs/quickstart.md']
    await writeFile(
      join(root, '.dsh-rsi-source-identity.json'),
      JSON.stringify({
        schemaVersion: 1,
        commit: 'a'.repeat(40),
        tree: 'b'.repeat(40),
        files: {},
        releaseFiles,
      }),
    )
    await expect(resolveReleaseFiles(root)).resolves.toEqual(releaseFiles)
  })
})
