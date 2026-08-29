import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { ProposalGatewayAdapter, type ProposalGatewayRoute } from '@dsh-self-evolving/proposer'

export const name = 'dsh-self-evolving-llm-responses'
export const inject = ['llm']
export const provider = 'deepseek-official'
export const endpoint = 'https://api.deepseek.com/v1'
export const model = 'deepseek-v4-flash'
export const gatewaySocketPath = '/run/dsh-self-evolving/model.sock'

export interface Config {
  gatewaySocketPath: typeof gatewaySocketPath
  reasoningEffort: 'high'
  contextWindow: 1_048_576
  maxTokens: number
  requestDeadlineMs: number
}

export const Config: Schema<Config> = Schema.object({
  gatewaySocketPath: Schema.const(gatewaySocketPath).default(gatewaySocketPath),
  reasoningEffort: Schema.const('high').default('high'),
  contextWindow: Schema.const(1_048_576).default(1_048_576),
  maxTokens: Schema.number().min(1).max(384_000).default(32_768),
  requestDeadlineMs: Schema.number().min(1).max(3_600_000).default(1_500_000),
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
    new ProposalGatewayAdapter({
      socketPath: config.gatewaySocketPath,
      route,
      contextWindow: config.contextWindow,
      defaultDeadlineMs: config.requestDeadlineMs,
    }),
  )
}
