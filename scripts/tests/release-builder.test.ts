import { describe, expect, it } from 'vitest'
import {
  RELEASE_VERSION,
  RELEASE_STATUS,
  assertTrackedTextSafe,
  buildSpdxSbom,
  normalizeGitCommit,
} from '../build-release.js'

describe('release SBOM builder', () => {
  it('normalizes the newline emitted by git rev-parse', () => {
    expect(normalizeGitCommit(`${'a'.repeat(40)}\n`)).toBe('a'.repeat(40))
    expect(() => normalizeGitCommit('not-a-commit\n')).toThrow(/invalid Git commit identity/)
  })

  it('binds the public receipt to the v0.2 release line', () => {
    expect(RELEASE_VERSION).toBe('0.2.0')
    expect(RELEASE_STATUS).toBe('OPEN_SOURCE_V0_2_RELEASE_CANDIDATE')
  })

  it('scans the tracked release tree without treating synthetic rejection fixtures as secrets', async () => {
    await expect(assertTrackedTextSafe()).resolves.toMatchObject({
      trackedFiles: expect.any(Number),
    })
  })

  it('emits deterministic SPDX package identities from the license inventory', () => {
    const sbom = buildSpdxSbom('a'.repeat(40), {
      MIT: [{ name: 'z-lib', versions: ['2.0.0'], license: 'MIT' }],
      'Apache-2.0': [{ name: 'a-lib', versions: ['1.0.0'], license: 'Apache-2.0' }],
    }) as {
      spdxVersion: string
      packages: Array<{ name: string; versionInfo: string; licenseDeclared: string }>
    }
    expect(sbom.spdxVersion).toBe('SPDX-2.3')
    expect(sbom.packages.map((entry) => entry.name)).toEqual([
      'dsh-self-evolving',
      'a-lib',
      'z-lib',
    ])
    expect(sbom.packages[0]?.licenseDeclared).toBe('Apache-2.0')
    expect(sbom.packages[0]?.versionInfo).toBe(RELEASE_VERSION)
  })
})
