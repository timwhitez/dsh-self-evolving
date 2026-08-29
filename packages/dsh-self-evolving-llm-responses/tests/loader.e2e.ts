import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import * as ResponsesBundle from '../src/index.js'

describe('brokered Responses Cordis adapter', () => {
  it('registers only the locked Unix-gateway route without a provider credential', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(ResponsesBundle, {
      gatewaySocketPath: '/run/dsh-self-evolving/model.sock',
      reasoningEffort: 'high',
      contextWindow: 1_048_576,
      maxTokens: 32_768,
      requestDeadlineMs: 1_500_000,
    })
    await expect(
      ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-v4-flash'),
    ).resolves.toMatchObject({
      provider: 'deepseek-official',
      id: 'deepseek-v4-flash',
      context: { contextWindow: 1_048_576 },
      defaultMaxTokens: 32_768,
    })
    expect(JSON.stringify(ResponsesBundle.Config)).not.toContain('DEEPSEEK_API_KEY')
    await ctx.fiber.dispose()
    expect(ctx.get('llm')).toBeUndefined()
  })
})
