/**
 * Proposal runner — drives the real DSH agent + verified model to generate a
 * child candidate proposal (spec 03 §10, spec 07 §6 Accept).
 *
 * Flow:
 *   1. boot the real DSH Loader with a minimal model-backed composition
 *      (llm-deepseek → agent-spine-demo → agent-default-model);
 *   2. ctx.agents.create({ agentOptions: { provider, model }, setup }) to mint
 *      a scoped proposer agent whose ONLY model route is the locked one;
 *   3. followup with the proposal prompt (parent source + filtered evidence +
 *      the candidate schema + the output protocol contract);
 *   4. await whenIdle(); collect the assistant's final text;
 *   5. return the raw transcript for protocol validation + builder handoff.
 *
 * The model route is locked by composition: the only registered adapter is the
 * deepseek-official one pointed at the verified endpoint. The candidate (parent)
 * is loaded in propose mode so its prompt contribution composes the proposer
 * scope, not a solver scope.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-spine-demo'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { installModelSelection } from '@deepseek-ai/dsh-agent'

/** The locked model route (the only adapter registered in the composition). */
export interface ModelRoute {
  provider: string
  model: string
  maxTokens?: number
}

export function proposalMaxTokens(route: ModelRoute): number {
  const maxTokens = route.maxTokens ?? 2048
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new Error('proposer: route maxTokens must be a positive safe integer')
  }
  return maxTokens
}

export interface ProposalInput {
  /** The canonical parent candidate id (sha256 of its canonical source tar). */
  parentDigest: string
  /** The parent's source, as read-only text the proposer inspects. */
  parentSource: string
  /** A label-filtered evidence summary (DEV_OBSERVED only; no guard/sealed). */
  evidenceSummary: string
  /** The proposal width (how many children to request). */
  width: number
  /** Successor protocols may supply a complete versioned prompt contract. */
  rawPrompt?: string
}

export interface ProposalTranscript {
  assistantText: string
  /** The raw session events for audit / cost attribution. */
  eventCount: number
  /** Retained model-facing tool calls/results for trajectory-grounding audit. */
  toolTrace: Array<{ type: string; data: unknown }>
  modelRoute: ModelRoute
}

/**
 * Build the proposal prompt. It instructs the model to emit ONE child proposal
 * in a strict JSON envelope, referencing real evidence, with a falsifiable
 * mechanism-level hypothesis. The output protocol validator parses this.
 */
export function buildProposalPrompt(input: ProposalInput): string {
  return [
    'You are the proposer in a recursive self-improvement harness.',
    'Your job is to propose ONE improvement to the candidate harness below.',
    '',
    '## Parent candidate source (canonical parent digest: ' + input.parentDigest + ')',
    '```typescript',
    input.parentSource,
    '```',
    '',
    '## Development evidence (DEV_OBSERVED only; no guard/sealed data)',
    input.evidenceSummary,
    '',
    '## Output protocol (you MUST follow this exactly)',
    'Respond with a single JSON object (no prose, no markdown fences) with these fields:',
    '- proposalId: a short string id',
    '- canonicalParentDigest: must equal "' + input.parentDigest + '"',
    '- donorCandidates: array of sha256:<64-hex> digests (empty if none)',
    '- hypothesis: ONE falsifiable mechanism-level hypothesis (>= 20 chars)',
    '- evidenceRefs: array of evidence references you used',
    '- mechanismTests: array of test assertions that verify the mechanism',
    '- preservationTests: array of assertions that the change preserves existing behavior',
    '- sourceDiff: a unified diff (starting with @@) of the production source change',
    '',
    'Constraints:',
    '- Implement exactly ONE primary hypothesis; include协同 changes only if essential.',
    '- sourceDiff MUST apply to the exact parent source with git apply; copy context lines byte-for-byte.',
    '- If evidence reports PATCH_DOES_NOT_APPLY, emit a smaller hunk using exact visible parent lines.',
    '- Do NOT propose a no-change or test-only change.',
    '- Do NOT reference task names, verifier files, or expected outputs.',
    '- Width is ' + input.width + '; emit exactly ONE child in this response.',
  ].join('\n')
}

/**
 * Mint a proposer agent and drive one proposal turn. Returns the assistant's
 * final text. The `ctx` must already be booted with the model-backed
 * composition (see bootModelComposition).
 */
export async function runProposalTurn(
  ctx: Context,
  route: ModelRoute,
  input: ProposalInput,
  signal?: AbortSignal,
  setupAgent?: (agentCtx: Context) => void,
): Promise<ProposalTranscript> {
  const agents = (
    ctx as unknown as {
      get: <T = unknown>(name: string) => T | undefined
    }
  ).get<{
    create: (opts: {
      sessionId: unknown
      meta?: { cwd?: string }
      agentOptions?: { provider?: string; model?: string; maxTokens?: number }
      setup?: (agentCtx: Context) => void
      signal?: AbortSignal
    }) => Promise<{
      agent: {
        followup: (msg: unknown) => void
        whenIdle: () => Promise<void>
        session: { events: ReadonlyArray<{ type: string; data?: unknown }> }
      }
      dispose: () => Promise<void>
    }>
  }>('agents')
  if (!agents) throw new Error('proposer: ctx.agents unavailable (spine not mounted?)')

  const prompt = input.rawPrompt ?? buildProposalPrompt(input)
  const handle = await agents.create({
    sessionId: SessionId(`proposer-${process.pid}-${Date.now()}`),
    meta: { cwd: process.cwd() },
    agentOptions: {
      provider: route.provider,
      model: route.model,
      maxTokens: proposalMaxTokens(route),
    },
    setup: (agentCtx) => {
      // Lock the model selection in the agent scope before publication.
      installModelSelection(agentCtx, {
        current: { provider: route.provider, model: route.model },
        assembled: undefined,
      })
      setupAgent?.(agentCtx)
    },
    ...(signal !== undefined ? { signal } : {}),
  })

  try {
    handle.agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }),
    )
    await handle.agent.whenIdle()
    // Collect the last assistant text chunk from the session events.
    const assistantText = extractLastAssistantText(handle.agent.session.events)
    return {
      assistantText,
      eventCount: handle.agent.session.events.length,
      toolTrace: handle.agent.session.events
        .filter((event) => event.type === 'tool/call' || event.type === 'tool/result')
        .map((event) => ({ type: event.type, data: event.data ?? null })),
      modelRoute: route,
    }
  } finally {
    await handle.dispose()
  }
}

/**
 * Walk session events to collect the assistant text. DSH session events have
 * shape { type, data }. The assembled assistant message lives in
 * 'assistant/message' events: data.message.content is an array of
 * { type: 'text', text } blocks. We concatenate ALL assistant/message events
 * (a turn may span multiple steps) and return the joined text.
 */
function extractLastAssistantText(events: ReadonlyArray<{ type: string; data?: unknown }>): string {
  type Data = { message?: { content?: Array<{ type: string; text?: string }> } }
  const parts: string[] = []
  for (const ev of events) {
    if (ev.type !== 'assistant/message') continue
    const blocks = (ev.data as Data | undefined)?.message?.content
    if (!Array.isArray(blocks)) continue
    for (const b of blocks) {
      if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
        parts.push(b.text)
      }
    }
  }
  return parts.join('\n')
}
