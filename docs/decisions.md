# Architecture decision records

**Status:** accepted for specification v1; changes require a new ADR entry

## ADR-001 — RSI lives inside DSH as a Cordis service

**Decision:** the trusted evolution controller is a standard DSH bundle/service; candidates are standard DSH
bundles/plugins. DSH upstream remains unchanged.

**Why:** DSH already owns dynamic composition, agent loop, services, tools, sessions and reversible lifecycle. An
external meta-controller would duplicate the most important harness mechanisms and evolve a wrapper rather than the
real runtime.

**Rejected:** DSH fork; independent Python evolution controller; candidate as arbitrary shell script.

## ADR-002 — Generated candidates execute in disposable processes

**Decision:** controller never imports or dynamically runs generated code. Proposal, build and task execution use
separate process/container boundaries.

**Why:** Cordis Fiber and `dynamicCordisRunner` provide compositional rollback, but DSH explicitly states its
`node:vm` is not a security boundary and declared services reach the live runtime.

**Cost:** more startup/capsule work. **Benefit:** controller/sealed/verifier secrets remain out of reach.

## ADR-003 — Harbor ACP is the benchmark bridge

**Decision:** build a DSH ACP binary capsule and use Harbor's generic ACP runner with inline, checksummed binary
distribution. The TB adapter remains TypeScript and does not implement a Python BaseAgent.

**Why:** both sides already implement the protocol and lifecycle/trajectory concerns. Reusing them removes a
duplicated command runner and preserves real DSH behavior.

**Fallback:** add a thin local-upload adapter only after a concrete provider cannot serve immutable HTTPS artifacts.

## ADR-004 — One canonical parent, optional donors

**Decision:** each candidate has one canonical parent for the HGM clade tree; other source/evidence inspirations are
donors.

**Why:** a multi-parent DAG makes descendant success double-counting ambiguous. Donor provenance retains
crossover without breaking CMP semantics.

## ADR-005 — HGM search, no greedy acceptance

**Decision:** all admitted candidates remain in Archive; CMP Thompson selects parents, node Thompson selects
measurement targets, and UCB-Air (`alpha=0.6`) decides expansion versus evaluation.

**Why:** immediate benchmark score can be a weak proxy for lineage productivity. Archive search preserves stepping
stones and allocates partial evaluation adaptively.

**Qualification:** formulas are fixed for the run and require TB-specific calibration/ablation; “CMP” is an
estimator, not an oracle.

## ADR-006 — Sealed test is one-time, not per-candidate gating

**Decision:** 48 observed + 12 guard development tasks drive search; 29 tasks remain sealed until exactly one
development champion is content-hash locked.

**Why:** repeatedly using 29 “held-out” outcomes for 80 accept/reject choices adapts to that set. One-time reveal
supports a clearer generalization claim.

**Consequence:** a sealed failure ends the run; testing the runner-up requires a new split/new run.

## ADR-007 — Filesystem event log is the state authority

**Decision:** content-addressed objects plus a hash-chained JSONL journal are authoritative. Snapshots, catalogs and
graphs are derived and rebuildable.

**Why:** files give the proposer rich, scalable evidence using model-native tools and keep every claim auditable.
A database/queue is deferred until measured scaling needs it.

## ADR-008 — Safety and cost are external policy

**Decision:** filesystem/network/process/model/budget/split/verifier policies live in trusted outer layers, never only
in prompts or candidate code.

**Why:** candidates optimize against feedback and may remove or bypass voluntary constraints. Policies must remain
non-evolvable and fail closed.

## ADR-009 — Accuracy is primary; efficiency is constrained/Pareto

**Decision:** maximize paired task performance first. Cost/time/tokens break near-performance ties and enforce hard
budgets; no arbitrary weighted scalar lets cheapness offset a material score regression.

**Why:** the project goal is SOTA capability, while still meeting explicit operational limits.

## ADR-010 — Static SOTA numbers are not product requirements

**Decision:** capture a timestamped official leaderboard snapshot and target comparator in each run manifest.

**Why:** models, harnesses, verification and submission policy change. The prior hard-coded `83.8%` was already a
moving external fact, not an architectural constant.

## ADR-011 — Stable-iteration release precedes benchmark-scale search

**Decision:** v0.1 completion means a usable open-source project that proves stable iteration, not a completed
Terminal-Bench improvement campaign. The default demo keeps `high`, the 1M context window and the 32k per-response
ceiling, and reduces API use only by limiting task trials:

- run baseline failure discovery in deterministic batches up to 12 observed tasks;
- freeze the baseline-failed pool before generating candidates;
- produce K=3 unique candidates across at least two lineage depths and evaluate each on one frozen baseline-failed
  task;
- inject and recover from one real process crash without duplicate effects;
- stop after engineering evidence, regardless of score.

The candidate-specific task is derived only from baseline outcomes and a committed RNG stream. It MUST NOT be
resampled after seeing that candidate's reward. A panel therefore guarantees known baseline failures, not candidate
failures.

**Why:** the reusable product is the iteration engine. Paying for 80 candidates, sealed confirmation and 445 formal
trials before the runner is packaged would test a benchmark campaign rather than open-source usability. The v0.1
solver envelope is at most 15 trials: 12 baseline discovery plus 3 candidate evaluations.

**Claim boundary:** `STABLE_ITERATION_VERIFIED` proves lifecycle/recovery/evidence behavior only. K=10/K=80,
sealed confirmation, full-set and SOTA remain optional post-release profiles with their original strict claims.

## ADR-012 — Baseline INVALID enters the frozen failure pool

**Decision:** stable-demo config schema v2 defines a baseline failure as `status != pass OR reward != 1`. The fixed
batch still completes before every FAIL/INVALID task in that batch is frozen for candidate evaluation.

**Why:** the first real predecessor produced an `INVALID` normalized observation with `reward=null`. The v1 product
engine selected only `reward=0`, contrary to the fail-closed evaluation contract. Run `stable-demo-20260814-v1` was
stopped and marked `QUARANTINED_PROTOCOL_BUG`; it cannot be resumed or used for Gate 6 evidence.

**Consequence:** the successor uses a new run ID and schema. This correction does not change the model route, sealed
boundary, candidate rewards or any benchmark promotion rule.

## ADR-013 — Admitted source diff is the candidate behavior

**Decision:** stable-demo config schema v3 requires the trusted builder to apply the admitted unified diff to the
canonical parent's `src/index.ts`, compile it twice, and atomically publish only a successful candidate. Patch headers
and paths outside that single editable file are rejected.

**Why:** the v2 builder preserved `sourceDiff` as evidence but compiled a prompt section derived only from the
hypothesis. That produced unique artifacts without implementing the proposed mechanism, so it could not prove real
self-modification. Run `stable-demo-20260814-v2` was stopped before candidate generation and marked
`QUARANTINED_BUILDER_SEMANTIC_MISMATCH`; its baseline evidence is not reused.

**Consequence:** incomplete staging directories fail closed, and every successor candidate's source digest covers the
actual model-proposed production patch.

## ADR-014 — Bounded replacement after build rejection

**Decision:** stable-demo config schema v4 allows at most three proposal/build attempts per generation. Every rejected
build records its proposal identity and a content-only error digest; the next attempt receives the same frozen raw
evidence and canonical parent. A successful build ends the generation's replacement loop.

**Why:** v3 could preserve a deterministic compile rejection but resume would request the same proposal forever.
That is auditable but not live. Run `stable-demo-20260814-v3` was stopped during baseline and marked
`QUARANTINED_BUILD_REJECT_LIVENESS_GAP`; no evidence is reused.

**Consequence:** at most nine proposer calls can produce the three admitted children, while the paid solver envelope
remains unchanged at 15 trials. Exhausting three build attempts fails closed and requires a successor.

## ADR-015 — Preserve normalizer status casing exactly

**Decision:** stable-demo config schema v5 accepts only the Terminal-Bench adapter's actual lowercase
`pass|fail|invalid` values and maps them identically into controller observations. Unknown values fail closed instead
of becoming `invalid` through a fallback branch.

**Why:** v4's typed summary declaration incorrectly used uppercase literals. Its first raw result was a real
`status=pass/reward=1`, but the controller fallback recorded `invalid`. Run `stable-demo-20260814-v4` was stopped and
marked `QUARANTINED_NORMALIZER_STATUS_CASE_MISMATCH`; its results are not reused.

**Consequence:** a real one-task adapter smoke must compare raw summary, collected observation and journal projection
before another multi-task successor starts.

## ADR-016 — Outcome-blind low-wall-time observed panel

**Decision:** stable-demo config schema v6 orders only the published `DEV_OBSERVED` inventory by
`agentTimeoutSec ASC, taskId ASC` before taking fixed batches of six. Timeout metadata is frozen before all outcomes;
guard/sealed tasks can never enter the sort input.

**Why:** v5 reached an observed task with a 3600-second allowance while many published observed tasks had 600–900
second limits. Split-file order was deterministic but unnecessarily expensive for an engineering proof. Run
`stable-demo-20260814-v5` was stopped and marked `QUARANTINED_INEFFICIENT_TASK_PANEL`; its results are not reused.

**Consequence:** selection remains outcome-blind and preregistered while reducing worst-case first-batch wall time.
The solver-trial ceiling and model token settings do not change.

## ADR-017 — Bind stable-demo to the full execution commit

**Decision:** stable-demo config schema v7 captures the full Git commit during `init`. `doctor`, `run` and `resume`
require the checkout HEAD to match before any paid or mutating action.

**Why:** v6 demonstrated terminal-raw reconciliation, but its config identified only `repoRoot`; a source edit could
otherwise alter behavior without an identity mismatch. v6 is retained as engineering recovery evidence and is not a
Gate 6 acceptance run.

**Consequence:** the v7 acceptance run starts from a committed clean implementation. No source or documentation commit
is made until its injected crash has resumed and its final audit receipt is written.

## ADR-018 — Canonical equality for idempotent event replay

**Decision:** stable-demo config schema v8 compares an existing event type and payload with the same canonical JSON
function used by the journal hash chain. Object insertion order is never semantic.

**Why:** v7 reached the injected real crash, but resume rejected `run:preflight`: the stored canonical payload had
sorted keys while the in-memory object used source insertion order. No external job was relaunched. v7 is retained as
crash evidence and marked `QUARANTINED_CANONICAL_REPLAY_COMPARISON_BUG`.

**Consequence:** a dedicated mid-run interruption test must resume from a nonterminal journal and prove launch and
collect counts remain exactly once before the next commit-bound real run.

## ADR-019 — Frozen commit plus clean executable source scope

**Decision:** stable-demo config schema v9 requires both the frozen HEAD and a clean executable source scope:
`packages/`, `benchmark-adapters/`, `scripts/` and root build/provenance manifests. Documentation-only work may remain
outside that runtime scope without changing candidate or evaluator behavior.

**Why:** a matching HEAD alone does not exclude dirty TypeScript or scripts being compiled into ignored `lib/` output.
The check is restricted to executable paths so independently authored release documentation does not alter or block a
running evidence lineage.

**Consequence:** `doctor`, `run` and `resume` fail before mutation if tracked or untracked executable source differs
from the bound commit.

## ADR-020 — Feed build rejection classification to replacement attempts

**Decision:** stable-demo config schema v10 adds each prior same-generation proposal/build rejection classification
and journal hash to the next attempt's immutable evidence. Raw compiler/provider text remains outside prompts; only a
fixed safe classification is exported.

**Why:** v9 successfully recovered from SIGKILL, then generation 2 produced three hunks that did not apply. The second
and third proposer calls did not know the earlier failure class, so the bounded replacement loop was blind. v9 is
retained as recovery/build-reject evidence and marked `QUARANTINED_REPLACEMENT_FEEDBACK_GAP`.

**Consequence:** replacement prompts explicitly require byte-exact parent context and receive
`PATCH_DOES_NOT_APPLY` when relevant. Solver-trial selection and frozen task outcomes remain unchanged.

## ADR-021 — v0.1.1 uses canonical child trees and governed capability catalogs

**Decision:** protocol `dsh-self-evolving-candidate-tree-v2` replaces model-authored unified patches with a trusted,
preassigned full child tree. The proposer may add, modify, or remove only `src/**/*.ts`,
`tests/**/*.spec.ts`, `fixtures/**/*.json`, `README.md`, and the behavior-intent JSON pointers in
`candidate.json`. `package.json`, `cordis.patch.yml`, compiler configuration, identities, dependencies,
model routing, evidence labels, budgets, and evaluation policy remain builder-owned. The trusted host derives
the actual operation set, resolves structured citations against one immutable export, and mints a single
materialization/admission chain. Exact DSH capabilities are frozen in a content-addressed catalog; proposer
capability requests are data-only and cannot alter the current lineage.

The exact selected parent capsule is loaded in `propose` mode through the real Cordis Loader. Generated
children are admitted only after candidate-owned tests in a bounded process, policy and import scanning, two
byte-identical builds, Loader boot/unload in both modes, fixed replay, and offline capsule verification. A
trusted mechanism-outcome record is derived exactly once from normalized `DEV_OBSERVED` trials and may enter a
later generation only through a new legal export.

**Why:** v0.1 proved crash-resumable iteration but its one-file patch, baseline-importing proposal worker,
summary-style evidence input, and scattered build receipts cannot establish autonomous multi-file plugin
development or cumulative trajectory-grounded iteration.

**Migration:** v0.1 artifacts remain byte-identical historical evidence. v0.1.1 starts from an explicit
migration receipt, new schemas, a new protocol identity, new evidence exports, a fresh task freeze, and a new
run lineage. No v0.1 score, failure pool, proposal output, or capability decision is relabeled as v0.1.1.

**Claim boundary:** all V011-A through V011-E receipts are required before
`AUTONOMOUS_PLUGIN_DEVELOPMENT_VERIFIED`. Green schemas, one generated child, or a K=3 terminal state alone are
insufficient. The capability is development-only, requires `sealedAccessCount=0`, and makes no benchmark
improvement claim.

## ADR-022 — Formal signer registry is an out-of-band TCB input

**Decision:** formal preflight evidence carries only the detached signature. A trusted caller supplies an external
`signatureKeyId -> Ed25519 public-key PEM` registry to the verifier. Unknown ids fail closed; for a registered entry
the verifier independently enforces Ed25519 and derives the SPKI SHA-256 id from the PEM before checking the
signature. Manifest, evidence, candidate output and run-local files cannot add or replace registry entries.

**Why:** accepting a PEM from the same evidence object made a self-generated key, signature and evidence commitment
internally consistent but untrusted. The signature proved authorship by an arbitrary key rather than authorization by
the TCB.

**Compatibility:** there is no production caller, deployed registry, formal run directory, signed formal manifest or
accepted formal receipt to migrate. This closes the trust boundary already specified and documented; the signed
manifest wire schema and evidence commitment are unchanged, so no protocol version is reinterpreted. After the first
deployed registry/run, changing registry authority or signer-selection semantics requires the ADR and protocol-version
change mandated by spec 07.

## ADR-023 — Disable synthetic Gate 8 acceptance until authentic artifacts exist

**Decision:** the public `verifyGate8Evidence` boundary always returns `PROTOCOL_INVALID`. The existing paired-matrix,
bootstrap, full-set and release logic is retained only as an internal synthetic consistency assessor and is not
exported from the package root. Enabling acceptance requires a new versioned design with real receipt producers,
trusted content-addressed artifact reads, external signature authority, journal/action replay and immutable launch
manifest reconstruction.

**Why:** an envelope commitment proves only that one caller kept its own strings and booleans consistent. It does not
prove that a search receipt, signed lock, reveal, trial artifact, journal, official verification or release operation
exists. Keeping a positive public path before those producers exist would turn test fixtures into false attestations.

**Compatibility:** Gate 8 is optional and `BLOCKED_NOT_STARTED`; there is no production caller, formal candidate lock,
reveal, sealed/full trial, release artifact or accepted Gate 8 receipt. Removing the unauthenticated positive path
therefore invalidates no evidence. The future authentic design must use a new schema/protocol identity rather than
reinterpret the synthetic envelope.
