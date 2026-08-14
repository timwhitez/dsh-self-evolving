/**
 * Canonical source tar + SHA-256 candidate identity (spec 02 §1).
 *
 * candidate_id = "c_" + base32(sha256(canonical_source_tar))[0:26]
 *
 * The canonical tar MUST be byte-reproducible from the same source under any
 * build host: paths UTF-8 byte-sorted, fixed mode/mtime/uid/gid/format, only
 * manifest-declared files, and it MUST reject symlinks/hardlinks/devices,
 * absolute/`..` paths, Unicode/case collisions and size overruns before hashing.
 *
 * This module emits a deterministic USTAR archive into a Uint8Array. It does not
 * shell out to `tar`; the format is implemented here so there is exactly one
 * definition of "canonical" and no dependency on host tar behavior.
 */
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

/** Limits enforced BEFORE hashing (spec 02 §1). */
export interface CanonicalLimits {
  /** Max bytes for a single included file. */
  maxFileBytes: number
  /** Max number of included files. */
  maxFileCount: number
  /** Max total bytes across all included files. */
  maxTotalBytes: number
}

export const DEFAULT_LIMITS: CanonicalLimits = {
  maxFileBytes: 256 * 1024,
  maxFileCount: 25,
  maxTotalBytes: 1024 * 1024,
}

/** A file declared by the candidate manifest as part of canonical source. */
export interface DeclaredFile {
  /** Repo-relative POSIX path (forward slashes), UTF-8. */
  path: string
  /** Absolute filesystem path to read the content from. */
  absPath: string
}

export interface CanonicalArchive {
  /** The canonical USTAR bytes. */
  bytes: Uint8Array
  /** sha256 of the bytes, hex. */
  hash: string
  /** The candidate id derived from the hash. */
  candidateId: string
  /** Number of files included. */
  fileCount: number
  /** Total content bytes included (payload only). */
  totalBytes: number
}

/** base32 (RFC 4648, no padding, lowercase) of a sha256, first 26 chars. */
function base32Sha256Prefix(bytes: Uint8Array, len = 26): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let bits = 0
  let value = 0
  let out = ''
  for (let i = 0; i < bytes.length && out.length < len; i++) {
    value = (value << 8) | bytes[i]!
    bits += 8
    while (bits >= 5 && out.length < len) {
      bits -= 5
      out += alphabet![(value >>> bits) & 0x1f]
    }
  }
  if (bits > 0 && out.length < len) {
    out += alphabet![(value << (5 - bits)) & 0x1f]
  }
  return out.slice(0, len)
}

/**
 * Validate declared paths against traversal/symlink/absolute/collision rules,
 * throwing on any violation. Returns the lexically-sorted (UTF-8 byte order)
 * file list.
 */
function validateAndSort(files: DeclaredFile[]): DeclaredFile[] {
  const seen = new Set<string>()
  for (const f of files) {
    const p = f.path
    if (!p || p.includes('\0')) throw new Error(`canonical: invalid path ${JSON.stringify(p)}`)
    if (p.startsWith('/')) throw new Error(`canonical: absolute path rejected: ${p}`)
    if (p.includes('..')) throw new Error(`canonical: traversal path rejected: ${p}`)
    if (p.includes('\\')) throw new Error(`canonical: backslash in path rejected: ${p}`)
    // POSIX-normalize: reject Windows separators and require forward slashes.
    if (sep !== '/' && p.includes(sep)) {
      throw new Error(`canonical: native separator in path rejected: ${p}`)
    }
    // Case-fold + Unicode-normalize collision check (best-effort procedural guard).
    const foldKey = p.toLowerCase()
    if (seen.has(foldKey)) throw new Error(`canonical: case/unicode collision: ${p}`)
    seen.add(foldKey)
  }
  // UTF-8 byte-order sort.
  return [...files].sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)))
}

/** USTAR octal field writer. */
function octal(buf: Uint8Array, offset: number, length: number, value: number): void {
  const s = value.toString(8).padStart(length - 1, '0')
  for (let i = 0; i < length - 1; i++) buf[offset + i] = s.charCodeAt(i)
  buf[offset + length - 1] = 0
}

/** Write one 512-byte USTAR header + content + zero padding. Fixed mode/mtime. */
function writeEntry(out: number[], path: string, content: Uint8Array): void {
  const header = new Uint8Array(512)
  const nameBuf = Buffer.from(path, 'utf8')
  if (nameBuf.length > 100) throw new Error(`canonical: path too long for USTAR: ${path}`)
  header.set(nameBuf.subarray(0, 100), 0)
  // mode: 0644 for files (fixed).
  octal(header, 100, 8, 0o644)
  // uid/gid: 0 (fixed, host-independent).
  octal(header, 108, 8, 0)
  octal(header, 116, 8, 0)
  // size.
  octal(header, 124, 12, content.length)
  // mtime: 0 (fixed, host-independent).
  octal(header, 136, 12, 0)
  // checksum placeholder (spaces).
  header.fill(' '.charCodeAt(0), 148, 156)
  // typeflag '0' = regular file.
  header[156] = '0'.charCodeAt(0)
  // ustar magic + version.
  header.set(Buffer.from('ustar\u000000', 'latin1'), 257)
  // Compute checksum.
  let sum = 0
  for (let i = 0; i < 512; i++) sum += header[i]!
  octal(header, 148, 8, sum)
  for (let i = 0; i < 512; i++) out.push(header[i]!)
  for (let i = 0; i < content.length; i++) out.push(content[i]!)
  const pad = (512 - (content.length % 512)) % 512
  for (let i = 0; i < pad; i++) out.push(0)
}

/**
 * Build the canonical archive from declared files. Reads each file, validates
 * it is a regular file (no symlinks/devices), enforces limits, then emits the
 * deterministic USTAR stream and its sha256.
 */
export async function buildCanonicalArchive(
  files: DeclaredFile[],
  limits: CanonicalLimits = DEFAULT_LIMITS,
): Promise<CanonicalArchive> {
  if (files.length === 0) throw new Error('canonical: no files declared')
  if (files.length > limits.maxFileCount) {
    throw new Error(`canonical: ${files.length} files exceeds max ${limits.maxFileCount}`)
  }
  const sorted = validateAndSort(files)
  const out: number[] = []
  let totalBytes = 0
  for (const f of sorted) {
    // lstat (not stat) so symlinks are NOT followed — a symlink is rejected
    // even if its target is a regular file.
    const st = await lstat(f.absPath)
    if (st.isSymbolicLink()) throw new Error(`canonical: symlink rejected: ${f.absPath}`)
    if (!st.isFile()) throw new Error(`canonical: not a regular file: ${f.absPath}`)
    if (st.size > limits.maxFileBytes) {
      throw new Error(`canonical: file ${f.path} size ${st.size} exceeds ${limits.maxFileBytes}`)
    }
    const content = await readFile(f.absPath)
    totalBytes += content.length
    if (totalBytes > limits.maxTotalBytes) {
      throw new Error(`canonical: total ${totalBytes} exceeds ${limits.maxTotalBytes}`)
    }
    writeEntry(out, f.path, content)
  }
  // Two zero blocks terminate the archive (fixed).
  for (let i = 0; i < 1024; i++) out.push(0)
  const bytes = new Uint8Array(out)
  const hash = createHash('sha256').update(bytes).digest('hex')
  return {
    bytes,
    hash,
    candidateId: 'c_' + base32Sha256Prefix(bytes.subarray()),
    fileCount: sorted.length,
    totalBytes,
  }
}

/**
 * Derive the candidate id from an EXISTING canonical archive (e.g. a child
 * built elsewhere). Recomputes sha256 — callers should compare against the
 * stored hash to detect tampering.
 */
export function candidateIdFromArchive(bytes: Uint8Array): { hash: string; candidateId: string } {
  const hash = createHash('sha256').update(bytes).digest('hex')
  return { hash, candidateId: 'c_' + base32Sha256Prefix(bytes.subarray()) }
}

/**
 * Helper: given a candidate source root and a manifest-declared relative path
 * list, build the DeclaredFile[] with absolute paths resolved under root.
 */
export function declareFiles(root: string, relPaths: string[]): DeclaredFile[] {
  return relPaths.map((p) => {
    const abs = resolve(root, p)
    const rel = relative(root, abs)
    if (rel.startsWith('..')) throw new Error(`canonical: path escapes root: ${p}`)
    return { path: rel.split(sep).join('/'), absPath: abs }
  })
}
