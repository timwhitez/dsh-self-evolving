import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('release readiness checker', () => {
  it('keeps the required public documentation list explicit', async () => {
    const source = await readFile(new URL('../check-release-readiness.ts', import.meta.url), 'utf8')
    for (const name of [
      'CONTRIBUTING.md',
      'SECURITY.md',
      'CODE_OF_CONDUCT.md',
      'CHANGELOG.md',
      'docs/quickstart.md',
      'docs/evidence-guide.md',
    ]) {
      expect(source).toContain(name)
    }
  })
})
