import { describe, expect, it } from 'vitest'
import { assertTrackedTextSafe, buildSpdxSbom } from '../build-release.js'

describe('release SBOM builder', () => {
  it('scans the tracked release tree without treating synthetic rejection fixtures as secrets', async () => {
    await expect(assertTrackedTextSafe()).resolves.toMatchObject({
      trackedFiles: expect.any(Number),
    })
  })

  it('emits deterministic SPDX package identities from the license inventory', () => {
    const sbom = buildSpdxSbom('a'.repeat(40), {
      MIT: [{ name: 'z-lib', versions: ['2.0.0'], license: 'MIT' }],
      'Apache-2.0': [{ name: 'a-lib', versions: ['1.0.0'], license: 'Apache-2.0' }],
    }) as { spdxVersion: string; packages: Array<{ name: string; licenseDeclared: string }> }
    expect(sbom.spdxVersion).toBe('SPDX-2.3')
    expect(sbom.packages.map((entry) => entry.name)).toEqual(['a-lib', 'z-lib'])
    expect(sbom.packages[0]?.licenseDeclared).toBe('Apache-2.0')
  })
})
