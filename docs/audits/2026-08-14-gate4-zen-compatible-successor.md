# Gate 4 Zen compatible successor — 2026-08-14

**Status:** `GATE_4_ACCEPTED`
**Requested/effective model:** `deepseek-v4-flash-zen` / `deepseek-v4-flash`
**Route:** OpenAI-compatible Chat Completions, `high`, 1,048,576-token context, 32,768
output tokens per turn
**Credential handling:** root-only external Codex auth store; never printed or persisted in repo

## Root cause

The first Responses route was not failing because the 1m context window was too small. The local
model catalog gives the model a 1,048,576-token context but a separate 10,000-token output
truncation policy. Responses defines `max_output_tokens` as the combined budget for hidden
reasoning and visible output.

Two failed real requests consumed exactly 10,000 output tokens and returned only a `reasoning`
item. A read-only inspection of the deployed CPA 7.2.131 host then established the protocol defect:

- Zen is configured as an OpenAI-compatible Chat Completions upstream; the client alias
  `deepseek-v4-flash-zen` maps to upstream `deepseek-v4-flash`.
- CPA maps Responses `max_output_tokens` to Chat Completions `max_tokens`.
- Its Chat-to-Responses streaming translator treats every non-empty upstream `finish_reason` as
  completion pending. At `[DONE]` it always synthesizes `response.completed`; it does not map
  `finish_reason=length` to `response.incomplete`.

That explains the observed `status=completed`, `output_tokens=10000`, reasoning-only envelope. The
remote CPA source, config, binary, and service were not modified. Its source checkout already had
unrelated uncommitted work, which was left untouched.

## Project-local fix

`TrustedChatCompletionsAdapter` now calls CPA's compatible `/chat/completions` endpoint directly.
It preserves the requested Zen alias, validates the effective Flash identity, freezes `high`, keeps
the 1m context metadata, and observes native `finish_reason` instead of CPA's synthesized Responses
status. It rejects route/tool overrides, keeps the credential in the trusted host, aggregates usage,
and never emits `reasoning_content` into the DSH transcript.

The accepted route uses a 32,768-token single-turn output budget. The real accepted run did not use
reasoning continuation (`reasoningContinuationMaxTurns=0`): it completed in one upstream turn and
therefore is not a retry-selected success.

## Acceptance evidence

Command: `pnpm test:gate4:codex-provider`

- real DSH agent-spine + baseline propose candidate executed inside the same Bubblewrap sandbox;
- sandbox had no IP network and no credential;
- trusted fixed Unix gateway produced one content-free receipt;
- requested model was Zen and provider effective model was Flash;
- one nontrivial proposal passed the existing protocol and was admitted;
- event count: 16; admitted candidates: 1;
- usage: 1 uncached input token, 1,254 cached input tokens, 25,560 output tokens;
- duration: 223.2 seconds;
- persisted receipt: `evidence/gate4/zen-1m-successor-receipt.json`;
- receipt file SHA-256:
  `e1e3165022a6a6a3ce067b72eec3b237f3110f8ed0ac731d4af789d1bc05a832`.

Provider price was not independently frozen, so `costUsd` remains `null`; token usage is retained.
This is Gate 4 proposal-path acceptance only. It is not a model-quality, benchmark-performance,
promotion, formal-search, sealed, deployment, or release claim.
