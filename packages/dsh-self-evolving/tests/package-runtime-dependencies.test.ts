import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('@dsh-self-evolving/core package closure', () => {
  it('declares every package imported by the public service entrypoint as a runtime dependency', async () => {
    const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url))
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }

    for (const dependency of ['@deepseek-ai/cordis', '@deepseek-ai/schemastery']) {
      expect(packageJson.dependencies?.[dependency]).toBeTypeOf('string')
      expect(packageJson.devDependencies?.[dependency]).toBeUndefined()
    }
  })
})
