import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

export interface SourceArchiveIdentity {
  schemaVersion: 1
  commit: string
  tree: string
  files: Record<string, string>
  releaseFiles?: string[]
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
  const raw = await readFile(
    join(repoRoot, '.dsh-self-evolving-source-identity.json'),
    'utf8',
  ).catch(() => null)
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
    Array.isArray(value.files) ||
    (value.releaseFiles !== undefined &&
      (!Array.isArray(value.releaseFiles) ||
        value.releaseFiles.some((entry) => typeof entry !== 'string')))
  ) {
    throw new Error('source identity: invalid manifest')
  }
  return value as SourceArchiveIdentity
}

export interface SourceIdentityVerification {
  valid: boolean
  /**
   * SELF_CONSISTENT: the extracted tree matches the embedded manifest —
   * nothing more. AUTHENTICATED: additionally bound to a caller-supplied
   * commit obtained through an independently trusted channel (e.g. an
   * operator-verified archive SHA256SUMS). Rewriting the archive and its
   * embedded manifest stays detectable only in the AUTHENTICATED case.
   */
  status: 'SELF_CONSISTENT' | 'AUTHENTICATED'
  detail: string
}

export interface SourceIdentityVerifyOptions {
  /**
   * Commit identity obtained OUTSIDE this tree (verified release channel).
   * When provided, the manifest's commit must equal it for any authenticity
   * claim; a mismatch is a hard failure, not a downgrade.
   */
  trustedCommit?: string
}

export async function verifySourceArchiveIdentity(
  repoRoot: string,
  identity: SourceArchiveIdentity,
  options: SourceIdentityVerifyOptions = {},
): Promise<SourceIdentityVerification> {
  const invalid = (detail: string): SourceIdentityVerification => ({
    valid: false,
    status: 'SELF_CONSISTENT',
    detail,
  })
  if (options.trustedCommit !== undefined) {
    if (!/^[0-9a-f]{40}$/.test(options.trustedCommit)) {
      throw new Error('source identity: trusted commit anchor is not a sha1 commit')
    }
    if (identity.commit !== options.trustedCommit) {
      return invalid(`source identity commit ${identity.commit} does not match the trusted anchor`)
    }
  }
  const expected = Object.entries(identity.files).sort(([left], [right]) =>
    left.localeCompare(right),
  )
  for (const [path, digest] of expected) {
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
      return invalid(`invalid digest for ${path}`)
    }
    const bytes = await readFile(join(repoRoot, path)).catch(() => null)
    if (bytes === null || sha256(bytes) !== digest) {
      return invalid(`source hash mismatch for ${path}`)
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
    return invalid('source file inventory differs from release manifest')
  }
  // The complete release inventory must be present: entries outside the
  // hashed code paths (docs, lockfiles, manifests) previously escaped every
  // check because releaseFiles was never consulted (issue #72).
  if (identity.releaseFiles !== undefined) {
    for (const entry of identity.releaseFiles) {
      const stat = await readFile(join(repoRoot, entry)).then(
        () => true,
        () => false,
      )
      if (!stat) return invalid(`release file is missing from the tree: ${entry}`)
    }
  }
  return options.trustedCommit === undefined
    ? {
        valid: true,
        status: 'SELF_CONSISTENT',
        detail: `self-consistent source archive (no external trust anchor provided); embedded commit ${identity.commit}`,
      }
    : {
        valid: true,
        status: 'AUTHENTICATED',
        detail: `authenticated source archive commit ${identity.commit} (matches trusted anchor)`,
      }
}
