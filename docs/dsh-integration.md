# DeepSeek Harness integration guide

**Purpose:** implementation-facing API map, not a duplicate “complete API reference”  
**Verified snapshot:** DeepSeek Harness `47f943859bef60e4160492346772ded9b24f765a`

DSH generates catalogs and subsystem surfaces from source. This project must import the fixed package types and
check the matching source at implementation time; maintaining a hand-copied event/API list here would drift.

## 1. Sources of truth

Use these in order:

1. [`docs/user/develop`](../deepseek-harness/docs/user/develop/) for plugin authoring conventions.
2. Generated [`docs/subsystems`](../deepseek-harness/docs/subsystems/) for current Cordis event signatures/modes.
3. Package README + exported TypeScript interface for the exact capability.
4. Package tests for loader/export, disposal, scoping and error behavior.
5. `/root/paper.pdf` for the theory/rationale, not concrete current API names.

Any DSH upgrade regenerates the compatibility fixture and starts a new experiment lineage.

## 2. Plugin and Loader form

For candidate and controller packages, prefer namespace-form exports:

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'example'
export const inject = ['tools']

export interface Config {
  mode: 'solve' | 'propose'
}

export const Config: Schema<Config> = Schema.object({
  mode: Schema.union(['solve', 'propose']).required(),
})

export function apply(ctx: Context, config: Config): void {
  // Register effects through ctx.
}
```

Do not add `export default apply` beside named `name`/`inject`/`Config`. The real Loader normalizes to
`exports.default ?? exports`; a bare default function loses sibling metadata. DSH documents this failure in
[`postmortem/0001`](../deepseek-harness/docs/postmortem/0001-acp-default-export-drops-inject.md). A test that
manually constructs `ctx.plugin({ name, inject, apply })` cannot cover that path, so every package needs a real
Loader E2E through `cordis.yml` or a bundle patch.

## 3. Bundle, profile, and patch layers

- A distributable plugin package declares `dsh.bundle.patch` in `package.json`.
- A profile declares ordered bundles and is deployment state; a candidate is never a profile.
- Layer order is bundle patches, profile patch, home patch, then CLI `--patch` overlays.
- A later patch replaces a row's entire `config`; it does not deep-merge fields.
- A patch's local module path resolution is not changed by where the CLI was launched; use a package name for
  installed bundles and contract-test the dumped config.

The project builder creates candidate bundle identity and final patch. Proposer output cannot override runner rows
or rely on machine home patches. See DSH's
[`publish guide`](../deepseek-harness/docs/user/develop/basic/publish.md).

## 4. Lifecycle and effects

`ctx.plugin()` creates a child Fiber with an independent lifecycle. Registrations made through Cordis-aware APIs
(events, tools, timers) are effects and unwind when the owner Fiber unloads. External resources must be explicit:

```ts
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const resource = openResource()
    return () => resource.close()
  })
}
```

Required services belong in `inject`; the plugin waits until all exist and disposes/reloads if a required provider
disappears. Optional services are queried at use time with `ctx.get()`. A service package normally extends Cordis
`Service` and declares its context type through module augmentation.

RSI acceptance tests must observe quiescence, not merely invoke a disposer. Compare tool/service/listener/timer/open-
handle inventory before load and after disposal. Candidate code must not detach unowned promises, process handlers
or raw timers.

## 5. Agent creation and scoping

Current public creation seam is `ctx.agents.create(options)`, returning an `AgentHandle`. The caller supplies a
`SessionId`, optional session metadata, fixed `AgentOptions`, and an unpublished setup callback:

```ts
const handle = await ctx.agents.create({
  sessionId,
  meta: { cwd },
  agentOptions: { provider, model, maxTokens },
  setup(agentCtx) {
    // Mount candidate behavior in the exact agent scope before publication.
    agentCtx.systemPrompt.section({
      name: 'candidate:policy',
      order: 100,
      text: '...',
    })
  },
})

handle.agent.followup(userMessage)
await handle.agent.whenIdle()
await handle.dispose()
```

The exact message constructor and model-selection setup must be imported from the fixed DSH packages, following
[`dsh-headless`](../deepseek-harness/packages/bundle/headless/src/index.ts) rather than reimplemented. `setup`
composes an unpublished scoped world; it must not drive the agent. The returned handle is the teardown capability;
a bare registry lookup cannot safely dispose another owner’s agent.

This is the correct seam for a proposer runner. The TB task runner uses DSH's existing ACP bridge, which internally
drives the same agent registry rather than introducing a second loop.

## 6. Events

Cordis event modes have different contracts:

- `emit`: synchronous broadcast; return values ignored.
- `bail`: first non-null/non-false/non-undefined result wins.
- `serial`: ordered/awaited, stops at first meaningful result.
- `waterfall`: cooperative chain; a listener must call `next()` unless it intentionally intercepts.

Do not infer event mode from its name. Import types and consult generated subsystem docs.

DSH Cordis events include `agent/step`, `agent/request`, `agent/request-error`, `tools/result` and
`session/event`. Durable `turn/*`, `step/*`, `tool/call`, `tool/result` and `compaction/*` are **session event
types**, not same-named Cordis events. Observe them by listening to `session/event` and inspecting `event.type`.

Candidate middleware must preserve request/tool protocol invariants. In particular, a waterfall listener that
forgets `next()` can silently replace downstream behavior and needs negative tests.

## 7. Prompt and tools

Prompt contributions use `ctx.systemPrompt.section({ name, order, text })`; candidate section names are prefixed
`candidate:`. Stable sections should remain stable across turns to preserve KV prefix reuse. Dynamic facts belong
in the existing runtime-context mechanisms, not repeated ad hoc prose.

Tools use `defineTool()` from `@deepseek-ai/dsh-tools` and `ctx.tools.register(...)`. Tool schema, canonical return
value and model-facing rendering are distinct. Candidate tests must validate:

- schema and unique name;
- actual execution/result type;
- rendering and output-size policy;
- abort/timeout/cooperative behavior;
- unload removal;
- native/Code Mode presentation if both are supported.

Tool policy belongs at the registry/execution seam, not only in prompt text.

## 8. Managed subprocesses

The trusted controller should use injected `ctx.subprocess`, not raw Node `child_process`. Its spawn spec has no
hidden defaults: explicit `argv`, `cwd`, stdin/stdout/stderr mode, grace, signal and environment. `argv` is never
shell-interpreted. A handle exposes `done`, collected/raw streams, tree-scoped `terminate()` and
`waitForExit()`; service disposal terminates managed processes and awaits exit.

The process provider scrubs ambient credential-shaped and `DSH_*` variables unless the caller explicitly adds
them. RSI callers should pass a minimal environment and never forward all `process.env`.

Candidate plugin code is not allowed this service. The task-solving model reaches externally governed bash/fs
tools; that traffic stays in the audited DSH tool pipeline.

## 9. ACP integration

[`@deepseek-ai/dsh-acp`](../deepseek-harness/packages/acp/acp/README.md) is an automation-only JSON-RPC stdio
transport over `ctx.agents`. It supports fresh sessions, text prompts, committed assistant chunks, one-shot
permissions and cancellation. Stdout is protocol-only; tool/reasoning detail remains in the DSH session log.

The project should build a small production ACP composition from the package, stable agent spine, model adapter,
sandbox/tool providers and candidate row. The feature-rich `examples/acp-agent` is a reference, not the baseline.

Harbor's generic ACP client already produces `acp.txt`, `acp-events.jsonl`, `acp-summary.json` and ATIF
`trajectory.json`. The TB provider uses its inline binary distribution with SHA-256 instead of implementing a new
Python `BaseAgent`.

## 10. Dynamic Cordis runner

`ctx.dynamicCordisRunner` owns in-memory definitions, `node:vm` evaluation and Fiber lifecycle for model-mounted
dynamic packages. Its own README states that the vm isolates globals but **is not a security boundary**: declared
services reach the live runtime, async work can escape the synchronous VM timeout, and definitions are process-local.

Therefore it is not the evaluator for generated candidates. It remains useful for trusted preview and lifecycle
experiments only. Production proposal/build/task execution uses disposable process/container boundaries.

## 11. Compatibility tests to pin

Every supported DSH commit needs these probes:

1. namespace plugin loads with `name`/`inject`/`Config`; default-export negative fails;
2. bundle/profile/patch produces the expected dumped config and candidate row;
3. required service disappearance disposes/reloads dependent Fiber;
4. candidate prompt/tool/event is agent-scoped and removed on handle/Fiber disposal;
5. ACP initialize/new/prompt/cancel/disconnect leaves no agent/process;
6. managed subprocess abort cleans the process tree;
7. packed offline artifact loads without source workspace;
8. session/ACP/ATIF records reconcile under replay LLM.

Only after these pass may a DSH upgrade enter benchmark calibration.
