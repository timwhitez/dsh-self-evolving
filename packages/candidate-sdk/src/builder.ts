/**
 * Diff boundary check (spec 02 §11 step 3).
 *
 * A candidate may only modify files within its own declared source tree relative
 * to its canonical parent. This module computes the file-set diff and rejects
 * any change outside the candidate's editable surface (TCB, runner rows, model
 * adapter, verifier, etc. are never editable by a candidate — AGENTS.md rule 3).
 */
import { lstat, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

export interface DiffEntry {
  path: string
  status: 'added' | 'removed' | 'modified'
}

export interface DiffBoundaryResult {
  entries: DiffEntry[]
  /** True iff every changed path is within the candidate's editable surface. */
  withinBoundary: boolean
  violations: string[]
}

/** sha256:hex of a file's content, or null if missing. */
async function hashFile(absPath: string): Promise<string | null> {
  try {
    const content = await readFile(absPath)
    return createHash('sha256').update(content).digest('hex')
  } catch {
    return null
  }
}

/**
 * Compute the file diff between parent and child manifests-of-files and verify
 * every change is within `editablePaths` (POSIX-relative, repo-rooted).
 *
 * @param parentFiles map of path -> absPath (canonical parent source).
 * @param childFiles map of path -> absPath (candidate source).
 * @param editablePaths set of POSIX paths the candidate is allowed to touch.
 */
export async function diffBoundary(
  parentFiles: Map<string, string>,
  childFiles: Map<string, string>,
  editablePaths: ReadonlySet<string>,
): Promise<DiffBoundaryResult> {
  const allPaths = new Set<string>([...parentFiles.keys(), ...childFiles.keys()])
  const entries: DiffEntry[] = []
  const violations: string[] = []
  for (const p of allPaths) {
    const parentHash = await hashFile(parentFiles.get(p) ?? '')
    const childHash = await hashFile(childFiles.get(p) ?? '')
    if (parentHash === childHash) continue // unchanged
    let status: DiffEntry['status']
    if (parentHash === null) status = 'added'
    else if (childHash === null) status = 'removed'
    else status = 'modified'
    entries.push({ path: p, status })
    // A candidate may only ADD or MODIFY files inside its editable surface;
    // removing a parent file is allowed only if that file was in the surface.
    if (!editablePaths.has(p)) {
      violations.push(`${status} outside editable surface: ${p}`)
    }
    if (status === 'removed' && !editablePaths.has(p)) {
      violations.push(`removed non-editable parent file: ${p}`)
    }
  }
  return { entries, withinBoundary: violations.length === 0, violations }
}

/**
 * Verify a path is a regular file (not symlink/device/dir), used by containment.
 */
export async function assertRegularFile(absPath: string): Promise<void> {
  const st = await lstat(absPath)
  if (st.isSymbolicLink()) throw new Error(`containment: symlink rejected: ${absPath}`)
  if (!st.isFile()) throw new Error(`containment: not a regular file: ${absPath}`)
}
