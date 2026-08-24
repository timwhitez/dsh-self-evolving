#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { auditStableRun } from './audit.js'
import {
  createStableDemoConfig,
  createV011DemoConfig,
  initializeState,
  loadProjectConfig,
  V011_STABLE_DEMO_PROFILE,
  type InitConfigInput,
} from './config.js'
import { parseInitProfile } from './init-profile.js'
import { parseDshCliArguments } from './arguments.js'
import { runDoctor } from './doctor.js'
import { readControllerStatus } from '@dsh-self-evolving/core'
import { runStableDemo } from './engine.js'
import { createRealCapabilities } from './real-capabilities.js'
import { createV011RealCapabilities } from './v011-real-capabilities.js'
import { auditV011Run } from './v011-audit.js'
import {
  finalizeCrashResumeReceipt,
  readCrashInjectionRequest,
  requestCrashInjection,
} from './crash.js'
import { readSourceArchiveIdentity } from './source-identity.js'

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
  const cli = parseDshCliArguments(process.argv[2], process.argv.slice(3))
  const { command } = cli
  if (command === 'init') {
    const profile = parseInitProfile(cli.value('--profile'))
    const repoRoot = resolve(cli.value('--repo-root') ?? process.cwd())
    const input: InitConfigInput = {
      runId: cli.value('--run-id')!,
      stateDir: resolve(cli.value('--state-dir')!),
      repoRoot,
      codeCommit: await sourceCommit(repoRoot),
      ...(cli.value('--tb-root') === undefined
        ? {}
        : { terminalBenchRoot: cli.value('--tb-root')! }),
      ...(cli.value('--budget-usd') === undefined
        ? {}
        : { budgetUsd: Number(cli.value('--budget-usd')) }),
    }
    const config =
      profile === V011_STABLE_DEMO_PROFILE
        ? createV011DemoConfig(input)
        : createStableDemoConfig(input)
    const path = await initializeState(config)
    process.stdout.write(
      JSON.stringify({ command, status: 'INITIALIZED', configPath: path }) + '\n',
    )
    return
  }

  const config = await loadProjectConfig(resolve(cli.value('--state-dir')!))
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
    const report =
      config.profile === V011_STABLE_DEMO_PROFILE
        ? await auditV011Run(config)
        : await auditStableRun(config)
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
  const caps =
    config.profile === V011_STABLE_DEMO_PROFILE
      ? await createV011RealCapabilities(config)
      : await createRealCapabilities(config)
  if (command === 'run' && cli.flag('--inject-crash-after-first-candidate')) {
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
  const output =
    config.profile === V011_STABLE_DEMO_PROFILE
      ? { ...result, capabilityStatus: (await auditV011Run(config)).status }
      : result
  process.stdout.write(JSON.stringify(output, null, 2) + '\n')
}

await main()
