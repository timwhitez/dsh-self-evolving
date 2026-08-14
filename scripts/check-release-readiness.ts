#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tracked = execFileSync('/usr/bin/git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean)
const decoder = new TextDecoder('utf-8', { fatal: true })
const textExtensions = new Set([
  '',
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.toml',
  '.ts',
  '.txt',
  '.yaml',
  '.yml',
])

let checkedLinks = 0
for (const relative of tracked) {
  if (!textExtensions.has(extname(relative))) continue
  const bytes = await readFile(join(root, relative))
  if (bytes.includes(0)) continue
  const text = decoder.decode(bytes)
  if (text.includes('\uFFFD')) throw new Error(`release readiness: U+FFFD in ${relative}`)
  if (!relative.endsWith('.md')) continue
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1]?.split('#')[0]?.trim()
    if (
      target === undefined ||
      target.length === 0 ||
      target.startsWith('http://') ||
      target.startsWith('https://') ||
      target.startsWith('mailto:')
    ) {
      continue
    }
    const decoded = decodeURIComponent(target.replace(/^<|>$/g, ''))
    const path = resolve(dirname(join(root, relative)), decoded)
    if ((await stat(path).catch(() => null)) === null) {
      throw new Error(`release readiness: broken link ${relative} -> ${target}`)
    }
    checkedLinks += 1
  }
}

for (const required of [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'CHANGELOG.md',
  'docs/quickstart.md',
  'docs/configuration.md',
  'docs/troubleshooting.md',
  'docs/architecture-overview.md',
  'docs/evidence-guide.md',
  'docs/operations.md',
]) {
  if ((await stat(join(root, required)).catch(() => null)) === null) {
    throw new Error(`release readiness: required file missing ${required}`)
  }
}

process.stdout.write(
  JSON.stringify({
    status: 'PASS',
    trackedUtf8Files: tracked.length,
    checkedRelativeLinks: checkedLinks,
  }) + '\n',
)
