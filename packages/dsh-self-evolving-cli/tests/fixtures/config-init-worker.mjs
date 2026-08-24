/* global process */

import { initializeState } from '../../lib/config.js'

const config = JSON.parse(process.env.DSH_INIT_CONFIG ?? 'null')
const killAt = process.env.DSH_INIT_KILL_AT

if (config === null || typeof killAt !== 'string') {
  throw new Error('config init worker: missing fixture input')
}

await initializeState(config, {
  onCheckpoint(checkpoint) {
    if (checkpoint === killAt) process.kill(process.pid, 'SIGKILL')
  },
})

throw new Error(`config init worker: checkpoint was not reached: ${killAt}`)
