import { execFile } from 'node:child_process'
import { access, readFile, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProjectConfig } from './config.js'
import { readSourceArchiveIdentity, verifySourceArchiveIdentity } from './source-identity.js'

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

async function privateFile(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null)
  return info?.isFile() === true && (info.mode & 0o077) === 0
}

export async function runDoctor(config: ProjectConfig): Promise<DoctorReport> {
  const authPath = join(homedir(), '.codex', 'auth.json')
  const codexConfigPath = join(homedir(), '.codex', 'config.toml')
  const [authPrivate, codexConfigPrivate] = await Promise.all([
    privateFile(authPath),
    privateFile(codexConfigPath),
  ])
  let routeAvailable = false
  let credentialAvailable = false
  if (authPrivate && codexConfigPrivate) {
    const [authRaw, configRaw] = await Promise.all([
      readFile(authPath, 'utf8'),
      readFile(codexConfigPath, 'utf8'),
    ])
    const auth = JSON.parse(authRaw) as { OPENAI_API_KEY?: unknown }
    credentialAvailable =
      typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.trim().length > 0
    routeAvailable = /\[model_providers\.deepseek\][\s\S]*?base_url\s*=\s*"https:\/\//.test(
      configRaw,
    )
  }
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
      'private-auth',
      authPrivate && credentialAvailable,
      'root-only Codex credential is readable',
    ),
    check(
      'locked-route',
      codexConfigPrivate && routeAvailable,
      'DeepSeek compatible HTTPS route exists',
    ),
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
