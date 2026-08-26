import { createHash } from 'node:crypto'
import ts from 'typescript'
import { cp, lstat, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, posix, resolve, sep } from 'node:path'
import { buildCanonicalArchive, type CanonicalArchive } from '../identity/canonical-tar.js'
import type { TreeOperation } from './contract.js'

export interface V011ContainmentLimits {
  maxFiles: number
  maxSourceBytes: number
  maxChangedLines: number
  maxTestFiles: number
  maxFixtureBytes: number
}

export const V011_DEFAULT_LIMITS: V011ContainmentLimits = {
  maxFiles: 25,
  maxSourceBytes: 1024 * 1024,
  maxChangedLines: 5000,
  maxTestFiles: 10,
  maxFixtureBytes: 256 * 1024,
}

const READ_ONLY = new Set(['package.json', 'cordis.patch.yml', 'tsconfig.json'])
const EDITABLE = [
  /^src\/(?:[^/]+\/)*[^/]+\.ts$/,
  /^tests\/(?:[^/]+\/)*[^/]+\.spec\.ts$/,
  /^fixtures\/(?:[^/]+\/)*[^/]+\.json$/,
  /^README\.md$/,
  /^candidate\.json$/,
]

export interface TreeFile {
  path: string
  absolutePath: string
  bytes: number
  digest: string
}

export interface V011TreeSnapshot {
  root: string
  files: TreeFile[]
  sourceBytes: number
  fixtureBytes: number
  testFiles: number
}

export interface V011TreeDiff {
  operations: TreeOperation[]
  changedLines: number
  productionChanged: boolean
}

function validateRelativePath(path: string): void {
  if (
    path.length === 0 ||
    path.length > 180 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') ||
    posix.normalize(path) !== path
  ) {
    throw new Error(`v0.1.1 containment: invalid path ${JSON.stringify(path)}`)
  }
}

function editable(path: string): boolean {
  return EDITABLE.some((pattern) => pattern.test(path))
}

async function walkTree(root: string): Promise<TreeFile[]> {
  const files: TreeFile[] = []
  const seen = new Set<string>()
  async function walk(directory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      Buffer.from(left.name).compare(Buffer.from(right.name)),
    )
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name)
      const info = await lstat(absolutePath)
      if (info.isSymbolicLink()) {
        throw new Error(`v0.1.1 containment: symlink rejected: ${absolutePath}`)
      }
      if (info.isDirectory()) {
        await walk(absolutePath)
        continue
      }
      if (!info.isFile())
        throw new Error(`v0.1.1 containment: special file rejected: ${absolutePath}`)
      if (info.nlink !== 1)
        throw new Error(`v0.1.1 containment: hardlink rejected: ${absolutePath}`)
      const relative = absolutePath
        .slice(root.length + 1)
        .split(sep)
        .join('/')
      validateRelativePath(relative)
      const collision = relative.normalize('NFC').toLocaleLowerCase('en-US')
      if (seen.has(collision))
        throw new Error(`v0.1.1 containment: Unicode/case collision: ${relative}`)
      seen.add(collision)
      const bytes = await readFile(absolutePath)
      if (bytes.includes(0)) throw new Error(`v0.1.1 containment: NUL byte rejected: ${relative}`)
      files.push({
        path: relative,
        absolutePath,
        bytes: bytes.byteLength,
        digest: createHash('sha256').update(bytes).digest('hex'),
      })
    }
  }
  await walk(root)
  return files
}

export async function snapshotV011Tree(
  inputRoot: string,
  limits: V011ContainmentLimits = V011_DEFAULT_LIMITS,
): Promise<V011TreeSnapshot> {
  const root = resolve(inputRoot)
  const info = await lstat(root)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('v0.1.1 containment: tree root must be a real directory')
  }
  const files = await walkTree(root)
  if (files.length > limits.maxFiles) {
    throw new Error(`v0.1.1 containment: file count ${files.length} exceeds ${limits.maxFiles}`)
  }
  const sourceBytes = files.reduce((total, file) => total + file.bytes, 0)
  if (sourceBytes > limits.maxSourceBytes) {
    throw new Error(
      `v0.1.1 containment: source bytes ${sourceBytes} exceed ${limits.maxSourceBytes}`,
    )
  }
  const fixtureBytes = files
    .filter((file) => file.path.startsWith('fixtures/'))
    .reduce((total, file) => total + file.bytes, 0)
  if (fixtureBytes > limits.maxFixtureBytes) {
    throw new Error(
      `v0.1.1 containment: fixture bytes ${fixtureBytes} exceed ${limits.maxFixtureBytes}`,
    )
  }
  const testFiles = files.filter((file) => file.path.startsWith('tests/')).length
  if (testFiles > limits.maxTestFiles) {
    throw new Error(`v0.1.1 containment: test count ${testFiles} exceeds ${limits.maxTestFiles}`)
  }
  if (!files.some((file) => file.path === 'src/index.ts')) {
    throw new Error('v0.1.1 containment: src/index.ts is mandatory')
  }
  for (const fixture of files.filter((file) => file.path.startsWith('fixtures/'))) {
    try {
      JSON.parse(await readFile(fixture.absolutePath, 'utf8'))
    } catch (error) {
      throw new Error(`v0.1.1 containment: invalid JSON fixture ${fixture.path}`, { cause: error })
    }
  }
  return { root, files, sourceBytes, fixtureBytes, testFiles }
}

/**
 * Order-aware line edit distance: removals plus additions implied by the
 * longest common subsequence of lines. A pure multiset comparison would count
 * reordered existing lines as zero changes although reordering can completely
 * change program behavior.
 */
export function changedLineCount(parent: string, child: string): number {
  const a = parent.split('\n')
  const b = child.split('\n')
  // LCS length via rolling rows. Pathological giant files fall back to the
  // total line count, a strict upper bound on any edit distance (fail closed).
  if (a.length * b.length > 25_000_000) return a.length + b.length
  let previous = new Int32Array(b.length + 1)
  let current = new Int32Array(b.length + 1)
  for (let i = 1; i <= a.length; i += 1) {
    const line = a[i - 1]!
    for (let j = 1; j <= b.length; j += 1) {
      current[j] =
        line === b[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!)
    }
    ;[previous, current] = [current, previous]
  }
  const common = previous[b.length]!
  return a.length - common + (b.length - common)
}

const behaviorPrinter = ts.createPrinter({
  removeComments: true,
  newLine: ts.NewLineKind.LineFeed,
})

/**
 * Build a grammar-aware production projection. TypeScript parses string,
 * template, regular-expression, and comment boundaries; the printer then
 * removes only trivia/comments while preserving executable literal values.
 * Invalid source is returned verbatim so a parse failure can never hide a
 * real textual change before the trusted build rejects it.
 */
function behaviorText(source: string): string {
  const sourceFile = ts.createSourceFile(
    'candidate.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const diagnostics = (
    sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics
  if (diagnostics !== undefined && diagnostics.length > 0) return source
  return behaviorPrinter.printFile(sourceFile)
}

export async function deriveV011Operations(
  parent: V011TreeSnapshot,
  child: V011TreeSnapshot,
  limits: V011ContainmentLimits = V011_DEFAULT_LIMITS,
): Promise<V011TreeDiff> {
  const left = new Map(parent.files.map((file) => [file.path, file]))
  const right = new Map(child.files.map((file) => [file.path, file]))
  const operations: TreeOperation[] = []
  let changedLines = 0
  let productionChanged = false
  for (const path of [...new Set([...left.keys(), ...right.keys()])].sort((a, b) =>
    Buffer.from(a).compare(Buffer.from(b)),
  )) {
    const before = left.get(path)
    const after = right.get(path)
    if (before?.digest === after?.digest) continue
    const op: TreeOperation['op'] =
      before === undefined ? 'add' : after === undefined ? 'remove' : 'modify'
    if (READ_ONLY.has(path))
      throw new Error(`v0.1.1 containment: trusted template changed: ${path}`)
    if (!editable(path))
      throw new Error(`v0.1.1 containment: operation outside editable surface: ${path}`)
    operations.push({ op, path })
    const beforeText = before === undefined ? '' : await readFile(before.absolutePath, 'utf8')
    const afterText = after === undefined ? '' : await readFile(after.absolutePath, 'utf8')
    changedLines += changedLineCount(beforeText, afterText)
    if (path.startsWith('src/') && behaviorText(beforeText) !== behaviorText(afterText)) {
      productionChanged = true
    }
  }
  if (changedLines > limits.maxChangedLines) {
    throw new Error(
      `v0.1.1 containment: changed lines ${changedLines} exceed ${limits.maxChangedLines}`,
    )
  }
  if (operations.length === 0) throw new Error('v0.1.1 containment: no-change child rejected')
  if (!productionChanged) {
    throw new Error('v0.1.1 containment: test/comment/format/manifest-only child rejected')
  }
  return { operations, changedLines, productionChanged }
}

export function assertDeclaredOperations(
  derived: readonly TreeOperation[],
  declared: readonly TreeOperation[],
): void {
  const render = (rows: readonly TreeOperation[]) =>
    rows
      .map((row) => `${row.op}:${row.path}`)
      .sort()
      .join('\n')
  if (render(derived) !== render(declared)) {
    throw new Error('v0.1.1 containment: declared operations do not exactly match actual tree diff')
  }
}

export async function materializeV011ChildSlot(
  parentRoot: string,
  childRoot: string,
): Promise<void> {
  if ((await stat(childRoot).catch(() => null)) !== null) {
    throw new Error(`v0.1.1 reservation: child slot already exists: ${childRoot}`)
  }
  await mkdir(dirname(childRoot), { recursive: true, mode: 0o700 })
  await cp(parentRoot, childRoot, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
    preserveTimestamps: false,
  })
  await snapshotV011Tree(childRoot)
}

export async function canonicalizeV011Tree(tree: V011TreeSnapshot): Promise<CanonicalArchive> {
  return buildCanonicalArchive(
    tree.files.map((file) => ({ path: file.path, absPath: file.absolutePath })),
    {
      maxFileBytes: 256 * 1024,
      maxFileCount: V011_DEFAULT_LIMITS.maxFiles,
      maxTotalBytes: V011_DEFAULT_LIMITS.maxSourceBytes,
    },
  )
}
