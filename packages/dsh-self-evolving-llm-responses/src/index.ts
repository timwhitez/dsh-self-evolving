import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { TrustedResponsesAdapter, type ProposalGatewayRoute } from '@dsh-self-evolving/proposer'

export const name = 'dsh-self-evolving-llm-responses'
export const inject = ['llm']
export const provider = 'deepseek-official'
export const endpoint = 'https://api.deepseek.com/v1'
export const model = 'deepseek-v4-flash'

export interface Config {
  apiKeyEnv: string
  reasoningEffort: 'high'
  contextWindow: 1_048_576
  maxTokens: number
}

export const Config: Schema<Config> = Schema.object({
  apiKeyEnv: Schema.string().default('DEEPSEEK_API_KEY'),
  reasoningEffort: Schema.const('high').default('high'),
  contextWindow: Schema.const(1_048_576).default(1_048_576),
  maxTokens: Schema.number().min(1).max(384_000).default(32_768),
})

export function apply(ctx: Context, config: Config): void {
  const route: ProposalGatewayRoute = {
    provider,
    endpoint,
    model,
    reasoningEffort: config.reasoningEffort,
    maxTokens: config.maxTokens,
  }
  ctx.llm.registerAdapter(
    [provider],
    new TrustedResponsesAdapter({
      route,
      expectedResponseModel: model,
      apiKeyEnv: config.apiKeyEnv,
      contextWindow: config.contextWindow,
      requestMaxRetries: 12,
      reasoningContinuationMaxTurns: 1,
    }),
  )
}
