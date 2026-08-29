/* global process */

import { publishGate5Summary, reconcileGate5Summary } from '../../lib/gate5-summary.js'

const path = process.env.DSH_GATE5_SUMMARY_PATH
const bytes = process.env.DSH_GATE5_SUMMARY_BYTES
const mode = process.env.DSH_GATE5_SUMMARY_MODE ?? 'crash-publish'
const killAt = process.env.DSH_GATE5_SUMMARY_KILL_AT

if (typeof path !== 'string' || typeof bytes !== 'string') {
  throw new Error('gate5 summary worker: missing fixture input')
}

if (mode === 'reconcile') {
  process.stdout.write(`${await reconcileGate5Summary({ path, bytes })}\n`)
  process.exit(0)
}

if (mode === 'crash-reconcile-lock') {
  await reconcileGate5Summary({
    path,
    bytes,
    afterLockAcquired() {
      process.kill(process.pid, 'SIGKILL')
    },
  })
  throw new Error('gate5 summary worker: lock checkpoint was not reached')
}

if (mode !== 'crash-publish' || typeof killAt !== 'string') {
  throw new Error('gate5 summary worker: invalid fixture mode')
}

await publishGate5Summary({
  path,
  bytes,
  afterCheckpoint(checkpoint) {
    if (checkpoint === killAt) process.kill(process.pid, 'SIGKILL')
  },
})

throw new Error(`gate5 summary worker: checkpoint was not reached: ${killAt}`)
