import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import type { ProjectConfig } from './config.js'
import { readSourceArchiveIdentity, verifySourceArchiveIdentity } from './source-identity.js'
import {
  loadTrustedRoute,
  OFFICIAL_DEEPSEEK_BASE_URL,
  OFFICIAL_DEEPSEEK_MODEL,
} from './trusted-route.js'

export type CheckStatus = 'PASS' | 'FAIL'
export interface DoctorCheck {
  name: string
  status: CheckStatus
  detail: string
}
export interface DoctorReport {
  ready: boolean
  checks: DoctorCheck[]
}

async function commandOk(file: string, args: string[]): Promise<boolean> {
  return new Promise((done) => {
    execFile(file, args, { timeout: 15_000 }, (error) => done(error === null))
  })
}

async function commandOutput(file: string, args: string[]): Promise<string | null> {
  return new Promise((done) => {
    execFile(file, args, { timeout: 15_000 }, (error, stdout) =>
      done(error === null ? stdout.trim() : null),
    )
  })
}

function check(name: string, passed: boolean, detail: string): DoctorCheck {
  return { name, status: passed ? 'PASS' : 'FAIL', detail }
}

async function officialModelAvailable(apiKey: string): Promise<boolean> {
  try {
    const response = await fetch(`${OFFICIAL_DEEPSEEK_BASE_URL}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return false
    const body = (await response.json()) as { data?: Array<{ id?: unknown }> }
    return body.data?.some((entry) => entry.id === OFFICIAL_DEEPSEEK_MODEL) === true
  } catch {
    return false
  }
}

export async function runDoctor(config: ProjectConfig): Promise<DoctorReport> {
  const route = await loadTrustedRoute().catch(() => null)
  const credentialAvailable = route !== null
  const routeAvailable =
    config.model.endpoint === OFFICIAL_DEEPSEEK_BASE_URL &&
    config.model.requested === OFFICIAL_DEEPSEEK_MODEL &&
    config.model.effective === OFFICIAL_DEEPSEEK_MODEL &&
    config.model.wireApi === 'responses'
  const modelAvailable =
    route !== null && routeAvailable ? await officialModelAvailable(route.apiKey) : false
  const observed = JSON.parse(await readFile(config.splitCommitmentPath, 'utf8')) as {
    observedTaskIds?: unknown
  }
  const ids = Array.isArray(observed.observedTaskIds)
    ? observed.observedTaskIds.filter((id): id is string => typeof id === 'string')
    : []
  const taskProbe = ids[0]
  const taskMaterialized =
    taskProbe !== undefined &&
    (await access(join(config.terminalBenchRoot, taskProbe, 'task.toml'), constants.R_OK)
      .then(() => true)
      .catch(() => false))
  const gitCommit = await commandOutput('/usr/bin/git', [
    '-C',
    config.repoRoot,
    'rev-parse',
    'HEAD',
  ])
  const codePaths = [
    'packages',
    'benchmark-adapters',
    'scripts',
    'package.json',
    'pnpm-lock.yaml',
    'tsconfig.json',
    'provenance.lock.json',
  ]
  const trackedCodeClean = await commandOk('/usr/bin/git', [
    '-C',
    config.repoRoot,
    'diff',
    '--quiet',
    'HEAD',
    '--',
    ...codePaths,
  ])
  const untrackedCode = await commandOutput('/usr/bin/git', [
    '-C',
    config.repoRoot,
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    'packages',
    'benchmark-adapters',
    'scripts',
  ])
  const archiveIdentity =
    gitCommit === null ? await readSourceArchiveIdentity(config.repoRoot) : null
  const archiveVerification =
    archiveIdentity === null
      ? null
      : await verifySourceArchiveIdentity(config.repoRoot, archiveIdentity)
  const currentCommit = gitCommit ?? archiveIdentity?.commit ?? null
  const codeClean =
    gitCommit === null
      ? archiveVerification?.valid === true
      : trackedCodeClean && untrackedCode === ''
  const codeDetail =
    gitCommit === null
      ? (archiveVerification?.detail ?? 'source archive identity is missing')
      : 'executable source paths match the frozen commit'
  const checks = [
    check(
      'official-auth',
      credentialAvailable,
      'DEEPSEEK_API_KEY is available only to the trusted host process',
    ),
    check(
      'locked-responses-route',
      routeAvailable,
      'official DeepSeek Responses route is frozen in the run config',
    ),
    check('official-model', modelAvailable, 'official model listing contains deepseek-v4-flash'),
    check('docker', await commandOk('/usr/bin/docker', ['info']), 'Docker daemon responds'),
    check(
      'harbor',
      await commandOk(join(config.repoRoot, 'harbor', '.venv', 'bin', 'harbor'), ['--help']),
      'pinned Harbor CLI starts',
    ),
    check('task-materialization', taskMaterialized, 'published observed task material is readable'),
    check(
      'writable-state',
      await access(config.stateDir, constants.R_OK | constants.W_OK | constants.X_OK)
        .then(() => true)
        .catch(() => false),
      'private run state is writable',
    ),
    check('budget', config.limits.budgetUsd > 0, `reserved budget $${config.limits.budgetUsd}`),
    check(
      'code-identity',
      currentCommit === config.codeCommit,
      `source commit ${config.codeCommit}`,
    ),
    check('code-worktree', codeClean, codeDetail),
  ]
  return { ready: checks.every((item) => item.status === 'PASS'), checks }
}
