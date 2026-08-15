#!/usr/bin/env tsx
/**
 * Gate 0 provenance verifier (spec 07 §2 Accept: "provenance 可机器验证").
 *
 * Checks, against the recorded provenance.lock.json:
 *  1. each upstream path is a git checkout at the recorded commit;
 *  2. each upstream working tree is clean (read-only pins, AGENTS.md rule 1);
 *  3. the live Node/pnpm versions match;
 *  4. referenced @deepseek-ai/* package versions match deepseek-harness/package.json;
 *  5. materialized external-reference hashes match.
 *
 * Exits non-zero on any mismatch. No network access; purely local content addressing.
 */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lockPath = resolve(root, 'provenance.lock.json')

interface Upstream {
  path: string
  vcs?: string
  commit: string
  lockfileIntegrity?: { algo: string; value: string }
}
interface Lock {
  version: number
  upstreams: Record<string, Upstream>
  references?: Record<string, { path?: string; sourceUrl?: string; algo?: string; value?: string }>
  toolchain: { node: string; pnpm: string }
  dshPackages?: Record<string, string>
}

let failures = 0
function fail(msg: string): void {
  console.error(`✗ ${msg}`)
  failures++
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

async function main(): Promise<void> {
  const lock: Lock = JSON.parse(await readFile(lockPath, 'utf8'))
  console.log(`Provenance lock version ${lock.version}`)

  // 1 & 2. Upstream checkouts + clean trees.
  for (const [name, up] of Object.entries(lock.upstreams)) {
    const dir = resolve(root, up.path)
    if (
      !(await stat(dir)
        .then((s) => s.isDirectory())
        .catch(() => false))
    ) {
      fail(`upstream ${name}: path ${up.path} is not a directory`)
      continue
    }
    const head = git(dir, 'rev-parse', 'HEAD')
    if (head !== up.commit) fail(`upstream ${name}: HEAD ${head} != locked ${up.commit}`)
    else console.log(`✓ ${name} @ ${head.slice(0, 12)}`)
    const dirty = git(dir, 'status', '--porcelain')
    if (dirty) fail(`upstream ${name}: working tree dirty (read-only pin violated):\n${dirty}`)
    // 2b. Optional lockfile integrity (content-addressed pin of the upstream's lockfile).
    if (up.lockfileIntegrity) {
      const lockfilePath = resolve(dir, 'pnpm-lock.yaml')
      const data = await readFile(lockfilePath).catch(() => null)
      if (data === null) {
        fail(`upstream ${name}: lockfileIntegrity pinned but pnpm-lock.yaml missing`)
      } else {
        const hash = createHash('sha256').update(data).digest('hex')
        if (hash !== up.lockfileIntegrity.value) {
          fail(`upstream ${name}: lockfile sha256 ${hash} != pinned ${up.lockfileIntegrity.value}`)
        } else {
          console.log(`✓ ${name} lockfile sha256 matched`)
        }
      }
    }
  }

  // 3. Toolchain.
  const nodeV = process.version
  if (!nodeV.startsWith(lock.toolchain.node.split('.')[0]))
    fail(`node ${nodeV} != ${lock.toolchain.node}`)
  const pnpmV = execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim()
  if (pnpmV !== lock.toolchain.pnpm) fail(`pnpm ${pnpmV} != ${lock.toolchain.pnpm}`)
  console.log(`✓ toolchain node=${nodeV} pnpm=${pnpmV}`)

  // 4. DSH package versions vs deepseek-harness/package.json (workspace versions).
  if (lock.dshPackages) {
    const dshRoot = resolve(root, 'deepseek-harness')
    for (const [pkg, expected] of Object.entries(lock.dshPackages)) {
      // Non-package metadata keys (e.g. "note") are not version-pinned.
      if (!pkg.startsWith('@')) continue
      const pkgDir = pkg.replace('@deepseek-ai/', '')
      // vendor packages live under vendor/, others under packages/*/*
      const candidates = [
        resolve(dshRoot, 'vendor', pkgDir, 'package.json'),
        resolve(dshRoot, 'packages', pkgDir.replace(/^dsh-/, ''), 'package.json'),
      ]
      let found: string | null = null
      for (const c of candidates) {
        if (
          await stat(c)
            .then((s) => s.isFile())
            .catch(() => false)
        ) {
          found = c
          break
        }
      }
      // Fallback: search by name field across the tree.
      if (!found) {
        try {
          const out = execFileSync(
            'grep',
            ['-rl', `"name": "${pkg}"`, '--include=package.json', 'vendor', 'packages'],
            {
              cwd: dshRoot,
              encoding: 'utf8',
            },
          )
            .trim()
            .split('\n')[0]
          if (out) found = resolve(dshRoot, out)
        } catch {
          /* ignore */
        }
      }
      if (!found) {
        fail(`dsh package ${pkg}: manifest not found`)
        continue
      }
      const pj = JSON.parse(await readFile(found!, 'utf8'))
      if (pj.version !== expected) fail(`dsh package ${pkg}: version ${pj.version} != ${expected}`)
      else console.log(`✓ ${pkg}@${pj.version}`)
    }
  }

  // 5. Materialized reference hashes.
  if (lock.references) {
    for (const [name, ref] of Object.entries(lock.references)) {
      if (!ref.path || !ref.value) continue
      const full = ref.path.startsWith('/') ? ref.path : resolve(root, ref.path)
      const data = await readFile(full).catch((error: NodeJS.ErrnoException) => {
        fail(
          `reference ${name}: ${ref.path} unavailable (${error.code ?? 'UNKNOWN'}); run pnpm bootstrap:references`,
        )
        return null
      })
      if (data === null) continue
      const hash = createHash('sha256').update(data).digest('hex')
      if (hash !== ref.value) fail(`reference ${name}: sha256 ${hash} != ${ref.value}`)
      else console.log(`✓ reference ${name} sha256 matched`)
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} provenance check(s) FAILED`)
    process.exit(1)
  }
  console.log('\nAll provenance checks passed.')
}

await main()
