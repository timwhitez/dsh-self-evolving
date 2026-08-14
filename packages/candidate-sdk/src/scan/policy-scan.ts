/**
 * Policy scanner (spec 02 §8 import/dependency policy, §9 task-agnostic policy).
 *
 * This is a procedural static guard, not a full malicious-code proof. It flags:
 *  - dynamic import() / require / eval / Function / vm / native addon / path traversal;
 *  - imports outside the pinned @deepseek-ai/* + candidate-relative allowlist;
 *  - node:* imports beyond a tiny pre-registered pure-utility list (default empty);
 *  - credential-shaped secrets in source/config;
 *  - TB task names, verifier/test filenames, expected-output-shaped literals.
 *
 * Default disposition for a hit is REJECT. False positives may only be added to
 * an allowlist by trusted human review BEFORE a search starts; a run may never
 * exempt a candidate by its own score.
 */
import { readFile } from 'node:fs/promises'

export interface ScanHit {
  rule: string
  severity: 'reject' | 'review'
  path: string
  line: number
  snippet: string
}

export interface ScanResult {
  hits: ScanHit[]
  /** True iff no `reject` hit (review hits are reported but do not block). */
  passed: boolean
}

/** Allowlist of @deepseek-ai/* packages a candidate may import (spec 02 §8). */
export const DEFAULT_DSH_ALLOWLIST: ReadonlySet<string> = new Set([
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/cosmokit',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
])

/** node: builtins a candidate may import (default empty per spec 02 §8). */
export const DEFAULT_NODE_ALLOWLIST: ReadonlySet<string> = new Set([])

/**
 * Patterns whose presence is an immediate REJECT (spec 02 §8 forbidden surface).
 * Line-anchored regexes applied to raw source text; the scanner is intentionally
 * conservative — a candidate that needs an escape hatch must request it up front.
 */
const REJECT_PATTERNS: { rule: string; re: RegExp }[] = [
  { rule: 'dynamic-import', re: /\bimport\s*\(/ },
  { rule: 'require-call', re: /(^|[^.\w])require\s*\(/ },
  { rule: 'eval', re: /\beval\s*\(/ },
  { rule: 'function-constructor', re: /\bnew\s+Function\s*\(/ },
  { rule: 'vm-module', re: /\brequire\s*\(\s*['"]node:vm['"]\)|\bfrom\s+['"]node:vm['"]/ },
  {
    rule: 'child-process',
    re: /\bfrom\s+['"]node:child_process['"]|require\s*\(\s*['"]node:child_process['"]/,
  },
  { rule: 'native-addon', re: /\.node['"]|node-addon|koffi|ffi-napi/ },
  // path-traversal: flag `..` only inside string-literal module specifiers or
  // join/resolve arguments, not inside comments or generic prose. We match the
  // common dangerous forms: '../...' or "..\\..." used as a path segment.
  { rule: 'path-traversal', re: /['"]\.\.[\\/]|require\s*\(\s*['"]\.\./ },
  // default-export: only a real `export default` STATEMENT at line start (after
  // optional whitespace). This avoids matching the phrase inside comments/doc
  // strings that merely discuss the defect (e.g. the baseline's own warning).
  { rule: 'default-export', re: /^\s*export\s+default\b/m },
]

/** Credential-shaped patterns (REJECT). */
const SECRET_PATTERNS: { rule: string; re: RegExp }[] = [
  {
    rule: 'secret-api-key',
    re: /\b(?:sk-|api[_-]?key|secret|password|token)\b['"]?\s*[:=]\s*['"][A-Za-z0-9_-]{16,}['"]/i,
  },
  { rule: 'secret-private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule: 'secret-bearer', re: /\bBearer\s+[A-Za-z0-9_.-]{20,}/ },
]

/** TB task/verifier fingerprint patterns (REJECT — spec 02 §9).
 *
 * These flag concrete task SLUGS and verifier filenames, not the benchmark's
 * own name. "Terminal-Bench" may appear in neutral prompts (the candidate
 * legitimately solves TB tasks); a specific task slug like `extract-elf` or a
 * verifier filename like `test_solution.py` is a task-specific fingerprint. */
const TASK_FINGERPRINT_PATTERNS: { rule: string; re: RegExp }[] = [
  // TB task slug (kebab-case, appears as a literal string). Concrete known
  // slugs + the generic "task-id-like" literal.
  {
    rule: 'tb-task-name-literal',
    re: /['"`](extract-elf|gh-issue-pr|fix-nix-build|nix-packaging)['"`]/,
  },
  // Verifier/test filenames typical of TB.
  { rule: 'tb-verifier-file', re: /\b(test_solution|run_tests|verify\.py|solution\.sh)\b/ },
  // dataset repo path to the task source.
  { rule: 'tb-dataset-path', re: /original-tasks\//i },
]

export interface ScanOptions {
  dshAllowlist?: ReadonlySet<string>
  nodeAllowlist?: ReadonlySet<string>
  /** Extra import specifiers (substrings) to permit, from a pre-registered allowlist. */
  extraImportAllowlist?: ReadonlySet<string>
}

/** Extract static import specifiers from a TS/JS source string. */
function extractImports(src: string): { specifier: string; line: number }[] {
  const out: { specifier: string; line: number }[] = []
  const re =
    /\bimport\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const specifier = m[1] ?? m[2]
    if (specifier) {
      const line = src.slice(0, m.index).split('\n').length
      out.push({ specifier, line })
    }
  }
  return out
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split('\n').length
}

function snippet(src: string, index: number): string {
  const lineStart = src.lastIndexOf('\n', index) + 1
  const lineEnd = src.indexOf('\n', index)
  return src
    .slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
    .trim()
    .slice(0, 120)
}

/** Make a regex global without duplicating flags. Preserves existing i/m/s/u/y. */
function asGlobal(re: RegExp): RegExp {
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g'
  return new RegExp(re.source, flags)
}

/**
 * Scan one file's content. Returns all hits; caller aggregates and decides.
 */
export function scanSource(path: string, src: string, opts: ScanOptions = {}): ScanHit[] {
  const dsh = opts.dshAllowlist ?? DEFAULT_DSH_ALLOWLIST
  const node = opts.nodeAllowlist ?? DEFAULT_NODE_ALLOWLIST
  const extra = opts.extraImportAllowlist ?? new Set<string>()
  const hits: ScanHit[] = []
  const patternGroups = [REJECT_PATTERNS, SECRET_PATTERNS, TASK_FINGERPRINT_PATTERNS]
  for (const group of patternGroups) {
    for (const { rule, re } of group) {
      const globalRe = asGlobal(re)
      let m: RegExpExecArray | null
      while ((m = globalRe.exec(src)) !== null) {
        hits.push({
          rule,
          severity: 'reject',
          path,
          line: lineOf(src, m.index),
          snippet: snippet(src, m.index),
        })
        if (m.index === globalRe.lastIndex) globalRe.lastIndex++ // zero-width guard
      }
    }
  }

  // Import allowlist enforcement.
  for (const { specifier, line } of extractImports(src)) {
    if (specifier.startsWith('node:')) {
      if (!node.has(specifier)) {
        hits.push({
          rule: 'import-node-disallowed',
          severity: 'reject',
          path,
          line,
          snippet: specifier,
        })
      }
      continue
    }
    if (specifier.startsWith('@deepseek-ai/')) {
      const pkg = specifier.split('/').slice(0, 2).join('/')
      if (!dsh.has(pkg) && !extra.has(specifier)) {
        hits.push({
          rule: 'import-dsh-unpinned',
          severity: 'reject',
          path,
          line,
          snippet: specifier,
        })
      }
      continue
    }
    if (
      specifier.startsWith('@dsh-rsi/') ||
      specifier.startsWith('.') ||
      specifier.startsWith('/')
    ) {
      // candidate-relative or self import — allowed.
      continue
    }
    // Any other bare/external specifier.
    if (!extra.has(specifier)) {
      hits.push({ rule: 'import-external', severity: 'reject', path, line, snippet: specifier })
    }
  }
  return hits
}

/**
 * Scan a list of files (path + pre-read content). Aggregates hits and computes
 * `passed` (no reject hits).
 */
export function scanFiles(
  files: { path: string; content: string }[],
  opts: ScanOptions = {},
): ScanResult {
  const hits: ScanHit[] = []
  for (const f of files) hits.push(...scanSource(f.path, f.content, opts))
  return { hits, passed: !hits.some((h) => h.severity === 'reject') }
}

/** Convenience: scan files read from disk. */
export async function scanPaths(
  paths: { path: string; absPath: string }[],
  opts: ScanOptions = {},
): Promise<ScanResult> {
  const files: { path: string; content: string }[] = []
  for (const p of paths) files.push({ path: p.path, content: await readFile(p.absPath, 'utf8') })
  return scanFiles(files, opts)
}
