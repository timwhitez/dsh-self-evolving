#!/usr/bin/env tsx
/**
 * Gate 0 guard: AGENTS.md and CLAUDE.md must be byte-identical so the two
 * instruction surfaces cannot drift (spec 07 §12 CI gates).
 */
import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const a = await readFile(resolve(root, 'AGENTS.md'))
const b = await readFile(resolve(root, 'CLAUDE.md'))
if (a.equals(b)) {
  console.log('✓ AGENTS.md and CLAUDE.md are byte-identical.')
} else {
  console.error(`✗ AGENTS.md (${a.length}B) and CLAUDE.md (${b.length}B) differ.`)
  process.exit(1)
}
