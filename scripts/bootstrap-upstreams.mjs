#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const provenance = JSON.parse(await readFile(join(repoRoot, 'provenance.lock.json'), 'utf8'))
const sources = {
  'deepseek-harness': 'https://github.com/deepseek-ai/deepseek-harness',
  harbor: 'https://github.com/laude-institute/harbor.git',
  'terminal-bench': 'https://github.com/laude-institute/terminal-bench.git',
}

function git(args, cwd = repoRoot) {
  return new Promise((done, reject) => {
    execFile('/usr/bin/git', args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) =>
      error
        ? reject(new Error(`git ${args[0]} failed: ${stderr}`, { cause: error }))
        : done(stdout.trim()),
    )
  })
}

for (const [name, record] of Object.entries(provenance.upstreams)) {
  const target = resolve(repoRoot, record.path)
  const expectedUrl = sources[name]
  if (expectedUrl === undefined) throw new Error(`bootstrap: no allowlisted source for ${name}`)
  const exists = await stat(target)
    .then(() => true)
    .catch(() => false)
  if (!exists) {
    await git(['clone', '--no-checkout', '--filter=blob:none', expectedUrl, target])
    await git(['fetch', '--depth=1', 'origin', record.commit], target)
    await git(['checkout', '--detach', record.commit], target)
  }
  const [remote, head, status] = await Promise.all([
    git(['remote', 'get-url', 'origin'], target),
    git(['rev-parse', 'HEAD'], target),
    git(['status', '--porcelain'], target),
  ])
  const normalize = (value) => value.replace(/\.git$/, '').replace(/\/$/, '')
  if (normalize(remote) !== normalize(expectedUrl))
    throw new Error(`bootstrap: ${name} remote mismatch`)
  if (head !== record.commit) throw new Error(`bootstrap: ${name} commit mismatch: ${head}`)
  if (status.length !== 0) throw new Error(`bootstrap: ${name} worktree is dirty`)
  process.stdout.write(`${name} ${head} READY\n`)
}
