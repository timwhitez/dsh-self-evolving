/**
 * Sandbox executable allowlist contract (issue #92).
 *
 * The kernel resolves `.`/`..` components at execve time, so a raw
 * string-prefix allowlist check can authorize executables outside the mounted
 * subtrees. `validateCommand` must therefore reject every non-canonical path
 * and authorize only component-normalized containment.
 */
import { describe, expect, it } from 'vitest'
import { normalizeSandboxPath, runProposalSandbox } from '../src/index.js'

const mounts = {
  parent: '/nonexistent-parent',
  archive: '/nonexistent-archive',
  evidence: '/nonexistent-evidence',
  contracts: '/nonexistent-contracts',
  childrenRoot: '/nonexistent-children',
}

describe('sandbox executable allowlist', () => {
  it('normalizes canonical absolute paths', () => {
    expect(normalizeSandboxPath('/usr/bin/node')).toBe('/usr/bin/node')
    expect(normalizeSandboxPath('/input/contracts/worker.js')).toBe('/input/contracts/worker.js')
    expect(normalizeSandboxPath('/runtime/node')).toBe('/runtime/node')
  })

  it('rejects relative, root, empty, NUL, dot, dot-dot and trailing-separator paths', () => {
    expect(() => normalizeSandboxPath('usr/bin/node')).toThrow(/must be absolute/)
    expect(() => normalizeSandboxPath('/')).toThrow(/non-canonical path component/)
    expect(() => normalizeSandboxPath('/usr/bin/node/')).toThrow(/non-canonical path component/)
    expect(() => normalizeSandboxPath('/usr/bin//node')).toThrow(/non-canonical path component/)
    expect(() => normalizeSandboxPath('/usr/bin/./node')).toThrow(/non-canonical path component/)
    expect(() => normalizeSandboxPath('/usr/bin/node\0')).toThrow(/must not contain NUL/)
    for (const path of [
      '/input/contracts/../../../usr/bin/python3',
      '/runtime/../usr/bin/python3',
      '/input/contracts/../contracts/../..',
      '/..',
    ]) {
      expect(() => normalizeSandboxPath(path)).toThrow(/parent traversal rejected/)
    }
  })

  it('rejects traversal commands that pass the raw prefix before any sandbox work', async () => {
    for (const command of [
      '/input/contracts/../../../usr/bin/python3',
      '/runtime/../usr/bin/python3',
      '/usr/bin/env/../../../bin/busybox',
    ]) {
      await expect(
        runProposalSandbox({ mounts, command, args: [], timeoutMs: 1_000 }),
      ).rejects.toThrow(/proposal sandbox: (parent traversal|command is outside)/)
    }
  })

  it('still accepts the documented canonical executables up to mount validation', async () => {
    // Canonical commands advance past the allowlist check and fail later at
    // host-side mount resolution, proving the allowlist itself accepted them.
    for (const command of ['/usr/bin/node', '/bin/sh', '/usr/bin/env']) {
      await expect(
        runProposalSandbox({ mounts, command, args: [], timeoutMs: 1_000 }),
      ).rejects.toThrow(/root must be a real directory|ENOENT/)
    }
  })
})
