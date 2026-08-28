import { describe, expect, it } from 'vitest'
import { CANDIDATE_RUNTIME_RESOURCE_POLICY_V1 } from '../src/resource-domain.js'
import { spawnResourceBoundSandbox } from '../src/resource-sandbox.js'

describe('resource sandbox supervisor contract', () => {
  it('rejects caller-controlled capability and identity options before launch', async () => {
    for (const extra of [
      ['--cap-add', 'CAP_SYS_ADMIN'],
      ['--cap-add=CAP_SYS_ADMIN'],
      ['--uid=0'],
    ]) {
      await expect(
        spawnResourceBoundSandbox({
          bwrapArgs: ['--unshare-all', '--clearenv', ...extra],
          sandboxNode: '/usr/bin/node',
          targetCommand: '/usr/bin/node',
          targetArgs: [],
          mounts: [{ path: '/tmp', maxBytes: 1024, maxFiles: 1, exportFiles: false }],
          policy: CANDIDATE_RUNTIME_RESOURCE_POLICY_V1,
        }),
      ).rejects.toThrow('resource sandbox: bwrap base args violate supervisor contract')
    }
  })
})
