import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const LOCAL_PROTOCOL = /^(?:file|link|workspace):/

describe('@dsh-self-evolving/core package closure', () => {
  it('publishes every public-entrypoint runtime import as a required peer contract', async () => {
    const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url))
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }

    for (const dependency of ['@deepseek-ai/cordis', '@deepseek-ai/schemastery']) {
      const peerRange = packageJson.peerDependencies?.[dependency]
      expect(peerRange).toBeTypeOf('string')
      expect(peerRange).not.toMatch(LOCAL_PROTOCOL)
      expect(packageJson.dependencies?.[dependency]).toBeUndefined()
      expect(packageJson.devDependencies?.[dependency]).toMatch(/^link:/)
    }
  })
})
