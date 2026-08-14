#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { auditStableRun } from './audit.js'
import {
  createStableDemoConfig,
  initializeState,
  loadConfig,
  type InitConfigInput,
} from './config.js'
import { runDoctor } from './doctor.js'
import { readControllerStatus } from '@dsh-rsi/core'
import { runStableDemo } from './engine.js'
import { createRealCapabilities } from './real-capabilities.js'
import {
  finalizeCrashResumeReceipt,
  readCrashInjectionRequest,
  requestCrashInjection,
} from './crash.js'
import { readSourceArchiveIdentity } from './source-identity.js'

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function required(name: string): string {
  const value = option(name)
  if (value === undefined || value.length === 0) throw new Error(`missing required ${name}`)
  return value
}

function gitHead(repoRoot: string): Promise<string | null> {
  return new Promise((done) => {
    execFile('/usr/bin/git', ['-C', repoRoot, 'rev-parse', 'HEAD'], (error, stdout) =>
      error ? done(null) : done(stdout.trim()),
    )
  })
}

async function sourceCommit(repoRoot: string): Promise<string> {
  const commit = await gitHead(repoRoot)
  if (commit !== null) return commit
  const identity = await readSourceArchiveIdentity(repoRoot)
  if (identity === null) throw new Error('init: no Git HEAD or source archive identity')
  return identity.commit
}

async function main(): Promise<void> {
  const command = process.argv[2]
  if (command === 'init') {
    const repoRoot = resolve(option('--repo-root') ?? process.cwd())
    const input: InitConfigInput = {
      runId: required('--run-id'),
      stateDir: resolve(required('--state-dir')),
      repoRoot,
      codeCommit: await sourceCommit(repoRoot),
      ...(option('--tb-root') === undefined ? {} : { terminalBenchRoot: option('--tb-root')! }),
      ...(option('--budget-usd') === undefined
        ? {}
        : { budgetUsd: Number(option('--budget-usd')) }),
    }
    const config = createStableDemoConfig(input)
    const path = await initializeState(config)
    process.stdout.write(
      JSON.stringify({ command, status: 'INITIALIZED', configPath: path }) + '\n',
    )
    return
  }
  if (!['run', 'resume', 'status', 'audit', 'doctor'].includes(command ?? '')) {
    throw new Error('usage: dsh-rsi <init|run|resume|status|audit|doctor> --state-dir <path>')
  }
  const config = await loadConfig(resolve(required('--state-dir')))
  if (command === 'doctor') {
    const report = await runDoctor(config)
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    if (!report.ready) process.exitCode = 2
    return
  }
  if (command === 'status') {
    process.stdout.write(JSON.stringify(await readControllerStatus(config), null, 2) + '\n')
    return
  }
  if (command === 'audit') {
    const report = await auditStableRun(config)
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    if (!report.accepted) process.exitCode = 2
    return
  }
  const before = await readControllerStatus(config)
  if (command === 'run' && before.eventCount !== 0) {
    throw new Error('run: durable state already exists; use resume')
  }
  if (command === 'resume' && before.eventCount === 0) {
    throw new Error('resume: no durable run exists; use run')
  }
  const doctor = await runDoctor(config)
  if (!doctor.ready) {
    process.stdout.write(JSON.stringify(doctor, null, 2) + '\n')
    process.exitCode = 2
    return
  }
  const caps = await createRealCapabilities(config)
  if (command === 'run' && process.argv.includes('--inject-crash-after-first-candidate')) {
    await requestCrashInjection(config, {
      schemaVersion: 1,
      actionId: 'eval:candidate:1',
      boundary: 'launch',
    })
  }
  const crashRequest = await readCrashInjectionRequest(config)
  if (command === 'run' && crashRequest !== null) {
    caps.onEvaluationBoundary = (spec, boundary) => {
      if (spec.actionId === crashRequest.actionId && boundary === crashRequest.boundary) {
        process.kill(process.pid, 'SIGKILL')
      }
    }
  }
  const result = await runStableDemo(config, caps)
  if (command === 'resume') await finalizeCrashResumeReceipt(config)
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
}

await main()
