/**
 * Evaluation capsule packer (spec 02 §12).
 *
 * Produces a self-contained immutable capsule directory:
 *   capsule/
 *   ├── runtime/        # pinned DSH production closure or verified install manifest
 *   ├── candidate/      # compiled bundle (source + lib)
 *   ├── runner/         # stable ACP application overlay (cordis.patch.yml)
 *   ├── provenance.json # copy of provenance.lock relevant slice
 *   ├── sbom.spdx.json  # dependency SBOM
 *   ├── capsule.json    # capsule manifest
 *   └── SHA256SUMS      # sha256 of every file above
 *
 * The Harbor adapter verifies SHA256SUMS before unpack and again after. The
 * runtime user has read-only access to runtime/ and candidate/.
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import type { BuildReceipt } from './builder-sandbox.js'

export interface RuntimeClosureInput {
  /** Trees containing pinned DSH/vendor package roots. */
  catalogRoots: string[]
  /** Runtime entry package plus deployment-specific adapters/backends. */
  seedPackages: string[]
  /** Package whose built bin boots the ACP server. */
  entryPackage: string
  /** POSIX-relative executable module within entryPackage. */
  entryBin: string
}

export interface CapsuleInput {
  /** Where to write the capsule. */
  outDir: string
  /** Build receipt from the deterministic builder. */
  receipt: BuildReceipt
  /**
   * Canonical identity consumed by the controller/evaluator when it differs
   * from the Candidate SDK build identity. The build identity remains bound
   * in `candidate.buildCandidateId`.
   */
  canonicalCandidateId?: string
  /** Runner overlay content (the stable runner's final row restatement). */
  runnerOverlay: string
  /** Additional immutable runner-local modules referenced by the overlay. */
  runnerFiles?: Record<string, string>
  /** Provenance slice (JSON string) to embed. */
  provenanceJson: string
  /** SBOM content (JSON string). */
  sbomJson: string
  /** Pinned package closure for the stable ACP runtime. */
  runtimeClosure: RuntimeClosureInput
}

export interface CapsuleOutput {
  capsuleDir: string
  capsuleManifestPath: string
  sha256sumsPath: string
  capsuleHash: string
}

/** Recursively hash every regular file under root, writing `relpath  hash`. */
async function writeSha256sums(
  root: string,
  sumsPath: string,
): Promise<{ entries: Map<string, string>; hash: string }> {
  const entries: string[] = []
  const map = new Map<string, string>()
  async function walk(dir: string): Promise<void> {
    const names = await readdir(dir, { withFileTypes: true })
    for (const e of names) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) await walk(abs)
      else if (e.isFile()) {
        const content = await readFile(abs)
        const rel = relative(root, abs)
        // Avoid the impossible self-reference/cycle:
        // SHA256SUMS cannot hash itself, and capsule.json contains the hash of
        // SHA256SUMS. The capsule identity below hashes both files together.
        if (rel === 'SHA256SUMS' || rel === 'capsule.json') continue
        const h = createHash('sha256').update(content).digest('hex')
        entries.push(`${h}  ${rel}`)
        map.set(rel, h)
      } else if (e.isSymbolicLink()) {
        // Commit to symlink identity, not just file contents: changing a link
        // target must invalidate the manifest even though no regular file's
        // bytes changed (issue #42).
        const rel = relative(root, abs)
        if (rel === 'SHA256SUMS' || rel === 'capsule.json') {
          throw new Error(`capsule sums: control path must not be a symlink: ${rel}`)
        }
        const target = await readlink(abs)
        const h = createHash('sha256').update(target, 'utf8').digest('hex')
        entries.push(`${h}  symlink:${rel}`)
        map.set(`symlink:${rel}`, h)
      } else {
        throw new Error(`capsule sums: unsupported entry type at ${relative(root, abs)}`)
      }
    }
  }
  await walk(root)
  entries.sort()
  const body = entries.join('\n') + '\n'
  await writeFile(sumsPath, body)
  const hash = createHash('sha256').update(body).digest('hex')
  return { entries: map, hash }
}

/** Materialize the immutable source + compiled bytes frozen in BuildReceipt. */
async function copyCandidate(receipt: BuildReceipt, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true })
  for (const file of receipt.runtimeSourceFiles ?? receipt.sourceFiles) {
    const destination = join(dest, ...file.path.split('/'))
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, file.bytes)
  }
  for (const file of receipt.bundleFiles) {
    const destination = join(dest, 'lib', ...file.path.split('/'))
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, file.bytes)
  }
}

async function copyDir(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true })
  const names = (await readdir(src, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )
  for (const e of names) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'coverage') continue
    const from = join(src, e.name)
    const to = join(dest, e.name)
    if (e.isDirectory()) await copyDir(from, to)
    else if (e.isFile()) await copyFile(from, to)
    else if (e.isSymbolicLink()) {
      const target = await readlink(from)
      if (target.startsWith('/') || target.split('/').includes('..')) {
        throw new Error(`runtime closure: unsafe package symlink ${from} -> ${target}`)
      }
      await symlink(target, to)
    }
  }
}

interface PackageJson {
  name: string
  version?: string
  files?: string[]
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

async function copyPath(from: string, to: string): Promise<boolean> {
  const info = await lstat(from).catch(() => null)
  // Published packages occasionally retain a stale non-runtime license/readme
  // entry in `files`. The executable entry is validated separately below.
  if (info === null) return false
  if (info.isDirectory()) await copyDir(from, to)
  else if (info.isFile()) {
    await mkdir(dirname(to), { recursive: true })
    await copyFile(from, to)
  } else if (info.isSymbolicLink()) {
    const target = await readlink(from)
    if (target.startsWith('/') || target.split('/').includes('..')) {
      throw new Error(`runtime closure: unsafe package symlink ${from} -> ${target}`)
    }
    await mkdir(dirname(to), { recursive: true })
    await symlink(target, to)
  } else {
    throw new Error(`runtime closure: unsupported package entry ${from}`)
  }
  return true
}

/** Copy exactly the package's published surface when `files` is declared. */
async function copyRuntimePackage(src: string, dest: string, pkg: PackageJson): Promise<void> {
  if (pkg.files === undefined || pkg.files.length === 0) {
    await copyDir(src, dest)
    return
  }
  await mkdir(dest, { recursive: true })
  await copyFile(join(src, 'package.json'), join(dest, 'package.json'))
  const copied = new Set<string>()
  for (const declaration of [...pkg.files].sort()) {
    const segments = declaration.split('/')
    const wildcard = segments.findIndex((segment) => /[*?[\]{}]/.test(segment))
    const selected = (wildcard === -1 ? segments : segments.slice(0, wildcard)).join('/')
    if (selected.length === 0 || copied.has(selected)) continue
    copied.add(selected)
    await copyPath(join(src, ...selected.split('/')), join(dest, ...selected.split('/')))
  }
}

interface ClosurePackage {
  name: string
  version: string | null
  contentHash: string
}

function generateSpdx(
  packages: ClosurePackage[],
  receipt: BuildReceipt,
  suppliedSbomJson: string,
): string {
  const supplied = JSON.parse(suppliedSbomJson) as unknown
  if (supplied === null || typeof supplied !== 'object' || Array.isArray(supplied)) {
    throw new Error('capsule SBOM input must be a JSON object')
  }
  const sourceSbomHash = createHash('sha256').update(suppliedSbomJson).digest('hex')
  const described = packages.map((pkg) => ({
    SPDXID: `SPDXRef-Package-${createHash('sha256').update(pkg.name).digest('hex').slice(0, 20)}`,
    name: pkg.name,
    versionInfo: pkg.version ?? 'NOASSERTION',
    downloadLocation: 'NOASSERTION',
    filesAnalyzed: false,
    checksums: [{ algorithm: 'SHA256', checksumValue: pkg.contentHash }],
    licenseConcluded: 'NOASSERTION',
    licenseDeclared: 'NOASSERTION',
    copyrightText: 'NOASSERTION',
  }))
  const namespaceHash = createHash('sha256')
    .update(JSON.stringify(described))
    .update(receipt.candidateId)
    .digest('hex')
  return (
    JSON.stringify(
      {
        spdxVersion: 'SPDX-2.3',
        dataLicense: 'CC0-1.0',
        SPDXID: 'SPDXRef-DOCUMENT',
        name: `dsh-self-evolving-capsule-${receipt.candidateId}`,
        documentNamespace: `https://dsh-self-evolving.invalid/spdx/${namespaceHash}`,
        documentComment: `source-sbom-sha256:${sourceSbomHash}`,
        creationInfo: {
          created: '1970-01-01T00:00:00Z',
          creators: ['Tool: @dsh-self-evolving/candidate-sdk'],
        },
        documentDescribes: described.map((pkg) => pkg.SPDXID),
        packages: described,
      },
      null,
      2,
    ) + '\n'
  )
}

async function readPackageJson(root: string): Promise<PackageJson> {
  const parsed = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as PackageJson
  if (typeof parsed.name !== 'string' || parsed.name.length === 0) {
    throw new Error(`runtime closure: package at ${root} has no name`)
  }
  return parsed
}

/** Build a name→root map without following package-internal node_modules. */
async function scanPackageCatalog(roots: string[]): Promise<Map<string, string>> {
  const catalog = new Map<string, string>()
  async function walk(dir: string): Promise<void> {
    const packagePath = join(dir, 'package.json')
    const packageStat = await stat(packagePath).catch(() => null)
    if (packageStat?.isFile()) {
      const pkg = await readPackageJson(dir)
      const existing = catalog.get(pkg.name)
      if (existing !== undefined && resolve(existing) !== resolve(dir)) {
        throw new Error(`runtime closure: duplicate catalog package ${pkg.name}`)
      }
      catalog.set(pkg.name, dir)
      return
    }
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.'))
        continue
      await walk(join(dir, entry.name))
    }
  }
  for (const root of [...roots].sort()) await walk(root)
  return catalog
}

async function locatePackageRoot(entry: string, expectedName: string): Promise<string> {
  let cursor = dirname(entry)
  for (;;) {
    const candidate = join(cursor, 'package.json')
    const raw = await readFile(candidate, 'utf8').catch(() => null)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as { name?: string }
      if (parsed.name === expectedName) return cursor
    }
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  throw new Error(`runtime closure: cannot locate package root for ${expectedName} from ${entry}`)
}

async function resolveDependencyRoot(fromRoot: string, name: string): Promise<string> {
  const requireFromPackage = createRequire(join(fromRoot, 'package.json'))
  try {
    return dirname(requireFromPackage.resolve(`${name}/package.json`))
  } catch {
    const entry = requireFromPackage.resolve(name)
    return locatePackageRoot(entry, name)
  }
}

async function hashDirectory(root: string): Promise<string> {
  const rows: string[] = []
  async function walk(dir: string): Promise<void> {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const abs = join(dir, entry.name)
      const rel = relative(root, abs)
      if (entry.isDirectory()) await walk(abs)
      else if (entry.isFile()) {
        rows.push(
          `${rel}:${createHash('sha256')
            .update(await readFile(abs))
            .digest('hex')}`,
        )
      } else if (entry.isSymbolicLink()) {
        rows.push(`${rel}:symlink:${await readlink(abs)}`)
      }
    }
  }
  await walk(root)
  return createHash('sha256').update(rows.join('\n')).digest('hex')
}

async function materializeRuntimeClosure(input: {
  runtimeDir: string
  closure: RuntimeClosureInput
  receipt: BuildReceipt
  runnerOverlay: string
  runnerFiles: Record<string, string>
}): Promise<{ packages: ClosurePackage[]; closureHash: string }> {
  const { runtimeDir, closure, receipt, runnerOverlay, runnerFiles } = input
  const catalog = await scanPackageCatalog(closure.catalogRoots)
  const pinnedCatalogNames = new Set(catalog.keys())
  const wanted = new Map<string, string>()
  const queue = [...new Set([...closure.seedPackages, closure.entryPackage])].sort()

  while (queue.length > 0) {
    const name = queue.shift()!
    if (wanted.has(name)) continue
    const root = catalog.get(name)
    if (root === undefined) {
      throw new Error(`runtime closure: seed package ${name} is absent from the pinned catalog`)
    }
    const pkg = await readPackageJson(root)
    wanted.set(name, root)
    const required = {
      ...pkg.peerDependencies,
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
    }
    for (const dependency of Object.keys(required).sort()) {
      if (wanted.has(dependency) || queue.includes(dependency)) continue
      if (!catalog.has(dependency)) {
        try {
          const resolved = await resolveDependencyRoot(root, dependency)
          catalog.set(dependency, resolved)
        } catch (error) {
          if (
            pkg.optionalDependencies?.[dependency] !== undefined ||
            pkg.peerDependenciesMeta?.[dependency]?.optional === true
          ) {
            continue
          }
          throw new Error(`runtime closure: cannot resolve ${dependency} required by ${name}`, {
            cause: error,
          })
        }
      }
      queue.push(dependency)
      queue.sort()
    }
  }

  const nodeModules = join(runtimeDir, 'node_modules')
  await mkdir(nodeModules, { recursive: true })
  const packages: ClosurePackage[] = []
  for (const [name, root] of [...wanted.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const destination = join(nodeModules, ...name.split('/'))
    const sourcePackage = await readPackageJson(root)
    if (pinnedCatalogNames.has(name)) await copyRuntimePackage(root, destination, sourcePackage)
    else await copyDir(root, destination)
    if (
      pinnedCatalogNames.has(name) &&
      sourcePackage.files !== undefined &&
      name.startsWith('@deepseek-ai/dsh-')
    ) {
      for (const forbidden of ['src', 'tests']) {
        if ((await stat(join(destination, forbidden)).catch(() => null)) !== null) {
          throw new Error(
            `runtime closure: published DSH surface unexpectedly contains ${name}/${forbidden}`,
          )
        }
      }
    }
    const pkg = await readPackageJson(destination)
    packages.push({
      name,
      version: pkg.version ?? null,
      contentHash: await hashDirectory(destination),
    })
  }

  // Candidate bytes are duplicated into the runtime's ordinary resolution
  // path. Their canonical copy remains capsule/candidate for audit/release.
  const runtimePackageName = receipt.runtimePackageName ?? '@dsh-self-evolving/candidate-baseline'
  const runtimeCandidate = join(nodeModules, ...runtimePackageName.split('/'))
  await copyCandidate(receipt, runtimeCandidate)
  packages.push({
    name: runtimePackageName,
    version: '0.0.0',
    contentHash: await hashDirectory(runtimeCandidate),
  })
  const bundledNode = join(runtimeDir, 'node')
  await copyFile(process.execPath, bundledNode)
  await chmod(bundledNode, 0o755)
  packages.push({
    name: 'node-runtime',
    version: process.version,
    contentHash: createHash('sha256')
      .update(await readFile(bundledNode))
      .digest('hex'),
  })
  packages.sort((a, b) => a.name.localeCompare(b.name))

  const closureRecord = {
    schemaVersion: 1,
    entryPackage: closure.entryPackage,
    entryBin: closure.entryBin,
    packages,
  }
  const closureBytes = JSON.stringify(closureRecord, null, 2) + '\n'
  const closureHash = createHash('sha256').update(closureBytes).digest('hex')
  await writeFile(join(runtimeDir, 'package-closure.json'), closureBytes)
  await writeFile(join(runtimeDir, 'package.json'), '{"private":true,"type":"module"}\n')
  await writeFile(join(runtimeDir, 'cordis.yml'), runnerOverlay)
  await writeRunnerFiles(runtimeDir, runnerFiles)

  const entry = join(
    runtimeDir,
    'node_modules',
    ...closure.entryPackage.split('/'),
    closure.entryBin,
  )
  const entryStat = await stat(entry).catch(() => null)
  if (!entryStat?.isFile()) {
    throw new Error(
      `runtime closure: entry bin is absent: ${closure.entryPackage}/${closure.entryBin}`,
    )
  }
  const binDir = join(runtimeDir, 'bin')
  await mkdir(binDir, { recursive: true })
  await writeFile(
    join(runtimeDir, 'launcher.mjs'),
    [
      "import { dirname, join } from 'node:path'",
      "import { fileURLToPath, pathToFileURL } from 'node:url'",
      'const runtime = dirname(fileURLToPath(import.meta.url))',
      `const entry = join(runtime, ${JSON.stringify(join('node_modules', ...closure.entryPackage.split('/'), closure.entryBin))})`,
      'process.argv = [process.execPath, entry, "--config", join(runtime, "cordis.yml")]',
      'await import(pathToFileURL(entry).href)',
      '',
    ].join('\n'),
  )
  const makeWrapper = (parent: boolean): string =>
    [
      '#!/bin/sh',
      'set -eu',
      'script_dir=${0%/*}',
      '[ "$script_dir" != "$0" ] || script_dir=.',
      'script_dir="$(CDPATH= cd -- "$script_dir" && pwd)"',
      parent ? 'runtime="$(CDPATH= cd -- "$script_dir/.." && pwd)"' : 'runtime="$script_dir"',
      'exec "$runtime/node" "$runtime/launcher.mjs" "$@"',
      '',
    ].join('\n')
  const wrappers = [
    {
      path: join(binDir, 'dsh-self-evolving-acp'),
      parent: true,
    },
    {
      path: join(runtimeDir, 'dsh-self-evolving-acp'),
      parent: false,
    },
  ]
  for (const wrapper of wrappers) {
    await writeFile(wrapper.path, makeWrapper(wrapper.parent), { mode: 0o755 })
    await chmod(wrapper.path, 0o755)
  }
  return { packages, closureHash }
}

async function writeRunnerFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const segments = path.split('/')
    if (
      path.length === 0 ||
      path.startsWith('/') ||
      path.includes('\\') ||
      segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      throw new Error(`runner files: unsafe relative path ${JSON.stringify(path)}`)
    }
    const destination = join(root, ...segments)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, content)
  }
}

/**
 * Pack a complete evaluation capsule. Returns paths and the SHA256SUMS hash.
 *
 * The capsule is assembled inside a unique private staging directory and
 * atomically renamed to `outDir` only after full validation: a previously
 * crashed or foreign build at the same path can never leak stale files into
 * the new capsule (issue #41), and a caller reusing an existing output
 * directory fails closed instead of packaging a mixture of generations.
 */
export async function packCapsule(input: CapsuleInput): Promise<CapsuleOutput> {
  const {
    outDir,
    receipt,
    canonicalCandidateId,
    runnerOverlay,
    provenanceJson,
    sbomJson,
    runtimeClosure,
    runnerFiles = {},
  } = input
  if (
    (await stat(outDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })) !== null
  ) {
    throw new Error(`capsule output directory already exists: ${outDir}`)
  }
  const buildDir = join(
    dirname(resolve(outDir)),
    `.${resolve(outDir).split('/').pop()}.staging-${process.pid}-${randomBytes(8).toString('hex')}`,
  )
  try {
    await mkdir(buildDir, { recursive: true })

    // runtime/ — actual pinned bytes. No task-time install or source-checkout
    // resolution is permitted by the Gate 1 contract.
    const runtimeDir = join(buildDir, 'runtime')
    await mkdir(runtimeDir, { recursive: true })
    const runtime = await materializeRuntimeClosure({
      runtimeDir,
      closure: runtimeClosure,
      receipt,
      runnerOverlay,
      runnerFiles,
    })

    // candidate/
    await copyCandidate(receipt, join(buildDir, 'candidate'))

    // runner/
    const runnerDir = join(buildDir, 'runner')
    await mkdir(runnerDir, { recursive: true })
    await writeFile(join(runnerDir, 'cordis.patch.yml'), runnerOverlay)
    await writeRunnerFiles(runnerDir, runnerFiles)

    // provenance.json + generated, content-bound SPDX package inventory. The
    // caller's scanner SBOM is treated as an input receipt, never copied as an
    // unverified replacement for the closure inventory.
    await writeFile(join(buildDir, 'provenance.json'), provenanceJson)
    const generatedSbom = generateSpdx(runtime.packages, receipt, sbomJson)
    await writeFile(join(buildDir, 'sbom.spdx.json'), generatedSbom)

    // SHA256SUMS (written last, covers everything except itself).
    const sumsPath = join(buildDir, 'SHA256SUMS')
    const { hash } = await writeSha256sums(buildDir, sumsPath)

    // capsule.json is written after SHA256SUMS because it records the sums-file
    // hash. The two are bound by capsuleHash = H(manifest || sums), avoiding a
    // circular self-hash while still protecting both control files.
    const candidateId = canonicalCandidateId ?? receipt.candidateId
    if (candidateId.length === 0) throw new Error('capsule: canonical candidate identity is empty')
    const capsuleManifest = {
      schemaVersion: 1,
      candidateId,
      runtime: {
        kind: 'pinned-closure',
        ref: 'runtime/package-closure.json',
        hash: runtime.closureHash,
      },
      candidate: {
        bundleHash: receipt.bundleHash,
        ...(canonicalCandidateId === undefined ? {} : { buildCandidateId: receipt.candidateId }),
      },
      runner: {
        overlay: 'runner/cordis.patch.yml',
        hash: await hashDirectory(runnerDir),
      },
      provenance: {
        ref: 'provenance.json',
        hash: createHash('sha256').update(provenanceJson).digest('hex'),
      },
      sbom: {
        ref: 'sbom.spdx.json',
        hash: createHash('sha256').update(generatedSbom).digest('hex'),
      },
      sha256sums: { ref: 'SHA256SUMS', hash },
    }
    const manifestPath = join(buildDir, 'capsule.json')
    const manifestBytes = JSON.stringify(capsuleManifest, null, 2) + '\n'
    await writeFile(manifestPath, manifestBytes)
    const sumsBytes = await readFile(sumsPath)
    const capsuleHash = createHash('sha256').update(manifestBytes).update(sumsBytes).digest('hex')

    // Atomic publication: the capsule appears at its final path fully built or
    // not at all. A concurrent creator of the same path fails closed.
    try {
      await rename(buildDir, outDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
      throw new Error(`capsule output directory already exists: ${outDir}`, { cause: error })
    }
    return {
      capsuleDir: outDir,
      capsuleManifestPath: join(outDir, 'capsule.json'),
      sha256sumsPath: join(outDir, 'SHA256SUMS'),
      capsuleHash,
    }
  } catch (error) {
    await rm(buildDir, { recursive: true, force: true })
    throw error
  }
}
