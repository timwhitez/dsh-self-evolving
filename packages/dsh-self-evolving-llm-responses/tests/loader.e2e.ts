import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import * as ResponsesBundle from '../src/index.js'

describe('official Responses Cordis adapter', () => {
  it('registers only the locked official model route and unloads cleanly', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(ResponsesBundle, {
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      reasoningEffort: 'high',
      contextWindow: 1_048_576,
      maxTokens: 32_768,
    })
    await expect(
      ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-v4-flash'),
    ).resolves.toMatchObject({
      provider: 'deepseek-official',
      id: 'deepseek-v4-flash',
      context: { contextWindow: 1_048_576 },
      defaultMaxTokens: 32_768,
    })
    await ctx.fiber.dispose()
    expect(ctx.get('llm')).toBeUndefined()
  })
})
