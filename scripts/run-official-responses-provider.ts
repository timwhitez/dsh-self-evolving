#!/usr/bin/env tsx
/** Verify and exercise the locked DeepSeek official Responses route without persisting its key. */
import { spawn } from 'node:child_process'

const endpoint = 'https://api.deepseek.com/v1'
const model = 'deepseek-v4-flash'

async function main(): Promise<void> {
  const apiKey = process.env['DEEPSEEK_API_KEY']?.trim()
  if (!apiKey) throw new Error('official provider launcher: DEEPSEEK_API_KEY is unavailable')
  const response = await fetch(`${endpoint}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok)
    throw new Error(`official provider launcher: model probe HTTP ${response.status}`)
  const body = (await response.json()) as { data?: Array<{ id?: unknown }> }
  if (body.data?.some((entry) => entry.id === model) !== true) {
    throw new Error(`official provider launcher: ${model} is unavailable`)
  }
  process.stdout.write(
    `provider=deepseek-official endpoint=${endpoint} model=${model} reasoning=high context=1048576 max_output=32768 wire=responses store=false\n`,
  )
  if (process.argv.includes('--check')) return
  const files = process.argv.includes('--effectiveness')
    ? ['packages/dsh-self-evolving-proposer/tests/v011-sandboxed-proposal.e2e.ts']
    : [
        'packages/dsh-self-evolving-proposer/tests/sandboxed-dsh-proposal.e2e.ts',
        'packages/dsh-self-evolving-proposer/tests/real-model-propose.e2e.ts',
      ]
  const child = spawn(
    'pnpm',
    [
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.e2e.config.ts',
      ...files,
      '--maxWorkers=1',
      '--no-file-parallelism',
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    },
  )
  const result = await new Promise<number>((resolve) => {
    child.once('exit', (code, signal) => resolve(code ?? (signal === null ? 1 : 128)))
  })
  process.exitCode = result
}

await main()
