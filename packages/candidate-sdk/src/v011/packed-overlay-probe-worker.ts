#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { writeSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [entry, configPath, candidateId] = process.argv.slice(2)
if (
  entry === undefined ||
  !entry.startsWith('/runtime/node_modules/') ||
  configPath !== '/runtime/cordis.yml' ||
  candidateId === undefined ||
  !/^sha256:[0-9a-f]{64}$/.test(candidateId)
) {
  throw new Error('v0.1.1 packed-overlay probe: invalid trusted arguments')
}

function writeControl(value: unknown): void {
  const bytes = Buffer.from(`DSH_SELF_EVOLVING_PACKED_OVERLAY_CONTROL=${JSON.stringify(value)}\n`)
  let offset = 0
  while (offset < bytes.byteLength) {
    offset += writeSync(2, bytes, offset, bytes.byteLength - offset)
  }
}

// Candidate code shares stderr, but the pipe is write-only and the nonce is
// module-local. An early, extra, reordered, or guessed control record makes
// the parent-side canonical transcript fail closed.
const nonce = randomBytes(32).toString('hex')
writeControl({ schemaVersion: 1, phase: 'challenge', nonce })

// The production ACP bin awaits app-boot's Loader activation audit at module
// top level. Import resolution therefore proves the exact packed config tree
// settled before the parent is allowed to send initialize/session requests.
process.argv = [process.execPath, entry, '--config', configPath]
await import(pathToFileURL(entry).href)

writeControl({
  schemaVersion: 1,
  phase: 'ready',
  nonce,
  candidateId,
  configRef: 'runtime/cordis.yml',
  runtimeSettled: true,
})
