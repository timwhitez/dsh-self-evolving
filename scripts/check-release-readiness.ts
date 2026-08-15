#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
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

export const REQUIRED_RELEASE_FILES = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'CHANGELOG.md',
  'LICENSE',
  'docs/quickstart.md',
  'docs/configuration.md',
  'docs/troubleshooting.md',
  'docs/architecture-overview.md',
  'docs/evidence-guide.md',
  'docs/operations.md',
] as const

function validateReleaseFiles(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('release readiness: source identity has no release file inventory')
  }
  const files = value.map((entry) => {
    if (
      typeof entry !== 'string' ||
      entry.length === 0 ||
      entry.startsWith('/') ||
      entry.includes('\0') ||
      entry.split('/').some((part) => part === '' || part === '.' || part === '..')
    ) {
      throw new Error('release readiness: invalid release file path')
    }
    return entry
  })
  if (new Set(files).size !== files.length) {
    throw new Error('release readiness: duplicate release file path')
  }
  return files.sort()
}

export async function resolveReleaseFiles(repoRoot: string): Promise<string[]> {
  if ((await stat(join(repoRoot, '.git')).catch(() => null)) !== null) {
    return validateReleaseFiles(
      execFileSync('/usr/bin/git', ['ls-files', '-z'], {
        cwd: repoRoot,
        encoding: 'utf8',
      })
        .split('\0')
        .filter(Boolean),
    )
  }
  const raw = await readFile(join(repoRoot, '.dsh-rsi-source-identity.json'), 'utf8').catch(
    () => null,
  )
  if (raw === null) throw new Error('release readiness: no Git metadata or source identity')
  const identity = JSON.parse(raw) as { releaseFiles?: unknown }
  return validateReleaseFiles(identity.releaseFiles)
}

export async function checkReleaseReadiness(repoRoot: string): Promise<{
  status: 'PASS'
  trackedUtf8Files: number
  checkedRelativeLinks: number
}> {
  const tracked = await resolveReleaseFiles(repoRoot)
  let checkedLinks = 0
  for (const relative of tracked) {
    if (!textExtensions.has(extname(relative))) continue
    const bytes = await readFile(join(repoRoot, relative))
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
      const path = resolve(dirname(join(repoRoot, relative)), decoded)
      if ((await stat(path).catch(() => null)) === null) {
        throw new Error(`release readiness: broken link ${relative} -> ${target}`)
      }
      checkedLinks += 1
    }
  }

  for (const required of REQUIRED_RELEASE_FILES) {
    if ((await stat(join(repoRoot, required)).catch(() => null)) === null) {
      throw new Error(`release readiness: required file missing ${required}`)
    }
  }

  return {
    status: 'PASS',
    trackedUtf8Files: tracked.length,
    checkedRelativeLinks: checkedLinks,
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(await checkReleaseReadiness(root)) + '\n')
}
