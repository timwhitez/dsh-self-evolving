#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lock = JSON.parse(await readFile(join(repoRoot, 'provenance.lock.json'), 'utf8'))
const pinned = lock.upstreams?.['deepseek-harness']?.commit
if (typeof pinned !== 'string' || !/^[0-9a-f]{40}$/.test(pinned)) {
  throw new Error('dsh latest check: invalid pinned commit')
}
const output = execFileSync(
  '/usr/bin/git',
  ['ls-remote', 'https://github.com/deepseek-ai/deepseek-harness', 'HEAD'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
)
const latest = output.trim().split(/\s+/)[0]
if (latest === undefined || !/^[0-9a-f]{40}$/.test(latest)) {
  throw new Error('dsh latest check: invalid remote HEAD')
}
const status = pinned === latest ? 'PIN_IS_LATEST' : 'UPDATE_AVAILABLE'
process.stdout.write(JSON.stringify({ status, pinned, latest }) + '\n')
if (process.argv.includes('--require-latest') && status !== 'PIN_IS_LATEST') process.exitCode = 2
