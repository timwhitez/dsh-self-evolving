#!/usr/bin/env node
import { parseStatusCliArguments } from './cli-args.js'
import { readControllerStatus } from './status.js'

const input = parseStatusCliArguments(process.argv.slice(2))
const status = await readControllerStatus(input)
process.stdout.write(JSON.stringify(status) + '\n')
