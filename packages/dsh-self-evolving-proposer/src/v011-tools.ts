import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, posix, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import {
  createSourceFile,
  DiagnosticCategory,
  forEachChild,
  isCallExpression,
  isExportDeclaration,
  isImportDeclaration,
  isPropertyAccessExpression,
  isStringLiteralLike,
  ModuleKind,
  ScriptTarget,
  SyntaxKind,
  flattenDiagnosticMessageText,
  transpileModule,
  type Node,
} from 'typescript'
import {
  assertV011,
  canonicalizeV011Tree,
  digestV011,
  scanPaths,
  snapshotV011Tree,
  type FrozenCapabilityCatalog,
  type V011TreeSnapshot,
  type V011Proposal,
} from '@dsh-self-evolving/candidate-sdk'
import {
  validateV011ProposalSemantics,
  type CandidateIntent,
  type ExportManifest,
  type V011ParentEvidenceBinding,
  type V011Analysis,
} from '@dsh-self-evolving/core'

const EDITABLE = [
  /^src\/(?:[^/]+\/)*[^/]+\.ts$/,
  /^tests\/(?:[^/]+\/)*[^/]+\.spec\.ts$/,
  /^fixtures\/(?:[^/]+\/)*[^/]+\.json$/,
  /^README\.md$/,
  /^candidate\.json$/,
]
const MAX_AUTHORING_TOOL_CALLS = 64
const MAX_CORRECTION_TOOL_CALLS = 16
// Validation may legitimately repeat after each fail-closed semantic diagnostic.
// Keep it independently bounded, but align it with the correction budget so the
// final successful finish call cannot be precluded by earlier rejected attempts.
const MAX_CONTROL_TOOL_CALLS = 16

export interface V011ToolRoots {
  parent: string
  archive: string
  evidence: string
  contracts: string
  childTree: string
  slot: string
}

export interface V011ToolState {
  finished: boolean
  /**
   * Digest of the exact child tree that passed the finish_proposal
   * validation; the worker re-verifies the tree against it after the agent
   * turn ends so post-finish mutation cannot reach trusted materialization
   * (issue #125).
   */
  finishedTreeDigest: string | null
  callCount: number
  authoringCallCount: number
  correctionCallCount: number
  controlCallCount: number
  correctionMode: boolean
}

export interface V011ProposalBindings {
  proposalId: string
  parentDigest: `sha256:${string}`
  exportManifestDigest: `sha256:${string}`
  exportMerkleRoot: `sha256:${string}`
  ancestorClusters: string[]
  requiredParentEvidence?: V011ParentEvidenceBinding
}

export function consumeV011ToolBudget(
  state: V011ToolState,
  kind: 'content' | 'control',
  enterCorrection = false,
): void {
  if (kind === 'control') {
    if (state.controlCallCount >= MAX_CONTROL_TOOL_CALLS) {
      throw new Error(`v0.1.1 tool: ${MAX_CONTROL_TOOL_CALLS}-control-call limit exhausted`)
    }
    state.controlCallCount += 1
    state.callCount += 1
    if (enterCorrection) state.correctionMode = true
    return
  }
  if (state.correctionMode) {
    if (state.correctionCallCount >= MAX_CORRECTION_TOOL_CALLS) {
      throw new Error(
        `v0.1.1 tool: ${MAX_CORRECTION_TOOL_CALLS}-call semantic-correction limit exhausted`,
      )
    }
    state.correctionCallCount += 1
  } else {
    if (state.authoringCallCount >= MAX_AUTHORING_TOOL_CALLS) {
      throw new Error(
        `v0.1.1 tool: ${MAX_AUTHORING_TOOL_CALLS}-call authoring limit exhausted; call validate_child or finish_proposal`,
      )
    }
    state.authoringCallCount += 1
  }
  state.callCount += 1
}

function safeRelative(path: string): string {
  if (
    path.length === 0 ||
    path.length > 240 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') ||
    posix.normalize(path) !== path
  ) {
    throw new Error(`v0.1.1 tool: unsafe relative path ${JSON.stringify(path)}`)
  }
  return path
}

export async function validateV011TypeScriptSyntax(
  root: string,
  relativePaths: string[],
): Promise<void> {
  const failures: string[] = []
  for (const relative of relativePaths.filter((path) => path.endsWith('.ts')).sort()) {
    const source = await readFile(join(root, relative), 'utf8')
    const sourceFile = createSourceFile(relative, source, ScriptTarget.ES2022, true)
    let readsSourceText = false
    const checkSpecifier = (node: Node | undefined): void => {
      if (node === undefined || !isStringLiteralLike(node)) return
      const specifier = node.text
      if (
        (specifier.startsWith('./') || specifier.startsWith('../')) &&
        !/\.(?:js|json)$/.test(specifier)
      ) {
        failures.push(`${relative} relative ESM import must end in .js or .json: ${specifier}`)
      }
    }
    const inspect = (node: Node): void => {
      if (
        isCallExpression(node) &&
        ((isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'readFile') ||
          node.expression.getText(sourceFile) === 'readFile')
      ) {
        readsSourceText = true
      }
      if (isImportDeclaration(node) || isExportDeclaration(node)) {
        checkSpecifier(node.moduleSpecifier)
      } else if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
        checkSpecifier(node.arguments[0])
      }
      if (isPropertyAccessExpression(node) && node.name.text === 'onDispose') {
        failures.push(`${relative} Context.onDispose is not a supported Cordis API`)
      }
      forEachChild(node, inspect)
    }
    inspect(sourceFile)
    if (relative.startsWith('tests/') && readsSourceText) {
      failures.push(
        `${relative} reads source files; source-text assertions are comment-sensitive, so import and test exported runtime behavior instead`,
      )
    }
    const result = transpileModule(source, {
      fileName: relative,
      reportDiagnostics: true,
      compilerOptions: {
        module: ModuleKind.NodeNext,
        target: ScriptTarget.ES2022,
      },
    })
    for (const diagnostic of result.diagnostics ?? []) {
      if (diagnostic.category !== DiagnosticCategory.Error) continue
      const position =
        diagnostic.start === undefined
          ? ''
          : (() => {
              const { line, character } = diagnostic.file?.getLineAndCharacterOfPosition(
                diagnostic.start,
              ) ?? {
                line: 0,
                character: diagnostic.start,
              }
              return `:${line + 1}:${character + 1}`
            })()
      failures.push(
        `${relative}${position} ${flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
      )
    }
  }
  if (failures.length > 0) {
    throw new Error(`v0.1.1 tool: TypeScript syntax preflight failed:\n${failures.join('\n')}`)
  }
}

export async function validateV011CandidatePolicy(snapshot: V011TreeSnapshot): Promise<void> {
  const codeFiles = snapshot.files
    .filter((file) => file.path.endsWith('.ts') || file.path.endsWith('.js'))
    .map((file) => ({ path: file.path, absPath: file.absolutePath }))
  const production = codeFiles.filter((file) => !file.path.startsWith('tests/'))
  const tests = codeFiles.filter((file) => file.path.startsWith('tests/'))
  const [productionScan, testScan] = await Promise.all([
    scanPaths(production),
    scanPaths(tests, { extraImportAllowlist: new Set(['vitest']) }),
  ])
  const rejects = [...productionScan.hits, ...testScan.hits].filter(
    (hit) => hit.severity === 'reject',
  )
  if (rejects.length > 0) {
    throw new Error(
      `v0.1.1 tool: candidate policy scan rejected:\n${rejects
        .map((hit) => `  ${hit.path}:${hit.line} ${hit.rule} ${hit.snippet}`)
        .join('\n')}`,
    )
  }
}

function inside(root: string, relative: string): string {
  const absolute = resolve(root, ...safeRelative(relative).split('/'))
  const canonicalRoot = resolve(root)
  if (absolute !== canonicalRoot && !absolute.startsWith(canonicalRoot + sep)) {
    throw new Error('v0.1.1 tool: path escapes root')
  }
  return absolute
}

function writable(path: string): void {
  if (!EDITABLE.some((pattern) => pattern.test(path))) {
    throw new Error(`v0.1.1 tool: write outside editable surface: ${path}`)
  }
}

async function assertNoLink(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null)
  if (info?.isSymbolicLink()) throw new Error(`v0.1.1 tool: symlink rejected: ${path}`)
}

async function files(root: string): Promise<string[]> {
  const output: string[] = []
  async function walk(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const absolute = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`v0.1.1 tool: link in read tree: ${absolute}`)
      if (entry.isDirectory()) await walk(absolute)
      else if (entry.isFile())
        output.push(
          absolute
            .slice(root.length + 1)
            .split(sep)
            .join('/'),
        )
      else throw new Error(`v0.1.1 tool: special file in read tree: ${absolute}`)
    }
  }
  await walk(root)
  return output
}

async function runCandidateTests(root: string): Promise<{ tests: number; output: string }> {
  const relativeTests = (await files(root)).filter(
    (path) => path.startsWith('tests/') && path.endsWith('.spec.ts'),
  )
  if (relativeTests.length === 0) throw new Error('v0.1.1 tool: child has no candidate-owned tests')
  const testRoot = await mkdtemp('/tmp/dsh-self-evolving-candidate-tests-')
  try {
    await cp(root, testRoot, { recursive: true })
    await writeFile(
      join(testRoot, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            skipLibCheck: true,
          },
          include: ['src/**/*.ts', 'tests/**/*.ts'],
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    )
    const tests = relativeTests.map((path) => join(testRoot, path))
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (done, reject) => {
        const child = spawn(
          '/runtime/node',
          [
            '/node_modules/vitest/vitest.mjs',
            'run',
            '--root',
            testRoot,
            '--cache=false',
            '--no-file-parallelism',
            ...tests,
          ],
          {
            cwd: testRoot,
            env: { PATH: '/usr/bin:/bin' },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        let bytes = 0
        let settled = false
        const kill = () => {
          if (child.pid !== undefined) child.kill('SIGKILL')
        }
        const timer = setTimeout(kill, 120_000)
        const collect = (target: Buffer[]) => (chunk: Buffer) => {
          bytes += chunk.byteLength
          if (bytes > 256 * 1024) kill()
          else target.push(chunk)
        }
        child.stdout.on('data', collect(stdout))
        child.stderr.on('data', collect(stderr))
        child.once('error', (error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(error)
        })
        child.once('exit', (code) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          done({
            code,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
          })
        })
      },
    )
    const output = `${result.stderr}\n${result.stdout}`.trim()
    if (result.code !== 0) {
      throw new Error(`v0.1.1 tool: candidate tests failed before proposal finish:\n${output}`)
    }
    return { tests: tests.length, output }
  } finally {
    await rm(testRoot, { recursive: true, force: true })
  }
}

function render(value: unknown) {
  return [
    { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) },
  ]
}

export function installV011Tools(
  ctx: Context,
  roots: V011ToolRoots,
  bindings: V011ProposalBindings,
): V011ToolState {
  const state: V011ToolState = {
    finished: false,
    finishedTreeDigest: null,
    callCount: 0,
    authoringCallCount: 0,
    correctionCallCount: 0,
    controlCallCount: 0,
    correctionMode: false,
  }
  const counted = <T extends (...args: never[]) => unknown>(fn: T): T =>
    (async (...args: Parameters<T>) => {
      if (state.finished) {
        throw new Error('v0.1.1 tool: the proposal is finished — no further authoring is allowed')
      }
      consumeV011ToolBudget(state, 'content')
      return fn(...args)
    }) as T
  const controlled = <T extends (...args: never[]) => unknown>(fn: T, enterCorrection = false): T =>
    (async (...args: Parameters<T>) => {
      consumeV011ToolBudget(state, 'control', enterCorrection)
      return fn(...args)
    }) as T

  const readRoots: Record<string, string> = {
    parent: roots.parent,
    archive: roots.archive,
    evidence: roots.evidence,
    contracts: roots.contracts,
    child: roots.childTree,
  }

  ctx.tools.register(
    defineContentToolFixture({
      name: 'list_files',
      description: 'List files in one bounded proposal mount.',
      parameters: { root: { type: 'string', required: true, enum: Object.keys(readRoots) } },
      execute: counted(async (args: { root: string }) => {
        const root = readRoots[args.root]
        if (root === undefined) throw new Error('v0.1.1 tool: unknown read root')
        return render((await files(root)).slice(0, 500).join('\n'))
      }),
    }),
  )
  ctx.tools.register(
    defineContentToolFixture({
      name: 'read_file',
      description: 'Read one UTF-8 file from a bounded proposal mount.',
      parameters: {
        root: { type: 'string', required: true, enum: Object.keys(readRoots) },
        path: { type: 'string', required: true },
      },
      execute: counted(async (args: { root: string; path: string }) => {
        const root = readRoots[args.root]
        if (root === undefined) throw new Error('v0.1.1 tool: unknown read root')
        const path = inside(root, args.path)
        await assertNoLink(path)
        const bytes = await readFile(path)
        if (bytes.byteLength > 128 * 1024) throw new Error('v0.1.1 tool: read exceeds 128 KiB')
        return render(bytes.toString('utf8'))
      }),
    }),
  )
  ctx.tools.register(
    defineContentToolFixture({
      name: 'search_text',
      description: 'Search literal text across one bounded proposal mount.',
      parameters: {
        root: { type: 'string', required: true, enum: Object.keys(readRoots) },
        query: { type: 'string', required: true },
      },
      execute: counted(async (args: { root: string; query: string }) => {
        if (args.query.length === 0 || args.query.length > 256)
          throw new Error('v0.1.1 tool: invalid query')
        const root = readRoots[args.root]
        if (root === undefined) throw new Error('v0.1.1 tool: unknown read root')
        const hits: string[] = []
        for (const relative of await files(root)) {
          const bytes = await readFile(inside(root, relative))
          if (bytes.byteLength > 128 * 1024) continue
          for (const [index, line] of bytes.toString('utf8').split('\n').entries()) {
            if (line.includes(args.query))
              hits.push(`${relative}:${index + 1}:${line.slice(0, 500)}`)
            if (hits.length >= 100) return render(hits.join('\n'))
          }
        }
        return render(hits.join('\n'))
      }),
    }),
  )
  ctx.tools.register(
    defineContentToolFixture({
      name: 'write_file',
      description: 'Create or replace one file in the preassigned child tree.',
      parameters: {
        path: { type: 'string', required: true },
        content: { type: 'string', required: true },
      },
      execute: counted(async (args: { path: string; content: string }) => {
        const relative = safeRelative(args.path)
        if (Buffer.byteLength(args.content) > 256 * 1024 || args.content.includes('\0')) {
          throw new Error('v0.1.1 tool: write exceeds byte policy')
        }
        const metadata = relative === 'analysis.json' || relative === 'proposal.json'
        if (!metadata) writable(relative)
        const path = inside(metadata ? roots.slot : roots.childTree, relative)
        await assertNoLink(path)
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        await writeFile(path, args.content, { mode: 0o600 })
        if (!metadata) await snapshotV011Tree(roots.childTree)
        return render({ written: relative, bytes: Buffer.byteLength(args.content) })
      }),
    }),
  )
  ctx.tools.register(
    defineContentToolFixture({
      name: 'remove_file',
      description: 'Remove one editable file from the preassigned child tree.',
      parameters: { path: { type: 'string', required: true } },
      execute: counted(async (args: { path: string }) => {
        const relative = safeRelative(args.path)
        writable(relative)
        if (relative === 'src/index.ts') throw new Error('v0.1.1 tool: src/index.ts is mandatory')
        const path = inside(roots.childTree, relative)
        await assertNoLink(path)
        await rm(path)
        await snapshotV011Tree(roots.childTree)
        return render({ removed: relative })
      }),
    }),
  )
  ctx.tools.register(
    defineContentToolFixture({
      name: 'validate_child',
      description:
        'Run containment, TypeScript syntax, successor-schema, and candidate tests on the current child tree.',
      parameters: {},
      execute: controlled(async () => {
        const snapshot = await snapshotV011Tree(roots.childTree)
        await validateV011TypeScriptSyntax(
          roots.childTree,
          snapshot.files.map((file) => file.path),
        )
        await validateV011CandidatePolicy(snapshot)
        const candidate = JSON.parse(
          await readFile(join(roots.childTree, 'candidate.json'), 'utf8'),
        ) as unknown
        await assertV011('candidate-intent', candidate)
        const tests = await runCandidateTests(roots.childTree)
        return render({
          files: snapshot.files.length,
          sourceBytes: snapshot.sourceBytes,
          schema: 'PASS',
          candidateTests: tests.tests,
        })
      }),
    }),
  )
  ctx.tools.register(
    defineContentToolFixture({
      name: 'finish_proposal',
      description: 'Validate final analysis and proposal files and finish this proposal attempt.',
      parameters: {},
      execute: controlled(async () => {
        const analysis = JSON.parse(
          await readFile(join(roots.slot, 'analysis.json'), 'utf8'),
        ) as V011Analysis
        const proposal = JSON.parse(await readFile(join(roots.slot, 'proposal.json'), 'utf8')) as {
          proposalId?: unknown
        } & V011Proposal
        const candidateIntent = JSON.parse(
          await readFile(join(roots.childTree, 'candidate.json'), 'utf8'),
        ) as CandidateIntent
        await Promise.all([
          assertV011('analysis', analysis),
          assertV011('proposal', proposal),
          assertV011('candidate-intent', candidateIntent),
        ])
        if (proposal.proposalId !== bindings.proposalId)
          throw new Error('v0.1.1 tool: proposal ID is not reserved ID')
        const [exportManifest, capabilityCatalog] = (await Promise.all([
          readFile(join(roots.evidence, 'manifest.json'), 'utf8').then(
            (raw) => JSON.parse(raw) as ExportManifest,
          ),
          readFile(join(roots.contracts, 'capability-catalog.json'), 'utf8').then(
            (raw) => JSON.parse(raw) as FrozenCapabilityCatalog,
          ),
        ])) as [ExportManifest, FrozenCapabilityCatalog]
        await validateV011ProposalSemantics({
          parentRoot: roots.parent,
          childRoot: roots.childTree,
          exportRoot: roots.evidence,
          exportManifest,
          expected: {
            proposalId: bindings.proposalId,
            parentDigest: bindings.parentDigest,
            exportManifestDigest: bindings.exportManifestDigest,
            exportMerkleRoot: bindings.exportMerkleRoot,
          },
          capabilityCatalog,
          proposal,
          analysis,
          candidateIntent,
          ancestorClustersRequiringReconciliation: bindings.ancestorClusters,
          ...(bindings.requiredParentEvidence === undefined
            ? {}
            : { requiredParentEvidence: bindings.requiredParentEvidence }),
        })
        const snapshot = await snapshotV011Tree(roots.childTree)
        await validateV011CandidatePolicy(snapshot)
        await runCandidateTests(roots.childTree)
        // Atomically bind the finish receipt to the exact validated bytes.
        const canonical = await canonicalizeV011Tree(snapshot)
        state.finishedTreeDigest = digestV011(canonical.bytes)
        state.finished = true
        return render({ status: 'PROPOSAL_SEMANTICS_VALID', proposalId: bindings.proposalId })
      }, true),
    }),
  )
  return state
}
