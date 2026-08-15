#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function run(file, args, cwd = repoRoot) {
  execFileSync(file, args, { cwd, stdio: 'inherit' })
}

run(process.execPath, [join(repoRoot, 'scripts', 'bootstrap-upstreams.mjs')])
run(process.execPath, [join(repoRoot, 'scripts', 'bootstrap-references.mjs')])
run('pnpm', ['install', '--frozen-lockfile'])
run('pnpm', ['install', '--frozen-lockfile'], join(repoRoot, 'deepseek-harness'))
run('pnpm', ['build'], join(repoRoot, 'deepseek-harness'))
run('uv', ['sync', '--project', join(repoRoot, 'harbor')])
run('pnpm', ['build'])
run('pnpm', ['provenance:check'])
