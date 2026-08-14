/**
 * Gate 1 — packed capsule offline boot (spec 07 §3 Accept).
 *
 * "packed capsule 在无 source、无网络的 fresh container 中完成 DSH ACP
 * initialize/session".
 *
 * This test packs a capsule from the candidate-baseline, then boots the real
 * Cordis Loader against the CAPSULE's candidate/ contents in an isolated
 * directory that does NOT contain the source checkout. It proves the capsule
 * is self-contained: only the compiled bundle + linked pinned DSH packages
 * are needed. No model is called (model-free); the ACP initialize/session
 * surface is represented by the Loader booting the candidate row and the
 * service being live.
 *
 * This is the offline, no-source, no-network analog of the production task-
 * environment boot. Network isolation is enforced structurally: the fixture
 * directory has no network handle and resolves modules only from its own
 * node_modules (which links only pinned, locally-built DSH packages).
 */
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent as AcpAgent,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk'
import { buildCandidate, packCapsule } from '@dsh-rsi/candidate-sdk'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const baselineRoot = resolve(repoRoot, 'packages', 'candidate-baseline')
const dshRoot = resolve(repoRoot, 'deepseek-harness')
const tscBin = resolve(repoRoot, 'node_modules', '.bin', 'tsc')

const baselineSourceFiles = [
  'src/index.ts',
  'package.json',
  'candidate.json',
  'cordis.patch.yml',
  'tsconfig.json',
]

let scratch: string | undefined
let child: ChildProcessWithoutNullStreams | undefined
let dockerImage: string | undefined

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'dsh-rsi-capsule-'))
})

afterEach(async () => {
  if (child !== undefined) {
    const running = child
    child = undefined
    if (running.exitCode === null && running.signalCode === null) {
      const exited = new Promise<void>((done) => running.once('exit', () => done()))
      running.kill('SIGKILL')
      await exited
    }
  }
  if (dockerImage !== undefined) {
    await execFileResult('/usr/bin/docker', ['image', 'rm', '--force', dockerImage]).catch(() => {})
    dockerImage = undefined
  }
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
  scratch = undefined
})

const CAPSULE_TIMEOUT = { timeout: 120_000 }

const mockAdapterSource = [
  "import { LlmAdapter } from '@deepseek-ai/dsh-llm'",
  'class Gate1Mock extends LlmAdapter {',
  '  async * stream() {',
  "    yield { type: 'block-start', index: 0, blockType: 'text' }",
  "    yield { type: 'text-delta', index: 0, text: 'GATE1 ACP OK' }",
  "    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'GATE1 ACP OK' } }",
  "    yield { type: 'finish', reason: { kind: 'stop' } }",
  '  }',
  '}',
  "export const name = 'gate1-mock'",
  "export const inject = ['llm']",
  "export function apply(ctx) { ctx.llm.registerAdapter(['gate1-mock'], new Gate1Mock()) }",
  '',
].join('\n')

function execFileResult(file: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    execFile(file, args, cwd === undefined ? {} : { cwd }, (error, stdout, stderr) => {
      if (error) rejectRun(new Error(`${file} failed: ${stderr}`, { cause: error }))
      else resolveRun(stdout)
    })
  })
}

async function copyAbsoluteFile(source: string, rootfs: string): Promise<void> {
  const destination = join(rootfs, source.replace(/^\/+/, ''))
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { dereference: true })
}

async function materializeScratchNodeRootfs(rootfs: string, capsuleDir: string): Promise<void> {
  await copyAbsoluteFile(process.execPath, rootfs)
  const nativeModules: string[] = []
  async function findNative(dir: string): Promise<void> {
    for (const entry of await import('node:fs/promises').then((fs) =>
      fs.readdir(dir, { withFileTypes: true }),
    )) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await findNative(path)
      else if (entry.isFile() && entry.name.endsWith('.node')) nativeModules.push(path)
    }
  }
  await findNative(join(capsuleDir, 'runtime'))
  const binaries = [process.execPath, ...nativeModules]
  const libraries = new Set<string>()
  for (const binary of binaries) {
    const output = await execFileResult('/usr/bin/ldd', [binary])
    for (const line of output.split('\n')) {
      const match = /(?:=>\s+)?(\/[^\s]+)\s+\(0x[0-9a-f]+\)/i.exec(line)
      if (match?.[1] !== undefined) libraries.add(match[1])
    }
  }
  for (const library of [...libraries].sort()) await copyAbsoluteFile(library, rootfs)
}

describe('Gate 1 — packed capsule offline boot', () => {
  it(
    'a packed capsule boots the real Loader with no source checkout present',
    CAPSULE_TIMEOUT,
    async () => {
      // 1. Build the candidate and pack a capsule.
      const receipt = await buildCandidate({
        sourceRoot: baselineRoot,
        sourceFiles: baselineSourceFiles,
        tscBin,
      })
      const capsuleDir = join(scratch!, 'capsule')
      await packCapsule({
        outDir: capsuleDir,
        receipt,
        candidateSourceRoot: baselineRoot,
        runnerOverlay: [
          '- id: mock-llm',
          "  name: './mock-llm.mjs'",
          '- id: acp-agent',
          "  name: '@deepseek-ai/dsh-acp-demo'",
          '  config:',
          '    provider: gate1-mock',
          '    model: gate1-mock',
          "    persona: 'Gate 1 capsule acceptance agent.'",
          '    workspaceContext: false',
          '- id: rsi-candidate',
          "  name: '@dsh-rsi/candidate-baseline'",
          '  config:',
          '    candidateId: baseline',
          '    mode: solve',
          '',
        ].join('\n'),
        provenanceJson: '{"dsh":"pinned"}',
        sbomJson: '{"spdxVersion":"SPDX-2.3"}',
        runnerFiles: { 'mock-llm.mjs': mockAdapterSource },
        runtimeClosure: {
          catalogRoots: [join(dshRoot, 'packages'), join(dshRoot, 'vendor')],
          seedPackages: ['@deepseek-ai/dsh-acp-demo'],
          entryPackage: '@deepseek-ai/dsh-acp-demo',
          entryBin: 'lib/bin.js',
        },
      })

      // The Gate 1 capsule must contain executable runtime bytes, not an
      // INSTALL.md promise that resolves packages from the source checkout.
      await expect(stat(join(capsuleDir, 'runtime', 'package-closure.json'))).resolves.toBeDefined()
      await expect(stat(join(capsuleDir, 'runtime', 'bin', 'dsh-rsi-acp'))).resolves.toBeDefined()
      await expect(stat(join(capsuleDir, 'runtime', 'INSTALL.md'))).rejects.toMatchObject({
        code: 'ENOENT',
      })

      // 2. Create an isolated boot dir that has NO source checkout — only the
      //    capsule's candidate/ contents and the pinned DSH packages linked in.
      const bootDir = join(scratch!, 'boot')
      await mkdir(join(bootDir, 'node_modules', '@deepseek-ai'), { recursive: true })
      await mkdir(join(bootDir, 'node_modules', '@dsh-rsi'), { recursive: true })

      // Copy (not symlink) the capsule's candidate/ into the boot dir so Node
      // resolves the candidate's transitive deps from bootDir/node_modules —
      // matching how a task environment unpacks a capsule and installs its
      // runtime closure into the resolution path. A symlink would resolve from
      // the capsule's own (dep-less) directory.
      await cp(
        join(capsuleDir, 'candidate'),
        join(bootDir, 'node_modules', '@dsh-rsi', 'candidate-baseline'),
        { recursive: true },
      )
      // Link pinned DSH packages (already-built, local — no network).
      await symlink(
        join(dshRoot, 'vendor', 'cordis'),
        join(bootDir, 'node_modules', '@deepseek-ai', 'cordis'),
        'dir',
      )
      await symlink(
        join(dshRoot, 'vendor', 'schemastery'),
        join(bootDir, 'node_modules', '@deepseek-ai', 'schemastery'),
        'dir',
      )
      await symlink(
        join(dshRoot, 'vendor', 'cosmokit'),
        join(bootDir, 'node_modules', '@deepseek-ai', 'cosmokit'),
        'dir',
      )
      await symlink(
        join(dshRoot, 'packages', 'core', 'system-prompt'),
        join(bootDir, 'node_modules', '@deepseek-ai', 'dsh-system-prompt'),
        'dir',
      )
      await symlink(
        join(dshRoot, 'vendor', 'loader'),
        join(bootDir, 'node_modules', '@deepseek-ai', 'cordis-plugin-loader'),
        'dir',
      )
      await symlink(
        join(dshRoot, 'vendor', 'include'),
        join(bootDir, 'node_modules', '@deepseek-ai', 'cordis-plugin-include'),
        'dir',
      )
      await symlink(
        join(dshRoot, 'vendor', 'group'),
        join(bootDir, 'node_modules', '@deepseek-ai', 'cordis-plugin-group'),
        'dir',
      )

      // 3. Write a cordis.yml in the boot dir that mounts the capsule candidate.
      await writeFile(
        join(bootDir, 'cordis.yml'),
        [
          '- id: system-prompt',
          "  name: '@deepseek-ai/dsh-system-prompt'",
          '  config: {}',
          '- id: rsi-candidate',
          "  name: '@dsh-rsi/candidate-baseline'",
          '  config:',
          '    candidateId: baseline',
          '    mode: solve',
          '',
        ].join('\n'),
      )

      // 4. Boot the real Loader against the isolated boot dir.
      const ctx = new Context()
      ctx.baseUrl = pathToFileURL(join(bootDir, 'cordis.yml')).href
      await ctx.plugin(Loader)
      const c = ctx as unknown as Context & {
        loader: {
          internal?: { version: string; import: (s: string) => Promise<unknown> }
          builtins: { include: unknown; group: unknown }
          create: (opts: { id: string; name: string; config: unknown }) => Promise<string>
          await: () => Promise<void>
          entries: () => Iterable<{ options: { id: string; name: string } }>
        }
        get: <T = unknown>(name: string) => T | undefined
      }
      const bootRequire = createRequire(join(bootDir, 'package.json'))
      c.loader.internal = {
        version: 'v2',
        async import(specifier: string) {
          return await import(pathToFileURL(bootRequire.resolve(specifier)).href)
        },
      }
      c.loader.builtins.include = Include
      c.loader.builtins.group = Group
      await c.loader.create({
        id: 'include',
        name: 'cordis:include',
        config: { path: pathToFileURL(join(bootDir, 'cordis.yml')).href },
      })
      await c.loader.await()

      // 5. The capsule candidate booted: row active, service live.
      const entries = [...c.loader.entries()].map((e) => `${e.options.id}:${e.options.name}`)
      expect(entries).toContain('rsi-candidate:@dsh-rsi/candidate-baseline')
      expect(c.get('systemPrompt')).toBeDefined()

      // 6. The capsule manifest + SHA256SUMS exist and are internally consistent.
      const capsuleManifest = JSON.parse(await readFile(join(capsuleDir, 'capsule.json'), 'utf8'))
      expect(capsuleManifest.candidateId).toBe(receipt.candidateId)
      const sums = await readFile(join(capsuleDir, 'SHA256SUMS'), 'utf8')
      expect(sums).not.toContain('  capsule.json')
      expect(sums).toContain('candidate/lib/index.js')
      expect(sums).not.toMatch(/runtime\/node_modules\/@deepseek-ai\/dsh-[^/]+\/(?:src|tests)\//)

      await ctx.fiber.dispose()
    },
  )

  it(
    'runs ACP initialize and session/new from the packed closure without source-checkout resolution',
    CAPSULE_TIMEOUT,
    async () => {
      const receipt = await buildCandidate({
        sourceRoot: baselineRoot,
        sourceFiles: baselineSourceFiles,
        tscBin,
      })
      const capsuleDir = join(scratch!, 'self-contained-capsule')
      await packCapsule({
        outDir: capsuleDir,
        receipt,
        candidateSourceRoot: baselineRoot,
        runnerOverlay: [
          '- id: mock-llm',
          "  name: './mock-llm.mjs'",
          '- id: acp-agent',
          "  name: '@deepseek-ai/dsh-acp-demo'",
          '  config:',
          '    provider: gate1-mock',
          '    model: gate1-mock',
          "    persona: 'Gate 1 capsule acceptance agent.'",
          '    workspaceContext: false',
          '- id: rsi-candidate',
          "  name: '@dsh-rsi/candidate-baseline'",
          '  config:',
          '    candidateId: baseline',
          '    mode: solve',
          '',
        ].join('\n'),
        provenanceJson: '{"dsh":"pinned"}',
        sbomJson: '{"spdxVersion":"SPDX-2.3"}',
        runnerFiles: { 'mock-llm.mjs': mockAdapterSource },
        runtimeClosure: {
          catalogRoots: [join(dshRoot, 'packages'), join(dshRoot, 'vendor')],
          seedPackages: ['@deepseek-ai/dsh-acp-demo'],
          entryPackage: '@deepseek-ai/dsh-acp-demo',
          entryBin: 'lib/bin.js',
        },
      })

      const isolatedCwd = join(scratch!, 'acp-workspace')
      await mkdir(isolatedCwd)
      const capsuleBin = join(capsuleDir, 'runtime', 'bin', 'dsh-rsi-acp')
      child = spawn('/usr/bin/unshare', ['-n', '--', capsuleBin], {
        cwd: isolatedCwd,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          DSH_HOME: join(isolatedCwd, '.dsh'),
          DSH_AGENTS_HOME: join(isolatedCwd, '.agents'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const stderr: string[] = []
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => stderr.push(chunk))
      const parentNetworkNamespace = await readlink('/proc/self/ns/net')
      await expect
        .poll(() => readlink(`/proc/${child!.pid}/ns/net`))
        .not.toBe(parentNetworkNamespace)
      const stream = ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      )
      const updates: SessionNotification['update'][] = []
      const makeClient = (_agent: AcpAgent): Client => ({
        sessionUpdate(params: SessionNotification): Promise<void> {
          updates.push(params.update)
          return Promise.resolve()
        },
        requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
          return Promise.resolve({ outcome: { outcome: 'cancelled' } })
        },
      })
      const client = new ClientSideConnection(makeClient, stream)
      try {
        const initialized = await client.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        })
        expect(initialized.agentInfo.name).toBe('deepseek-harness-acp')
        const created = await client.newSession({ cwd: isolatedCwd, mcpServers: [] })
        expect(created.sessionId).toBeTruthy()
        const prompted = await client.prompt({
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'reply with the replay fixture' }],
        })
        expect(prompted.stopReason).toBe('end_turn')
        expect(updates).toContainEqual({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'GATE1 ACP OK' },
        })
      } catch (cause) {
        throw new Error(`packed ACP failed; stderr:\n${stderr.join('')}`, { cause })
      }
      expect(stderr.join('')).not.toContain('/root/dsh-RSI/deepseek-harness')
    },
  )

  it(
    'completes an ACP prompt in a fresh read-only scratch container with network disabled',
    CAPSULE_TIMEOUT,
    async () => {
      const buildContext = join(scratch!, 'docker-context')
      const capsuleDir = join(buildContext, 'capsule')
      await mkdir(buildContext, { recursive: true })
      const receipt = await buildCandidate({
        sourceRoot: baselineRoot,
        sourceFiles: baselineSourceFiles,
        tscBin,
      })
      await packCapsule({
        outDir: capsuleDir,
        receipt,
        candidateSourceRoot: baselineRoot,
        runnerOverlay: [
          '- id: mock-llm',
          "  name: './mock-llm.mjs'",
          '- id: acp-agent',
          "  name: '@deepseek-ai/dsh-acp-demo'",
          '  config:',
          '    provider: gate1-mock',
          '    model: gate1-mock',
          "    persona: 'Gate 1 capsule acceptance agent.'",
          '    workspaceContext: false',
          '- id: rsi-candidate',
          "  name: '@dsh-rsi/candidate-baseline'",
          '  config:',
          '    candidateId: baseline',
          '    mode: solve',
          '',
        ].join('\n'),
        provenanceJson: '{"dsh":"pinned"}',
        sbomJson: '{"spdxVersion":"SPDX-2.3"}',
        runnerFiles: { 'mock-llm.mjs': mockAdapterSource },
        runtimeClosure: {
          catalogRoots: [join(dshRoot, 'packages'), join(dshRoot, 'vendor')],
          seedPackages: ['@deepseek-ai/dsh-acp-demo'],
          entryPackage: '@deepseek-ai/dsh-acp-demo',
          entryBin: 'lib/bin.js',
        },
      })

      const rootfs = join(buildContext, 'rootfs')
      await materializeScratchNodeRootfs(rootfs, capsuleDir)
      await writeFile(
        join(buildContext, 'Dockerfile'),
        [
          'FROM scratch',
          'COPY rootfs /',
          'COPY capsule /capsule',
          'WORKDIR /work',
          'ENTRYPOINT ["/usr/bin/node", "/capsule/runtime/bin/dsh-rsi-acp"]',
          '',
        ].join('\n'),
      )
      dockerImage = `dsh-rsi-gate1-${process.pid}-${Date.now()}`
      await execFileResult(
        '/usr/bin/docker',
        ['build', '--network', 'none', '--tag', dockerImage, '.'],
        buildContext,
      )
      const containerName = `${dockerImage}-run`
      child = spawn(
        '/usr/bin/docker',
        [
          'run',
          '--rm',
          '--interactive',
          '--name',
          containerName,
          '--network',
          'none',
          '--read-only',
          '--tmpfs',
          '/work:rw,nosuid,nodev,noexec',
          '--env',
          'DSH_HOME=/work/.dsh',
          '--env',
          'DSH_AGENTS_HOME=/work/.agents',
          dockerImage,
        ],
        {
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )
      const stderr: string[] = []
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => stderr.push(chunk))
      await expect
        .poll(() =>
          execFileResult('/usr/bin/docker', [
            'inspect',
            '--format',
            '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.NetworkMode}}',
            containerName,
          ]).catch(() => ''),
        )
        .toBe('true none\n')

      const stream = ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      )
      const updates: SessionNotification['update'][] = []
      const client = new ClientSideConnection(
        (_agent: AcpAgent): Client => ({
          sessionUpdate(params: SessionNotification): Promise<void> {
            updates.push(params.update)
            return Promise.resolve()
          },
          requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
            return Promise.resolve({ outcome: { outcome: 'cancelled' } })
          },
        }),
        stream,
      )
      try {
        await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
        const { sessionId } = await client.newSession({ cwd: '/work', mcpServers: [] })
        const prompted = await client.prompt({
          sessionId,
          prompt: [{ type: 'text', text: 'container replay' }],
        })
        expect(prompted.stopReason).toBe('end_turn')
        expect(updates).toContainEqual({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'GATE1 ACP OK' },
        })
      } catch (cause) {
        throw new Error(`scratch-container ACP failed; stderr:\n${stderr.join('')}`, { cause })
      }
    },
  )
})
