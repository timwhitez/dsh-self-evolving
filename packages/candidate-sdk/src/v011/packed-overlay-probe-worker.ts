#!/usr/bin/env node
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

// The production ACP bin awaits app-boot's Loader activation audit at module
// top level. Import resolution therefore proves the exact packed config tree
// settled before the parent is allowed to send initialize/session requests.
process.argv = [process.execPath, entry, '--config', configPath]
await import(pathToFileURL(entry).href)

process.stderr.write(
  `DSH_SELF_EVOLVING_PACKED_OVERLAY_READY=${JSON.stringify({
    schemaVersion: 1,
    candidateId,
    configRef: 'runtime/cordis.yml',
    runtimeSettled: true,
  })}\n`,
)
