#!/usr/bin/env node
import { readControllerStatus } from './status.js'

function valueAfter(flag: string): string {
  const index = process.argv.indexOf(flag)
  const value = index === -1 ? undefined : process.argv[index + 1]
  if (value === undefined || value.length === 0) {
    throw new Error(`missing required ${flag}`)
  }
  return value
}

const status = await readControllerStatus({
  stateDir: valueAfter('--state-dir'),
  runId: valueAfter('--run-id'),
})
process.stdout.write(JSON.stringify(status) + '\n')
