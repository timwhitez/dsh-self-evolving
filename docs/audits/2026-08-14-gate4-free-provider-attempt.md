# Gate 4 free-provider successor attempt — 2026-08-14

**Status:** `PROVIDER_RATE_LIMITED_NOT_ACCEPTED`
**Provider/model:** `deepseek` / `deepseek-v4-flash-free`
**Context window:** 200,000 tokens
**Credential handling:** root-only external Codex auth store; never printed or persisted in repo

## What passed

- The authorized Codex provider configuration resolved to the existing HTTPS Responses endpoint.
- Two minimal strict-TLS Responses requests returned HTTP 200, echoed the exact requested model, and
  returned the requested sentinel text.
- A trusted-host Responses adapter now locks provider, endpoint, exact model, high reasoning,
  output cap, and 200k context metadata. It rejects route overrides and model tool calls.
- The adapter resolves the credential from a named host environment variable per request. The
  Bubblewrap proposer process still receives an empty environment and no IP network; it can reach
  only the mode-0600 Unix gateway.
- The host adapter implements the configured maximum of 12 bounded retries for 408/429/5xx and
  honors bounded `Retry-After` values. Unit tests cover retry, usage accounting, route lock, tool
  rejection, and missing credentials.

## What did not pass

The full real DSH agent-spine + baseline propose candidate + Bubblewrap + Unix gateway topology
reached the trusted provider handler, but all 12 attempts ended at HTTP 429. Minimal size probes
reported `model_cooldown` at larger output caps and `FreeUsageLimitError` at 512 tokens. No assistant
message or admitted child was produced, so Gate 4 remains `GATE_4_ACCEPTANCE_FAILED`.

This is a provider availability/quota result, not a candidate or model-quality result. Retrying
after the free-model cooldown is the only valid successor; substituting another model would violate
the user's frozen route.
