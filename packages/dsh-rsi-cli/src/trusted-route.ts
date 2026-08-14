import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface TrustedRoute {
  apiKey: string
  baseUrl: string
}

async function assertPrivate(path: string): Promise<void> {
  const info = await stat(path)
  if (
    !info.isFile() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== (process.getuid?.() ?? info.uid)
  ) {
    throw new Error(`trusted route: ${path} must be current-UID owned and mode 0600`)
  }
}

export async function loadTrustedRoute(): Promise<TrustedRoute> {
  const authPath = join(homedir(), '.codex', 'auth.json')
  const configPath = join(homedir(), '.codex', 'config.toml')
  await Promise.all([assertPrivate(authPath), assertPrivate(configPath)])
  const [authRaw, configRaw] = await Promise.all([
    readFile(authPath, 'utf8'),
    readFile(configPath, 'utf8'),
  ])
  const auth = JSON.parse(authRaw) as { OPENAI_API_KEY?: unknown }
  const section = configRaw.match(/\[model_providers\.deepseek\]([\s\S]*?)(?:\n\[|$)/)?.[1]
  const baseUrl = section?.match(/^base_url\s*=\s*"([^"]+)"/m)?.[1]
  if (typeof auth.OPENAI_API_KEY !== 'string' || auth.OPENAI_API_KEY.trim().length === 0) {
    throw new Error('trusted route: bearer credential unavailable')
  }
  if (baseUrl === undefined || !baseUrl.startsWith('https://')) {
    throw new Error('trusted route: compatible HTTPS endpoint unavailable')
  }
  return { apiKey: auth.OPENAI_API_KEY, baseUrl }
}
