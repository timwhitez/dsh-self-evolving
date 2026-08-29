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

## ADR-024 — Freeze candidate bytes once and compile only a trusted project

**Decision:** candidate admission captures every declared file through directory-anchored descriptors with
`O_NOFOLLOW`, creates one content-addressed read-only staging tree, and makes identity, schema validation, policy scan,
candidate tests and both compiler passes consume that tree. Candidate `tsconfig.json` must match the inert declared
contract exactly but is never executed. The builder generates the effective config and runs pinned TypeScript inside
Bubblewrap with no network, a cleared environment, read-only source/toolchain mounts and one dedicated writable output
mount.

**Why:** path-based rereads allowed identity, scan and emitted code to observe different live source revisions. Running
`tsc -b` on the candidate project also gave candidate-controlled path options host filesystem privileges before any
post-build check. A single descriptor-captured snapshot removes the attribution race; the outer OS boundary and
builder-owned config remove compiler read/write authority from candidate configuration.

**Compatibility:** historical source, capsule and admission artifacts remain immutable evidence. Future bundle hashes
can differ because the trusted compiler no longer emits candidate-selected incremental metadata; no historical receipt
is relabeled or migrated. Resume continues to verify stored receipts rather than silently rebuilding them under the new
builder.

## ADR-025 — Use delegated cgroup v2 plus bounded tmpfs for local untrusted execution

**Decision:** every local proposer, candidate-test, candidate-build, Loader and packed-overlay process runs in a fresh
child of a delegated cgroup v2 root. The trusted launcher stops before untrusted `exec`, is attached to the child, then
continues under frozen memory/swap, CPU bandwidth, PID and block-I/O controls plus CPU-time, file-size, open-file and
core-dump rlimits. Teardown uses `cgroup.kill` and records controller events and peak usage. A host may use
the default root-owned subtree or provide `DSH_SELF_EVOLVING_CGROUP_ROOT`; absence of all required delegated
controllers fails closed. A non-root launcher must itself start in an executor child beneath that root, so Linux grants
it migration authority between the executor and each sibling resource domain. CI explicitly creates and delegates an
ephemeral subtree, enters the executor through a minimal root launcher, then drops back to the runner UID before any
repository command executes. This avoids a runtime dependency on a user/system D-Bus or `systemd-run` while retaining
a kernel-enforced accounting boundary.

All writable sandbox paths, including `/tmp` and `/dev/shm`, are size/inode-bounded tmpfs mounts created by a trusted
PID-namespace supervisor. The supervisor alone temporarily retains the required private-namespace capabilities. It
starts the target through `setpriv` with an empty capability bounding set and `no_new_privs`; the target never inherits
the export control FD.
For an unprivileged host caller, Bubblewrap maps the trusted supervisor to uid/gid 0 inside its private user namespace
and grants only `CAP_SYS_ADMIN` for bounded mounts, `CAP_SYS_RESOURCE` for the namespace quota and `CAP_SETPCAP` to
clear the target's bounding set; caller-supplied capability options are rejected. The outer root and `/dev` are
read-only, and after mounting the supervisor freezes its private user namespace's nested namespace quota at zero so
the target cannot reacquire mount capability. The target additionally runs below a second private PID namespace, so
it cannot observe or signal the trusted Node supervisor or reach the supervisor's control descriptor even on hosts
whose private user namespace maps only one uid. This PID boundary is a required field in successful resource
receipts. Seed trees enter through a read-only mount, and output is
inspected/exported only after namespace descendants are killed. Resource policies have versioned ids; every receipt
carries the full policy and its digest, and build identity also binds the build policy digests.
Successful stages additionally require a complete supervisor control record, exact frozen policy/mount enforcement,
non-null bounded-storage peaks, zero resource-limit events and `COMPLETED` with exit code 0/no signal. A content digest
alone is not authority. The packed-overlay probe closes its owned ACP input and lets a trusted one-shot wrapper exit
zero so the namespace supervisor can publish that record; `cgroup.kill` is reserved for failure/teardown and can never
be relabeled as success. Admission, stable-build resume and audit all replay the same semantic receipt validator.
Proposal execution persists a separate receipt whose digest is a required top-level materialization field; cached
materializations and the run audit reject a missing, rehashed-failure or policy-drifted receipt.
Worker output is not a completion marker. Worker bytes, the resource receipt, gateway receipts and diagnostics commit
as one fsynced manifest-last execution bundle. A crash before that marker quarantines the exported child and partial
bundle, recreates the declared slot from the immutable parent and reuses durable gateway requests without a second
provider dispatch. Cache/build/audit require an exact wrapper, recompute the stable proposal artifact digest, and read
the canonical materialization and analysis bytes back from the object store. The trusted child exporter fsyncs every
file and the staged directory tree before rename, then fsyncs the parent after moving the original aside, installing
the staged tree and removing the backup. A committed bundle with an absent or mismatched installed worker/tree is
quarantined together and deterministically replayed rather than stranding the action; interrupted random export/backup
directories are moved into that same non-authoritative history. Baseline and generated-candidate staging use durable
ownership claims, remove the claim before publication, and fsync the parent after rename.
The stable proposer applies the same authority rule to its proposal/resource/gateway/idempotency bundle. Its durable
gateway request store lives outside the publication directory; a manifest-less directory is atomically quarantined as
audit residue before retry, so no-clobber evidence paths cannot strand recovery and paid requests still replay.
Before a paid dispatch, the pending request file and its directory are both fsynced, including first-use directory
parents. Completion uses a fully fsynced sibling, atomic rename and directory fsync. The bundle manifest is likewise
fully staged and synced before a no-clobber final hard link, so a crash exposes either no marker or complete bytes,
never a torn authority file. Stable audit reads the committed bundle back and revalidates exact inventory,
proposal/journal/idempotency bindings, gateway receipt shape and full resource-receipt semantics.
Gateway receipt validation binds `routeHash` to the frozen provider/endpoint/model/reasoning/max-token tuple and
requires the exact request-id and transport-attempt schemas, including coherent retry/ambiguity flags and bounded
usage fields; well-formed hashes or arrays alone are not evidence. A shared validator is used by both stable and V011
adoption/audit: every logical request id must terminate in success, only retryable failure receipts may precede it,
and no attempt or receipt may follow a 2xx or non-retryable terminal row. Success cannot carry `error`, failure must,
and a completed proposal cannot be justified by a failure-only matrix.
V011 final audit enumerates every `proposal.completed` materialization and replays its committed execution against the
journal, even when a later build rejection means that proposal never becomes one of the three retained generations.
It first requires a one-to-one inventory between active execution manifests and materializations, so an extra committed
execution cannot hide outside the journal set. Recovery history under `incomplete-executions/` is retained evidence but
is explicitly outside the active authority namespace. One canonical direct-action scanner supplies both inventory and
semantic replay, rejects active symlink/hardlink/special entries, and never traverses quarantine history. Materialization
cache publication uses a fsynced staging inode, no-clobber link and action-directory fsync. Cache parsing/CAS/binding and
installed execution/tree validation happen before adoption; any mismatch quarantines cache, execution and children
together while leaving durable gateway requests in place for deterministic replay. The active cache must remain a
regular single-link inode throughout adoption; a hard-linked cache is never normalized into authority. Quarantine copies
multi-link file bytes into fresh fsynced inodes before removing the active name so an external alias cannot mutate retained
evidence. Failure to inspect or remove the publication staging path is itself a failed publication, not ignorable cleanup.
The publisher holds the action directory and staging descriptors through cleanup, then proves the requested directory
still names the held directory and the final path names the exact stable single-link staged inode with unchanged bytes.
It fsyncs the held directory and repeats those checks before returning; directory replacement or final-name removal is
a failed publication even if an earlier fsync completed.

**Why:** Bubblewrap namespaces, process-group cleanup and wall timeouts limit reach and eventually stop descendants,
but they do not prevent pre-timeout host OOM, PID pressure, CPU starvation or writable-storage exhaustion, nor do they
provide attributable peak/event evidence.

**Compatibility:** historical receipts remain immutable and are not upgraded. New build/capsule identities may differ
because the resource-policy digest is newly bound. Existing run config `codeCommit` freezes the policy implementation;
changing a policy produces a different digest and requires a new execution lineage. Harbor/TB task-container limits
remain the authority for benchmark trials and are not changed by this ADR.

## ADR-026 — Version capsule integrity as a typed evaluated tree

**Decision:** current capsules use manifest schema 2 and checksum format `dsh-capsule-tree-v2`. The checksum set
contains every directory, regular file and symlink. Directory and symlink modes are their evaluated canonical values
(`0755` and `0755`); regular files record `0644` or `0755` according to whether any executable bit is present, matching
the deterministic Harbor tar normalization. File entries hash bytes, symlink entries hash literal target bytes, and
directory entries hash their typed path. Non-UTF-8 checksum text, non-UTF-8/control/Unicode-line-separator names,
hard-linked files/symlinks and special permission bits reject. The exact entry set is checked against the live tree.
Fresh admission and stable-build resume also require v2, bind the verified sums digest, and recompute
`H(capsule.json || SHA256SUMS)`.

**Why:** the predecessor file/symlink list did not represent empty directories or executable mode. Both could change
the evaluated archive and Loader-visible state without changing the planned capsule digest. A private snapshot can
remove packing races but cannot repair an identity that never committed those dimensions.

**Compatibility:** schema-1 manifests remain readable only as explicitly labelled predecessor evidence. They are not
upgraded or accepted as current complete-tree authority. New identities intentionally change and require a fresh
admission/evaluation lineage; historical bytes remain immutable.

## ADR-027 — Isolate evaluation credentials behind one host broker per trial

**Decision:** `gate5-credential-broker-v2` replaces the Gate 5 secret-file launcher. The candidate-facing
`@dsh-self-evolving/llm-responses` bundle is now only a `ProposalGatewayAdapter` for the fixed
`/run/dsh-self-evolving/model.sock` path. Candidate capsules contain no credential launcher; the Harbor registry runs
`dsh-self-evolving-acp` directly. The controller removes credential-shaped variables from the Harbor subprocess,
creates one Harbor job and one durable host broker for every `(task, attempt)`, and mounts only that broker's Unix
socket. Each broker locks the official Responses provider, endpoint, model, reasoning and maximum output, applies
connection/request/byte/deadline bounds, and rejects candidate-supplied transport fields. Its capability socket lives
under a short, host-private `0700` temporary directory; the `0666` socket inode is never placed directly in a
host-traversable `/run` or `/tmp` directory. Transport retry and reasoning continuation are frozen in policy and every
allowed provider attempt is included in the worst-case output reservation. The evaluator's durable per-trial
reservation is converted to integer micro-USD and frozen with conservative context-sized input plus output pricing;
the broker derives its request ceiling from that amount and reserves worst-case USD before each provider dispatch.

The controller copies each development task to a content-addressed overlay, records both tree hashes and forces every
agent phase to `no-network`; a conflicting explicit agent policy rejects before launch. Task setup may still build the
image and download the hash-pinned capsule. A real Harbor adversarial E2E proves that candidate initialization cannot
see `DEEPSEEK_API_KEY` or the retired secret path, cannot complete direct external HTTPS, and can complete the DSH
model call through the mounted Unix socket.

Before launch, run intent schema 2 freezes the ordered per-trial plan, overlay hashes, broker policy and an ephemeral
Ed25519 public key. After each job the host signs trial identity, policy, gateway receipts and usage. Collection
requires the signed broker usage to equal the DSH session usage. Only after every job and broker has terminated, all
signed evidence is durable and an exact credential-byte scan passes may the controller publish
`execution-terminal.json`. An intent without that marker is an ambiguous paid outcome and is never redispatched.
Existing summaries are revalidated against intent, marker, raw trial config/result, broker signature and session
usage before replay. Original and overlay digests plus `no-network` semantics are revalidated both before launch and
after all jobs. The artifact server's TLS private key remains only in the temporary runtime directory and is deleted;
it is never part of persisted run evidence.

The evaluation plan's candidate capsule digest is also an execution authority, not descriptive metadata. A source
candidate must reproduce its planned build capsule digest. A prebuilt V0.1.1 capsule is checked against its complete
live `dsh-capsule-tree-v2`, full schema-2 manifest identity and planned capsule digest, copied into a host-private
one-shot snapshot, checked again on both sides, and packed only from that snapshot. The snapshot is rechecked after
packing. Run intent and the reconstructed summary bind both the planned capsule digest and the resulting Harbor
artifact SHA-256; drift at the
admission path therefore fails closed instead of inheriting the candidate's score identity.

Terminal publication itself consumes the signed evidence and exact DSH session usage, so policy-violation,
incomplete, missing-usage or mismatched-usage trials fail before any marker bytes are created. Collection always
re-executes broker-v2 validation and the raw normalizer, then canonical-compares the complete reconstructed schema-2
summary. A summary file alone, a schema-1 predecessor, or a forged marker can never become external score authority.

**Why:** the retired runner mounted `provider.secret`, exported it as `DEEPSEEK_API_KEY`, and loaded evolving candidate
JavaScript in the same process and network namespace. Read-only file mode and static scanning cannot isolate a secret
from code running as the same user. A host broker removes the reusable credential and unrestricted provider transport
from the untrusted process while retaining real DSH Loader/ACP execution and attributable accounting.

**Trust and compatibility:** the run-local signing key establishes controller-over-candidate evidence authority; it
does not replace the out-of-band signer registry required for formal releases. Historical credential-launcher runs
remain immutable but are security-invalid for this property and cannot be reinterpreted or migrated. They may not
support a current Gate 5 credential-isolation, sealed, official-score or release claim. Revalidation requires a fresh
broker-v2 run ID; the task overlay makes this an engineering protocol unless the official benchmark accepts the same
network semantics.
