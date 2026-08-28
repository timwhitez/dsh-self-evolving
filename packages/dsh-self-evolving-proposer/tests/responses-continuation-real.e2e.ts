import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type CallId,
  type Message,
  type StreamChunk,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { TrustedResponsesAdapter, type ProposalGatewayRoute } from '../src/index.js'

const credentialEnv = 'OPENAI_API_KEY'
const endpoint = process.env['OPENAI_BASE_URL']?.trim().replace(/\/$/, '') ?? ''
const model = process.env['OPENAI_MODEL']?.trim() ?? ''
const reasoningEffort = process.env['OPENAI_REASONING_EFFORT']?.trim() ?? ''
const enabled = (process.env[credentialEnv]?.trim().length ?? 0) > 0
if (enabled && (endpoint.length === 0 || model.length === 0 || reasoningEffort.length === 0)) {
  throw new Error(
    'real Responses continuation E2E: OPENAI_BASE_URL, OPENAI_MODEL, and OPENAI_REASONING_EFFORT are required with OPENAI_API_KEY',
  )
}

const route: ProposalGatewayRoute = {
  provider: 'openai-compatible-responses',
  endpoint,
  model,
  reasoningEffort,
  maxTokens: 4096,
}

const echoTool: ToolSchema = {
  name: 'echo_context_marker',
  description: 'Return the supplied context marker unchanged.',
  parameters: {
    type: 'object',
    properties: { marker: { type: 'string' } },
    required: ['marker'],
    additionalProperties: false,
  },
}

async function stream(
  adapter: TrustedResponsesAdapter,
  messages: Message[],
  tools?: ToolSchema[],
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({
    provider: route.provider,
    model: route.model,
    reasoningEffort: route.reasoningEffort,
    maxTokens: route.maxTokens,
    system:
      'This is a deterministic protocol conformance test. Follow tool and verbatim-marker instructions exactly.',
    messages,
    ...(tools === undefined ? {} : { tools }),
  })) {
    chunks.push(chunk)
  }
  return chunks
}

function onlyToolCall(chunks: StreamChunk[]): {
  id: ReturnType<typeof CallId>
  name: string
  arguments: string
} {
  const calls = chunks.flatMap((chunk) =>
    chunk.type === 'block-end' && chunk.block.type === 'tool-call' ? [chunk.block] : [],
  )
  expect(calls).toHaveLength(1)
  return calls[0]!
}

function outputText(chunks: StreamChunk[]): string {
  return chunks
    .flatMap((chunk) =>
      chunk.type === 'block-end' && chunk.block.type === 'text' ? [chunk.block.text] : [],
    )
    .join('')
}

describe.skipIf(!enabled)('Responses continuation item shapes against a real endpoint', () => {
  it(
    'preserves unpredictable user and assistant context across two stateless tool rounds',
    { timeout: 600_000 },
    async () => {
      // Every value is independent: the final assertion cannot be satisfied
      // by deriving one marker from another or by echoing tool-call arguments.
      const userMarker = `USER-CONTEXT-${randomUUID()}`
      const assistantMarker = `ASSISTANT-CONTEXT-${randomUUID()}`
      const secondUserMarker = `SECOND-USER-CONTEXT-${randomUUID()}`
      const secondAssistantMarker = `SECOND-ASSISTANT-CONTEXT-${randomUUID()}`
      const firstResult = `FIRST-TOOL-RESULT-${randomUUID()}`
      const secondResult = `SECOND-TOOL-RESULT-${randomUUID()}`
      const firstToolArgument = `FIRST-TOOL-ARGUMENT-${randomUUID()}`
      const secondToolArgument = `SECOND-TOOL-ARGUMENT-${randomUUID()}`
      const adapter = new TrustedResponsesAdapter({
        route,
        expectedResponseModel: model,
        apiKeyEnv: credentialEnv,
        contextWindow: 1_048_576,
        requestMaxRetries: 2,
        reasoningContinuationMaxTurns: 1,
      })

      const firstUser = createUserMessage({
        content: [
          {
            type: 'text',
            text: `Remember this user-context marker for the final answer: ${userMarker}. Call echo_context_marker exactly once with marker ${firstToolArgument}. Do not answer in text.`,
          },
        ],
        source: { kind: 'user' },
      })
      const firstCall = onlyToolCall(await stream(adapter, [firstUser], [echoTool]))
      expect(firstCall.name).toBe(echoTool.name)
      expect(JSON.parse(firstCall.arguments)).toEqual({ marker: firstToolArgument })

      // The assistant text intentionally follows the function_call but precedes
      // its function_call_output in the translated Responses items. This is the
      // exact interleaving that issue #187 requires a real provider to accept.
      const firstAssistant = createAssistantMessage({
        content: [
          {
            type: 'tool-call',
            id: firstCall.id,
            name: firstCall.name,
            arguments: firstCall.arguments,
          },
          { type: 'text', text: assistantMarker },
        ],
        source: { provider: route.provider, model: route.model },
      })
      const firstToolResult = createToolResultMessage({
        callId: firstCall.id,
        content: [{ type: 'text', text: firstResult }],
        isError: false,
      })
      const secondUser = createUserMessage({
        content: [
          {
            type: 'text',
            text: `Remember this second user-context marker for the final answer: ${secondUserMarker}. Call echo_context_marker exactly once with marker ${secondToolArgument}. Do not answer in text.`,
          },
        ],
        source: { kind: 'user' },
      })
      const secondCall = onlyToolCall(
        await stream(adapter, [firstUser, firstAssistant, firstToolResult, secondUser], [echoTool]),
      )
      expect(secondCall.name).toBe(echoTool.name)
      expect(JSON.parse(secondCall.arguments)).toEqual({ marker: secondToolArgument })

      const secondAssistant = createAssistantMessage({
        content: [
          {
            type: 'tool-call',
            id: secondCall.id,
            name: secondCall.name,
            arguments: secondCall.arguments,
          },
          { type: 'text', text: secondAssistantMarker },
        ],
        source: { provider: route.provider, model: route.model },
      })
      const secondToolResult = createToolResultMessage({
        callId: secondCall.id,
        content: [{ type: 'text', text: secondResult }],
        isError: false,
      })
      const expected = [
        userMarker,
        assistantMarker,
        firstResult,
        secondUserMarker,
        secondAssistantMarker,
        secondResult,
      ]
      const finalUser = createUserMessage({
        content: [
          {
            type: 'text',
            // Deliberately contains NONE of the expected values: a provider
            // that dropped earlier message/tool-result items cannot pass by
            // echoing the latest prompt.
            text: 'Return the two earlier USER-CONTEXT markers, the two earlier ASSISTANT-CONTEXT markers, and the two earlier TOOL-RESULT markers in chronological order, verbatim. Do not call a tool.',
          },
        ],
        source: { kind: 'user' },
      })
      const finalText = outputText(
        await stream(adapter, [
          firstUser,
          firstAssistant,
          firstToolResult,
          secondUser,
          secondAssistant,
          secondToolResult,
          finalUser,
        ]),
      )
      expect(finalText.length).toBeGreaterThan(0)
      for (const marker of expected) expect(finalText).toContain(marker)
    },
  )
})
