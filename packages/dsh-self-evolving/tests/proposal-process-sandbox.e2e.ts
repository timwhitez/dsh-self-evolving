/** Gate 4: proposal policy is enforced by an outer OS process sandbox. */
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProposalSandbox, type ProposalSandboxMounts } from '../src/index.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-proposal-sandbox-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function mounts(): Promise<ProposalSandboxMounts> {
  const result = {
    parent: join(root!, 'parent'),
    archive: join(root!, 'archive'),
    evidence: join(root!, 'evidence'),
    contracts: join(root!, 'contracts'),
    childrenRoot: join(root!, 'children'),
  }
  await Promise.all(Object.values(result).map((path) => mkdir(path, { recursive: true })))
  await writeFile(join(result.parent, 'parent.txt'), 'parent-ok\n')
  await writeFile(join(result.archive, 'catalog.json'), '{"catalog":"dev-only"}\n')
  await writeFile(join(result.evidence, 'trace.txt'), 'dev-evidence-ok\n')
  return result
}

describe('Gate 4 — outer proposal process sandbox', () => {
  it('enforces read-only inputs, one writable root, empty secrets, and no network', async () => {
    const paths = await mounts()
    const probe = [
      "import { readFile, writeFile, access } from 'node:fs/promises'",
      "import { spawnSync } from 'node:child_process'",
      "import { connect } from 'node:net'",
      "await readFile('/input/parent/parent.txt', 'utf8')",
      "await readFile('/input/archive/catalog.json', 'utf8')",
      "await readFile('/input/evidence/trace.txt', 'utf8')",
      "const processStatus = await readFile('/proc/self/status', 'utf8')",
      'const targetPrivilegesDropped = /^CapEff:\\s+0+$/m.test(processStatus) && /^CapBnd:\\s+0+$/m.test(processStatus) && /^NoNewPrivs:\\s+1$/m.test(processStatus)',
      'let parentWriteDenied = false',
      "try { await writeFile('/input/parent/forbidden.txt', 'x') } catch { parentWriteDenied = true }",
      'let hostPathAbsent = false',
      "try { await access('/root/.ssh') } catch { hostPathAbsent = true }",
      'const undeclaredWritesDenied = []',
      "for (const path of ['/input/forbidden', '/work/forbidden', '/run/forbidden', '/dev/forbidden', '/proc/sys/user/max_user_namespaces']) {",
      '  try { await writeFile(path, "x"); undeclaredWritesDenied.push(false) }',
      '  catch { undeclaredWritesDenied.push(true) }',
      '}',
      'const networkDenied = await new Promise((done) => {',
      "  const socket = connect({ host: '127.0.0.1', port: 9 })",
      "  socket.once('connect', () => { socket.destroy(); done(false) })",
      "  socket.once('error', () => done(true))",
      '})',
      "const nestedUsernsDenied = spawnSync('/usr/bin/unshare', ['--user', '--map-root-user', '/bin/true']).status !== 0",
      'if (!parentWriteDenied || !hostPathAbsent || !networkDenied || !nestedUsernsDenied || !targetPrivilegesDropped || undeclaredWritesDenied.some((value) => !value) || process.env.DEEPSEEK_API_KEY) process.exit(41)',
      "await writeFile('/work/children/result.json', JSON.stringify({ parentWriteDenied, hostPathAbsent, networkDenied, nestedUsernsDenied, targetPrivilegesDropped, undeclaredWritesDenied }))",
      "process.stdout.write('SANDBOX_OK\\n')",
      '',
    ].join('\n')
    await writeFile(join(paths.contracts, 'probe.mjs'), probe)

    const result = await runProposalSandbox({
      mounts: paths,
      command: '/usr/bin/node',
      args: ['/input/contracts/probe.mjs'],
      timeoutMs: 10_000,
    })
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toBe('SANDBOX_OK\n')
    expect(result.timedOut).toBe(false)
    expect(JSON.parse(await readFile(join(paths.childrenRoot, 'result.json'), 'utf8'))).toEqual({
      parentWriteDenied: true,
      hostPathAbsent: true,
      networkDenied: true,
      nestedUsernsDenied: true,
      targetPrivilegesDropped: true,
      undeclaredWritesDenied: [true, true, true, true, true],
    })
    await expect(stat(join(paths.parent, 'forbidden.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('rejects symlinks in inputs before launch and in child output after launch', async () => {
    const paths = await mounts()
    await symlink('/root', join(paths.parent, 'escape'))
    await expect(
      runProposalSandbox({
        mounts: paths,
        command: '/usr/bin/node',
        args: ['-e', 'process.exit(0)'],
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(/symlink/)
    await rm(join(paths.parent, 'escape'))

    await writeFile(
      join(paths.contracts, 'symlink.mjs'),
      "import { symlink } from 'node:fs/promises'; await symlink('/input/parent', '/work/children/escape')\n",
    )
    await expect(
      runProposalSandbox({
        mounts: paths,
        command: '/usr/bin/node',
        args: ['/input/contracts/symlink.mjs'],
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(/symlink/)
  })

  it('kills and drains the whole PID namespace on timeout', async () => {
    const paths = await mounts()
    const marker = `dsh-self-evolving-sandbox-survivor-${process.pid}`
    await writeFile(
      join(paths.contracts, 'survivor.mjs'),
      [
        "import { spawn } from 'node:child_process'",
        `spawn('/bin/sh', ['-c', 'exec -a ${marker} sleep 60'], { detached: true, stdio: 'ignore' })`,
        'setInterval(() => {}, 60_000)',
        '',
      ].join('\n'),
    )
    const result = await runProposalSandbox({
      mounts: paths,
      command: '/usr/bin/node',
      args: ['/input/contracts/survivor.mjs'],
      timeoutMs: 200,
    })
    expect(result.timedOut, JSON.stringify(result)).toBe(true)
    await expect.poll(() => processMarkerExists(marker), { timeout: 5_000 }).toBe(false)
  })

  it('contains writable-tree exhaustion and leaves the trusted seed untouched', async () => {
    const paths = await mounts()
    await writeFile(join(paths.childrenRoot, 'seed.txt'), 'trusted-seed\n')
    await writeFile(
      join(paths.contracts, 'disk-fill.mjs'),
      [
        "import { writeFile } from 'node:fs/promises'",
        'const chunk = Buffer.alloc(1024 * 1024, 1)',
        'for (let index = 0; ; index += 1) {',
        '  try { await writeFile(`/work/children/fill-${index}`, chunk) }',
        "  catch (error) { if (error.code === 'ENOSPC') break; throw error }",
        '}',
        '',
      ].join('\n'),
    )

    const result = await runProposalSandbox({
      mounts: paths,
      command: '/usr/bin/node',
      args: ['/input/contracts/disk-fill.mjs'],
      timeoutMs: 20_000,
    })

    expect(result.resource.terminationCause).toBe('WRITABLE_STORAGE_LIMIT')
    expect(result.exitCode).toBeNull()
    expect(result.resource.usage.writableStoragePeakBytes).toBeLessThanOrEqual(64 * 1024 * 1024)
    expect(await readFile(join(paths.childrenRoot, 'seed.txt'), 'utf8')).toBe('trusted-seed\n')
    expect(await readdir(paths.childrenRoot)).toEqual(['seed.txt'])
  })
})

async function processMarkerExists(marker: string): Promise<boolean> {
  for (const entry of await readdir('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    const command = await readFile(join('/proc', entry.name, 'cmdline'))
      .then((bytes) => bytes.toString('utf8'))
      .catch(() => '')
    if (command.includes(marker)) return true
  }
  return false
}
