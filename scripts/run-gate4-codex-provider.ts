#!/usr/bin/env tsx
/** Inject the current Codex DeepSeek credential into the trusted Gate 4 host only. */
import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const codexDir = join(homedir(), '.codex')
const authPath = join(codexDir, 'auth.json')
const configPath = join(codexDir, 'config.toml')
const targetModel = 'deepseek-v4-flash-zen'
const targetContext = 1_048_576
const targetReasoningEffort = 'high'
const targetMaxOutputTokens = 32_768
const receiptPath = join(process.cwd(), 'evidence', 'gate4', 'zen-1m-successor-receipt.json')

async function assertPrivate(path: string): Promise<void> {
  const info = await stat(path)
  if (
    (info.mode & 0o777) !== 0o600 ||
    (process.getuid !== undefined && info.uid !== process.getuid())
  ) {
    throw new Error(`provider launcher: ${path} must be owned by the current uid and mode 0600`)
  }
}

function deepseekSection(config: string): string {
  const section = config.match(/\[model_providers\.deepseek\]([\s\S]*?)(?:\n\[|$)/)?.[1]
  if (section === undefined) throw new Error('provider launcher: deepseek provider section missing')
  return section
}

function findModel(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findModel(item)
      if (found !== null) return found
    }
  } else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (record['slug'] === targetModel) return record
    for (const item of Object.values(record)) {
      const found = findModel(item)
      if (found !== null) return found
    }
  }
  return null
}

async function main(): Promise<void> {
  await Promise.all([assertPrivate(authPath), assertPrivate(configPath)])
  const [authRaw, config] = await Promise.all([
    readFile(authPath, 'utf8'),
    readFile(configPath, 'utf8'),
  ])
  const auth = JSON.parse(authRaw) as { OPENAI_API_KEY?: unknown }
  if (typeof auth.OPENAI_API_KEY !== 'string' || auth.OPENAI_API_KEY.length === 0) {
    throw new Error('provider launcher: Codex bearer credential missing')
  }
  const section = deepseekSection(config)
  const baseUrl = section.match(/^base_url\s*=\s*"([^"]+)"/m)?.[1]
  const wireApi = section.match(/^wire_api\s*=\s*"([^"]+)"/m)?.[1]
  if (baseUrl === undefined || !baseUrl.startsWith('https://') || wireApi !== 'responses') {
    throw new Error('provider launcher: Codex DeepSeek provider configuration is invalid')
  }
  const catalogPath = config.match(/^model_catalog_json\s*=\s*"([^"]+)"/m)?.[1]
  if (catalogPath === undefined) throw new Error('provider launcher: model catalog path missing')
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as unknown
  const model = findModel(catalog)
  const supportedReasoning = model?.['supported_reasoning_levels']
  if (
    model === null ||
    model['context_window'] !== targetContext ||
    !Array.isArray(supportedReasoning) ||
    !supportedReasoning.some(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        (entry as Record<string, unknown>)['effort'] === targetReasoningEffort,
    )
  ) {
    throw new Error(`provider launcher: ${targetModel} must have ${targetContext} context tokens`)
  }

  process.stdout.write(
    `Gate 4 trusted host: provider=deepseek model=${targetModel} reasoning=${targetReasoningEffort} context=${targetContext} max_output=${targetMaxOutputTokens} wire=chat-completions-compatible\n`,
  )
  if (process.argv.includes('--check')) return
  const child = spawn(
    'pnpm',
    [
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.e2e.config.ts',
      'packages/dsh-rsi-proposer/tests/sandboxed-dsh-proposal.e2e.ts',
      '-t',
      'sandboxed real provider successor',
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        RSI_PROVIDER_API_KEY: auth.OPENAI_API_KEY,
        RSI_PROVIDER_BASE_URL: baseUrl,
        RSI_GATE4_RECEIPT_PATH: receiptPath,
      },
      stdio: 'inherit',
    },
  )
  const result = await new Promise<number>((resolve) => {
    child.once('exit', (code, signal) => resolve(code ?? (signal === null ? 1 : 128)))
  })
  process.exitCode = result
}

await main()
