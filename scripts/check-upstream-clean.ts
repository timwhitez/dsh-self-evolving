#!/usr/bin/env tsx
/**
 * Gate 0 guard: the three upstream trees must be unmodified (AGENTS.md rule 1).
 * Runs as a CI gate; fails if any of deepseek-harness/, harbor/, tb/ has local changes.
 */
import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const upstreams = ['deepseek-harness', 'harbor', 'tb']
let failed = false

for (const up of upstreams) {
  const dir = resolve(root, up)
  let status: string
  try {
    status = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' })
  } catch (e) {
    console.error(`✗ ${up}: not a git checkout (${(e as Error).message})`)
    failed = true
    continue
  }
  if (status.trim()) {
    console.error(`✗ ${up}: working tree is dirty (read-only upstream violated):\n${status}`)
    failed = true
  } else {
    console.log(`✓ ${up}: clean`)
  }
}

if (failed) process.exit(1)
console.log('All upstream trees clean.')
