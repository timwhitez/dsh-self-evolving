import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

export interface SourceArchiveIdentity {
  schemaVersion: 1
  commit: string
  tree: string
  files: Record<string, string>
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

async function codeFiles(root: string, current: string): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory() && ['.git', 'lib', 'node_modules'].includes(entry.name)) continue
    const path = join(current, entry.name)
    if (entry.isDirectory()) files.push(...(await codeFiles(root, path)))
    else if (entry.isFile()) files.push(relative(root, path))
    else if (entry.isSymbolicLink() && entry.name !== 'node_modules')
      files.push(relative(root, path))
  }
  return files
}

export async function readSourceArchiveIdentity(
  repoRoot: string,
): Promise<SourceArchiveIdentity | null> {
  const raw = await readFile(join(repoRoot, '.dsh-rsi-source-identity.json'), 'utf8').catch(
    () => null,
  )
  if (raw === null) return null
  const value = JSON.parse(raw) as Partial<SourceArchiveIdentity>
  if (
    value.schemaVersion !== 1 ||
    typeof value.commit !== 'string' ||
    !/^[0-9a-f]{40}$/.test(value.commit) ||
    typeof value.tree !== 'string' ||
    !/^[0-9a-f]{40}$/.test(value.tree) ||
    value.files === null ||
    typeof value.files !== 'object' ||
    Array.isArray(value.files)
  ) {
    throw new Error('source identity: invalid manifest')
  }
  return value as SourceArchiveIdentity
}

export async function verifySourceArchiveIdentity(
  repoRoot: string,
  identity: SourceArchiveIdentity,
): Promise<{ valid: boolean; detail: string }> {
  const expected = Object.entries(identity.files).sort(([left], [right]) =>
    left.localeCompare(right),
  )
  for (const [path, digest] of expected) {
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
      return { valid: false, detail: `invalid digest for ${path}` }
    }
    const bytes = await readFile(join(repoRoot, path)).catch(() => null)
    if (bytes === null || sha256(bytes) !== digest) {
      return { valid: false, detail: `source hash mismatch for ${path}` }
    }
  }
  const actual = (
    await Promise.all(
      ['packages', 'benchmark-adapters', 'scripts'].map((path) =>
        codeFiles(repoRoot, join(repoRoot, path)),
      ),
    )
  )
    .flat()
    .sort()
  const expectedCode = expected
    .map(([path]) => path)
    .filter((path) => /^(?:packages|benchmark-adapters|scripts)\//.test(path))
    .sort()
  if (JSON.stringify(actual) !== JSON.stringify(expectedCode)) {
    return { valid: false, detail: 'source file inventory differs from release manifest' }
  }
  return { valid: true, detail: `source archive commit ${identity.commit}` }
}
