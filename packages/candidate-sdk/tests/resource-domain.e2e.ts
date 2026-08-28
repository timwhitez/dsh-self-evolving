import { realpath } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { runResourceBoundCommand, type ResourcePolicyV1 } from '../src/resource-domain.js'
import { spawnResourceBoundSandbox } from '../src/resource-sandbox.js'

const MiB = 1024 * 1024

function policy(overrides: Partial<ResourcePolicyV1> = {}): ResourcePolicyV1 {
  return {
    schemaVersion: 1,
    policyId: 'resource-domain-e2e-v1',
    memoryMaxBytes: 256 * MiB,
    memorySwapMaxBytes: 0,
    pidsMax: 16,
    cpuQuotaMicros: 100_000,
    cpuPeriodMicros: 100_000,
    cpuTimeSoftSeconds: 10,
    cpuTimeHardSeconds: 11,
    fileSizeMaxBytes: 8 * MiB,
    openFilesMax: 128,
    ioReadBytesPerSecond: 64 * MiB,
    ioWriteBytesPerSecond: 64 * MiB,
    ioReadIops: 4096,
    ioWriteIops: 4096,
    writableStorageMaxBytes: 32 * MiB,
    writableStorageMaxFiles: 256,
    ...overrides,
  }
}

describe('cgroup-v2 resource domain', () => {
  it('contains a memory bomb and records the OOM termination', { timeout: 30_000 }, async () => {
    const result = await runResourceBoundCommand({
      command: process.execPath,
      args: ['--eval', 'const held=[]; for (;;) held.push(Buffer.alloc(16 * 1024 * 1024, 1))'],
      timeoutMs: 20_000,
      maxOutputBytes: MiB,
      policy: policy(),
    })

    expect(result.resource.terminationCause).toBe('MEMORY_LIMIT')
    expect(result.resource.events.memoryOomKills).toBeGreaterThan(0)
    expect(result.resource.usage.memoryPeakBytes).toBeLessThanOrEqual(
      result.resource.policy.memoryMaxBytes,
    )
  })

  it('contains a fork bomb at the frozen pids ceiling', { timeout: 30_000 }, async () => {
    const result = await runResourceBoundCommand({
      command: process.execPath,
      args: [
        '--eval',
        [
          "const { spawn } = require('node:child_process')",
          'for (let i = 0; i < 128; i += 1) {',
          "  const child = spawn('/bin/sleep', ['5'])",
          "  child.on('error', () => undefined)",
          '}',
          'setTimeout(() => process.exit(0), 250)',
        ].join('\n'),
      ],
      timeoutMs: 10_000,
      maxOutputBytes: MiB,
      policy: policy({ pidsMax: 8 }),
    })

    expect(result.resource.terminationCause).toBe('PIDS_LIMIT')
    expect(result.resource.events.pidsMaxEvents).toBeGreaterThan(0)
    expect(result.resource.usage.pidsPeak).toBeLessThanOrEqual(8)
  })

  it('throttles a CPU burner before wall-time teardown', { timeout: 30_000 }, async () => {
    const result = await runResourceBoundCommand({
      command: process.execPath,
      args: ['--eval', 'for (;;) {}'],
      timeoutMs: 1_500,
      maxOutputBytes: MiB,
      policy: policy({ cpuQuotaMicros: 20_000 }),
    })

    expect(result.resource.terminationCause).toBe('WALL_TIME_LIMIT')
    expect(result.resource.usage.cpuThrottledUsec).toBeGreaterThan(0)
    expect(result.resource.usage.cpuUsageUsec).toBeLessThan(900_000)
  })

  it(
    'terminates a CPU burner at the per-process CPU-time rlimit',
    { timeout: 30_000 },
    async () => {
      const result = await runResourceBoundCommand({
        command: process.execPath,
        args: ['--eval', 'for (;;) {}'],
        timeoutMs: 10_000,
        maxOutputBytes: MiB,
        policy: policy({ cpuTimeSoftSeconds: 1, cpuTimeHardSeconds: 2 }),
      })

      expect(result.resource.terminationCause, JSON.stringify(result.resource)).toBe(
        'CPU_TIME_LIMIT',
      )
      expect(result.resource.usage.cpuUsageUsec).toBeGreaterThanOrEqual(900_000)
      expect(result.resource.usage.cpuUsageUsec).toBeLessThan(2_500_000)
    },
  )

  it(
    'contains a disk fill in a size-limited tmpfs and exports only bounded bytes',
    { timeout: 30_000 },
    async () => {
      const hostNode = await realpath(process.execPath)
      const sandboxNode = hostNode === '/usr/bin/node' ? '/usr/bin/node' : '/sandbox-bin/node'
      const bwrapArgs = [
        '--die-with-parent',
        '--new-session',
        '--unshare-all',
        '--hostname',
        'dsh-resource-storage-test',
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        '--ro-bind',
        '/usr',
        '/usr',
        ...(hostNode === '/usr/bin/node'
          ? []
          : ['--dir', '/sandbox-bin', '--ro-bind', hostNode, sandboxNode]),
        '--ro-bind',
        '/bin',
        '/bin',
        '--ro-bind',
        '/lib',
        '/lib',
        '--ro-bind',
        '/lib64',
        '/lib64',
        '--dir',
        '/tmp',
        '--dir',
        '/work',
        '--dir',
        '/work/children',
        '--clearenv',
        '--setenv',
        'PATH',
        '/usr/bin:/bin',
        '--chdir',
        '/work/children',
      ]
      const sandbox = await spawnResourceBoundSandbox({
        bwrapArgs,
        sandboxNode,
        targetCommand: sandboxNode,
        targetArgs: [
          '--eval',
          [
            "const { readdirSync, readFileSync, writeFileSync } = require('node:fs')",
            "const status = readFileSync('/proc/self/status', 'utf8')",
            "if (!/^CapInh:\\s+0+$/m.test(status) || !/^CapPrm:\\s+0+$/m.test(status) || !/^CapEff:\\s+0+$/m.test(status) || !/^CapBnd:\\s+0+$/m.test(status) || !/^CapAmb:\\s+0+$/m.test(status) || !/^NoNewPrivs:\\s+1$/m.test(status)) throw new Error('target retained supervisor privileges')",
            "const visiblePids = readdirSync('/proc').filter((entry) => /^\\d+$/.test(entry)).sort()",
            'if (process.pid !== 1 || process.ppid !== 0 || JSON.stringify(visiblePids) !== \'["1"]\') throw new Error(`target shares supervisor pid namespace: ${process.pid}/${process.ppid}/${visiblePids}`)',
            "process.stdout.write('PID_NAMESPACE_ISOLATED\\n')",
            "process.stdout.write('START\\n')",
            'try {',
            '  for (let i = 0; ; i += 1) { writeFileSync(`/work/children/${i}`, Buffer.alloc(64 * 1024, 1)); if (i % 16 === 0) process.stdout.write(`WROTE:${i}\\n`) }',
            '} catch (error) {',
            "  if (error.code !== 'ENOSPC') throw error",
            '}',
          ].join('\n'),
        ],
        mounts: [
          { path: '/tmp', maxBytes: MiB, maxFiles: 64, exportFiles: false },
          { path: '/work/children', maxBytes: MiB, maxFiles: 64, exportFiles: true },
        ],
        policy: policy({
          pidsMax: 64,
          writableStorageMaxBytes: 2 * MiB,
          writableStorageMaxFiles: 128,
        }),
      })
      sandbox.child.stdin.destroy()
      const stdout: Buffer[] = []
      sandbox.child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
      const stderr: Buffer[] = []
      sandbox.child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
      const timer = setTimeout(() => void sandbox.kill('WALL_TIME_LIMIT'), 10_000)
      await new Promise<void>((done) => sandbox.child.once('close', () => done()))
      clearTimeout(timer)
      const result = await sandbox.finish()

      expect(
        result.resource.terminationCause,
        `${Buffer.concat(stderr).toString('utf8')}\n${Buffer.concat(stdout).toString('utf8')}`,
      ).toBe('WRITABLE_STORAGE_LIMIT')
      expect(Buffer.concat(stdout).toString('utf8')).toContain('PID_NAMESPACE_ISOLATED')
      expect(result.resource.enforcement.sandbox?.targetPidNamespace).toBe('private-descendant')
      expect(result.resource.usage.writableStoragePeakBytes).toBeLessThanOrEqual(2 * MiB)
      expect(result.resource.usage.writableStoragePeakFiles).toBeLessThanOrEqual(128)
      expect(
        result.files.reduce((total, file) => total + file.bytes.byteLength, 0),
      ).toBeLessThanOrEqual(MiB)
    },
  )
})
