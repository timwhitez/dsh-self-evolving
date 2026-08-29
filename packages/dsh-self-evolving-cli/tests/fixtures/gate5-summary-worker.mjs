/* global process */

import { publishGate5Summary } from '../../lib/gate5-summary.js'

const path = process.env.DSH_GATE5_SUMMARY_PATH
const bytes = process.env.DSH_GATE5_SUMMARY_BYTES
const killAt = process.env.DSH_GATE5_SUMMARY_KILL_AT

if (typeof path !== 'string' || typeof bytes !== 'string' || typeof killAt !== 'string') {
  throw new Error('gate5 summary worker: missing fixture input')
}

await publishGate5Summary({
  path,
  bytes,
  afterCheckpoint(checkpoint) {
    if (checkpoint === killAt) process.kill(process.pid, 'SIGKILL')
  },
})

throw new Error(`gate5 summary worker: checkpoint was not reached: ${killAt}`)
