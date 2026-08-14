# Terminal-Bench 2.1 / Harbor runbook

**Status:** implementation guide; normative policy lives in `specs/04` and `specs/05`  
**Verified against:** Harbor `ac398bb...`, TB 2.1 repo `7131e43...`

## 1. Fixed facts

- Terminal-Bench 2.1 has 89 task directories in the verified source snapshot.
- Official source instructions use Harbor dataset `terminal-bench/terminal-bench-2-1`.
- The checked official config pins dataset digest
  `sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a`.
- Leaderboard protocol requires at least 5 attempts per task; community submission was closed at the design
  snapshot, with maintainer-run rows only.
- Harbor's generic `acp` agent supports inline registry entries and a binary distribution with HTTPS archive,
  platform target, command/args/env, and optional SHA-256 checksum.
- DSH ships an automation-only ACP JSON-RPC stdio server over its real agent registry/loop.
- TB 2.1 task TOMLs omit verifier `environment_mode`, so Harbor resolves them to `shared` by default. Harbor can
  run `separate`, but changing mode requires compatibility validation against task artifact semantics.

## 2. Integration path

The preferred route contains no project-owned Python agent:

```text
TypeScript TB provider
  -> Harbor job YAML/SDK payload
  -> agent.name = acp
  -> agent.kwargs.registry_entry = inline JSON
  -> binary archive = immutable DSH candidate capsule URL
  -> checksum = capsule SHA-256
  -> Harbor generic ACP install/client
  -> DSH ACP stdio server
  -> real DSH candidate plugin
```

An inline record conceptually has this shape (exact serialization is generated and contract-tested):

```json
{
  "id": "dsh-rsi-acp-<candidate-short-hash>",
  "name": "dsh-RSI candidate",
  "version": "<full-capsule-hash>",
  "description": "Immutable DSH candidate capsule",
  "distribution": {
    "binary": {
      "linux-x86_64": {
        "archive": "https://artifact-host/sha256/<digest>.tar.gz",
        "cmd": "./dsh-rsi-acp",
        "checksum": "sha256:<digest>"
      }
    }
  }
}
```

Harbor installs the selected binary under a fixed directory, launches it with the task workspace as `cwd`, and
constructs the executable path from the basename of `cmd`. The capsule therefore puts an executable wrapper named
`dsh-rsi-acp` at the archive root. That wrapper resolves its own real directory and executes the embedded DSH bin
with an absolute `--config "$capsule_root/runner/cordis.yml"`; it never resolves config relative to `cwd`. Gate 2
must prove this path in a real task container—nested `cmd` paths or `args: ["--config", "./cordis.yml"]` are wrong.

## 3. DSH ACP capsule requirements

The executable must:

- be self-contained for the task platform or include an offline, verified runtime closure;
- boot the stable DSH runner composition plus exactly one candidate patch;
- reserve stdout exclusively for ACP JSON-RPC; diagnostics go to stderr/files;
- accept `initialize`, `session/new`, `session/prompt`, permission response, cancel and disconnect;
- use the task's absolute ACP `cwd` for agent workspace/sandbox policy;
- write DSH session evidence to a trial-local path retrievable through Harbor agent logs;
- terminate all children and flush persistence on ACP disconnect/process termination;
- never load `.env` or ambient config from task workspace;
- verify embedded `provenance.json` and candidate hash before opening ACP.

Do not copy `examples/acp-agent/cordis.yml` wholesale. It is a feature-rich demo (subagents, workflows, hooks,
session query, etc.) and would blur the baseline. Compose only the pre-registered stable runner plus candidate-
controlled surfaces.

## 4. Job generation

The provider should write a complete immutable YAML/JSON config per evaluation rather than concatenate CLI
strings. Minimum fields:

```yaml
job_name: <run-wave-eval-id>
n_concurrent_trials: <frozen-cap>
n_attempts: 1 # search allocation creates exact planned attempts
quiet: true
retry:
  max_retries: <infra-policy> # Harbor retries still normalized under project rules
environment:
  type: <frozen-provider>
agents:
  - name: acp
    model_name: <frozen-provider/model>
    kwargs:
      registry_entry: <inline-record>
      distribution_preference: [binary]
      permission_mode: allow
      auth_policy: disabled
datasets:
  - name: terminal-bench/terminal-bench-2-1
    ref: sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a
```

Exact task selection must use Harbor's supported dataset/task selectors at the pinned version. Gate 2 must dump
the resolved trial inventory before launch and compare it to the action intent.

Never interpolate a secret into persisted config. Use Harbor env templating/provider secret injection; archive a
redacted config plus a non-sensitive equality/fingerprint receipt.

## 5. Bring-up ladder

1. **Keyless ACP:** fresh container boots capsule and completes ACP initialize/new/cancel using replay LLM.
2. **Nop/broken result:** `extract-elf` produces a planned FAIL and complete artifacts.
3. **Real one-task smoke:** baseline DSH candidate on `extract-elf`, one attempt, fixed model.
4. **Three-task strata:** one short, one network/resource-heavy, one long task; validate timeout and cleanup.
5. **Development subset:** baseline/calibration only after result reconciliation is exact.
6. **Full 89×5:** only a sealed-promoted, locked artifact.

Each rung stops on identity mismatch, missing evidence, cost uncertainty or process survivor.

## 6. Result directory contract

Harbor may evolve filenames, so the normalizer is versioned and tested against the pinned source. For each
planned trial it should retain or reference at least:

```text
<job>/<trial>/config.json
<job>/<trial>/result.json
<job>/<trial>/agent/acp.txt
<job>/<trial>/agent/acp-events.jsonl
<job>/<trial>/agent/acp-summary.json
<job>/<trial>/agent/trajectory.json
<job>/<trial>/verifier/test-stdout.txt
<job>/<trial>/verifier/test-stderr.txt
```

DSH-specific session/provenance files must be included through Harbor's agent log include rules. The top-level
job result is not authoritative because it can be incomplete/stale during execution; enumerate planned trial
directories and read per-trial results.

## 7. Normalization algorithm

For every planned tuple, in manifest order:

1. locate exact trial by persisted config identity, not fuzzy directory name;
2. validate candidate/capsule/model/task/protocol hashes;
3. parse per-trial result and select the preflight-frozen primary reward key;
4. map reward=1 to pass; all other terminal/missing states to fail unless reward-blind infra classification applies;
5. reconcile ACP final state, ATIF metrics, DSH events, model gateway usage, timing and process cleanup;
6. write one canonical normalized JSONL row even for missing/corrupt trials;
7. hash the complete planned inventory and normalized output.

Never count only completed directories or `verifier_result != null`; that creates survivor bias.

## 8. Verifier-mode probe

Official tasks currently resolve to shared mode. Before considering a separate-mode override:

1. list task-declared artifacts and runtime sidecar state needs;
2. run oracle/baseline in official shared mode and candidate-independent separate mode;
3. verify the same verifier source/hash, task resources, network and primary reward semantics;
4. compare artifacts and outcomes across repeated runs;
5. record per-task compatibility, not a blanket assertion.

Use separate mode only for the experiment track if all 89 tasks pass this compatibility gate or report the exact
exception set. A score from a modified verifier protocol cannot be submitted as official without maintainer
acceptance.

## 9. Official full run

At the pinned source snapshot the official example is conceptually:

```sh
harbor run \
  -d terminal-bench/terminal-bench-2-1 \
  -a acp \
  -m <provider/model> \
  -e <sandbox> \
  -k 5 \
  -n <concurrency> \
  --upload \
  --public
```

The project should invoke Harbor through a persisted generated config, not this abbreviated command, so inline
registry entry, checksum, exact model kwargs, dataset digest, log inclusion and resource policy are visible.

Official submission status must be checked at run time. A local/public Harbor job is not an official leaderboard
row until maintainers validate it.

## 10. Operational diagnostics

When a trial fails, inspect in this order:

1. planned identity versus persisted config;
2. environment provisioning and capsule checksum/install;
3. ACP protocol events/summary and DSH stderr/session log;
4. agent timeout/process cleanup;
5. verifier phase and reward file;
6. gateway usage/cost receipt;
7. normalizer classification.

Do not rerun first. Preserve the job, classify from reward-blind phase facts, then either count FAIL or retry under
the frozen infrastructure policy.
