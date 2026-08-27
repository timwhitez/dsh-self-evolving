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
   * INVALID: verification failed.
   * SELF_CONSISTENT: the extracted tree matches the embedded manifest —
   * nothing more; an attacker rewriting the archive rewrites the manifest.
   * COMMIT_ANCHORED: additionally, the manifest's commit equals a
   * caller-supplied commit from an independently trusted channel. This
   * catches whole-release substitution ONLY: an in-archive rewrite that
   * recomputes manifest digests while keeping the commit still passes and is
   * NOT authentication.
   * AUTHENTICATED: the archive's own BYTES hash to a caller-supplied trusted
   * digest (e.g. an operator-verified SHA256SUMS entry). The extracted tree
   * is bound to those bytes under the assumption that trusted tooling
   * performed the extraction; byte-level authentication of the archive is
   * what issue #72 requires for any authenticity claim.
   */
  status: 'INVALID' | 'SELF_CONSISTENT' | 'COMMIT_ANCHORED' | 'AUTHENTICATED'
  detail: string
}

export interface SourceIdentityVerifyOptions {
  /**
   * Commit identity obtained OUTSIDE this tree. Catches whole-release
   * substitution only; never sufficient for AUTHENTICATED.
   */
  trustedCommit?: string
  /**
   * Independently trusted sha256 of the release archive, together with the
   * archive's path. When both are provided the archive bytes are hashed and
   * must match; success upgrades the verdict to AUTHENTICATED. A digest
   * mismatch is a hard failure, never a downgrade.
   */
  trustedArchiveDigest?: string
  archivePath?: string
}

export async function verifySourceArchiveIdentity(
  repoRoot: string,
  identity: SourceArchiveIdentity,
  options: SourceIdentityVerifyOptions = {},
): Promise<SourceIdentityVerification> {
  const invalid = (detail: string): SourceIdentityVerification => ({
    valid: false,
    status: 'INVALID',
    detail,
  })
  const anchoredToCommit =
    options.trustedCommit !== undefined && identity.commit === options.trustedCommit
  if (options.trustedCommit !== undefined) {
    if (!/^[0-9a-f]{40}$/.test(options.trustedCommit)) {
      throw new Error('source identity: trusted commit anchor is not a sha1 commit')
    }
    if (identity.commit !== options.trustedCommit) {
      return invalid(`source identity commit ${identity.commit} does not match the trusted anchor`)
    }
  }
  let archiveAuthenticated = false
  if (options.trustedArchiveDigest !== undefined || options.archivePath !== undefined) {
    if (options.trustedArchiveDigest === undefined || options.archivePath === undefined) {
      throw new Error('source identity: archive anchoring requires both digest and path')
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(options.trustedArchiveDigest)) {
      throw new Error('source identity: trusted archive digest is not a sha256 value')
    }
    const bytes = await readFile(options.archivePath).catch(() => null)
    if (bytes === null || sha256(bytes) !== options.trustedArchiveDigest) {
      return invalid('archive bytes do not match the trusted archive digest')
    }
    archiveAuthenticated = true
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
  // The release inventory must be EXACT: every releaseFiles entry present
  // AND no extra file in the walked tree beyond the inventory plus the
  // embedded manifest itself. The walker prunes any directory NAMED
  // .git/lib/node_modules at any depth, so files planted under such names
  // are blind to this check (tracked separately); entries outside the hashed
  // code paths (docs, lockfiles) have no digests in the manifest schema, so
  // their CONTENT tampering also remains undetectable (issue #72).
  if (identity.releaseFiles !== undefined) {
    for (const entry of identity.releaseFiles) {
      const exists = await readFile(join(repoRoot, entry)).then(
        () => true,
        () => false,
      )
      if (!exists) return invalid(`release file is missing from the tree: ${entry}`)
    }
    const treeFiles = (await codeFiles(repoRoot, repoRoot)).sort()
    const declared = [
      ...new Set([...identity.releaseFiles, '.dsh-self-evolving-source-identity.json']),
    ].sort()
    if (JSON.stringify(treeFiles) !== JSON.stringify(declared)) {
      return invalid('extracted tree contains files outside the declared release inventory')
    }
  }
  const prunedNote =
    '; .git/lib/node_modules-named directories are pruned from the walk (inventory blind spot, issue #195)'
  if (archiveAuthenticated) {
    return {
      valid: true,
      status: 'AUTHENTICATED',
      detail: `authenticated source archive (bytes match the trusted digest); embedded commit ${identity.commit}`,
    }
  }
  if (anchoredToCommit) {
    return {
      valid: true,
      status: 'COMMIT_ANCHORED',
      detail: `commit-anchored source archive ${identity.commit} (whole-release substitution only; not byte-authenticated)${prunedNote}`,
    }
  }
  return {
    valid: true,
    status: 'SELF_CONSISTENT',
    detail: `self-consistent source archive (no external trust anchor provided); embedded commit ${identity.commit}${prunedNote}`,
  }
}
