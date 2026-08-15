export const OFFICIAL_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1' as const
export const OFFICIAL_DEEPSEEK_MODEL = 'deepseek-v4-flash' as const

export interface TrustedRoute {
  apiKey: string
  baseUrl: typeof OFFICIAL_DEEPSEEK_BASE_URL
}

export function loadTrustedRoute(env: NodeJS.ProcessEnv = process.env): Promise<TrustedRoute> {
  const apiKey = env['DEEPSEEK_API_KEY']?.trim()
  if (!apiKey) {
    return Promise.reject(
      new Error('trusted route: DEEPSEEK_API_KEY is unavailable for the official provider'),
    )
  }
  return Promise.resolve({ apiKey, baseUrl: OFFICIAL_DEEPSEEK_BASE_URL })
}
