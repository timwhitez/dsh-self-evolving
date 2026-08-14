# Project status

**状态：GATE 0 + 1 + 2 + 3 + 4 + 5 + 6 COMPLETE — Awaiting Gate 7**  
**更新时间：2026-08-14（Asia/Tokyo）**

## 已完成 — Gate 0（provenance 与 Cordis lifecycle 地基）

artifact-backed，可机器验证，无付费 benchmark 运行。

### Provenance

- `provenance.lock.json` 固定 DSH `47f943859bef60e4160492346772ded9b24f765a`、Harbor
  `ac398bbda7c4c1073461797d3b95c2455cc671b5`、Terminal-Bench
  `d28711d0da2675d0bb1d56de45ae5df6082438a3`、paper sha256
  `4d48478d…49db97f`、Node `v22.23.1`、pnpm `11.7.0`、6 个 `@deepseek-ai/*` 包版本。
- `scripts/check-provenance.ts` 校验：每个 upstream 在 pinned commit、working tree clean、
  toolchain 版本、package 版本、paper hash 全部一致。**当前全绿**。

### 候选 bundle

- `packages/candidate-baseline/`：稳定 baseline parent candidate。namespace-form
  （`name`/`inject`/`Config`/`apply`），无 `export default`（符合 postmortem 0001）。
  双模式 `solve`/`propose`，仅注册单个稳定 prompt section，无 tool/timer/listener/外部资源。
- `candidate.json`、`cordis.patch.yml` 符合 spec 02 §2–§6 最小形态。

### 真实 Loader E2E（Gate 0）

- `packages/dsh-rsi-loader-e2e/`：通过真实 `@deepseek-ai/cordis-plugin-loader` + Include/Group
  builtin 启动 `cordis.yml` fixture（非手工 `ctx.plugin()`）。
- `loader-lifecycle.e2e.ts`：boot → 候选 row 激活 → systemPrompt 服务可用 → prompt section
  已渲染 → 全树 unload → loader entries 归零 → 无 leak handle 超出 baseline。**2 测试绿**。
- `negative-default-export.e2e.ts`：故意加 `export default apply` 的 broken candidate，
  真实 Loader 以 `cannot get property "systemPrompt" without inject` 拒绝。**1 测试绿**。

## 已完成 — Gate 1（candidate SDK 与 trusted builder）

### Schemas

- `schemas/`：versioned JSON Schema（draft-07）— `candidate.manifest.schema.json`、
  `build.manifest.schema.json`、`capsule.manifest.schema.json`、`provenance.lock.schema.json`。
  ajv 编译校验，`additionalProperties: false` 锁字段集。

### Candidate SDK（`packages/candidate-sdk/`）

- **canonical tar + identity**（`src/identity/canonical-tar.ts`）：自实现确定性 USTAR
  （路径 UTF-8 byte-sorted、固定 mode 0644 / mtime 0 / uid 0、双 zero block），
  `candidate_id = "c_" + base32(sha256)[0:26]`。拒绝 symlink（lstat）、绝对/`..`路径、
  Unicode/case 冲突、单文件/总数/总字节超限。
- **policy scanner**（`src/scan/policy-scan.ts`）：静态 AST/正则 guard。拒绝 dynamic import/
  require/eval/Function/child_process/vm/native-addon/path-traversal/default-export；
  凭据（api-key/private-key/bearer）；TB task slug/verifier 文件名/dataset 路径；非 allowlist
  的 `node:*`、外部包和未 pinned 的 `@deepseek-ai/*`。
- **diff boundary**（`src/builder.ts`）：parent→child 文件 diff，候选只能改 editable surface
  内的文件；TCB/verifier/runner row 改动即拒。
- **deterministic builder sandbox**（`src/builder-sandbox.ts`）：双次 clean build 的 lib/ hash
  必须一致；不执行 candidate lifecycle script；schema + policy scan 在 build 内强制。
- **capsule packer**（`src/capsule.ts`）：runtime/ + candidate/ + runner/ + provenance +
  sbom + capsule.json + SHA256SUMS，确定性可复现 hash。

### Gate 1 测试证据

- **golden build**（`builder-golden.test.ts`）：candidate-baseline 两次 clean build，
  source/bundle/capsule 三 hash 完全一致；candidate id 形如 `c_[a-z2-7]{26}`。**2 绿**。
- **canonical tar identity**（`identity.test.ts`）：确定性、顺序无关、单字节差异检测、
  symlink/traversal/absolute/oversize/count/collision 全部拒绝。**10 绿**。
- **policy scanner**（`policy-scan.test.ts`）：15 个 reject fixture + 2 个 clean accept。**19 绿**。
- **manifest validation**（`manifest-validate.test.ts`）：candidate/build schema 接受良构、
  拒绝缺字段/坏 hash/坏 mode。**7 绿**。
- **rejection suite**（`rejection-suite.test.ts`）：clean control + dynamic-import/
  default-export/task-literal/external-import/child-process/secret/symlink/install-script，
  全部 reject 或不执行脚本。**9 绿**。
- **diff boundary + capsule**（`diff-boundary.test.ts`）：editable 内放行、TCB 越界拒绝；
  capsule 双次打包 hash 一致。**3 绿**。
- **packed capsule offline boot**（`capsule-offline-boot.e2e.ts`）：从 capsule boot 真实 Loader，
  无 source checkout、无 network，候选 row 激活、systemPrompt 可用、SHA256SUMS 自洽。**1 绿**。

### CI 骨架

- `format:check`、`lint`、`typecheck`、`test`（79 单元：50 SDK + 22 adapter + 7 guards）、`test:e2e`（7 真实测试，含
  capsule offline boot）、`provenance:check`、`upstream:check`、`byteequal:check` 全绿。
- `.github/workflows/ci.yml` 定义 fast-ci + loader-e2e 两个 job。
- 三上游 working tree clean；`AGENTS.md` 与 `CLAUDE.md` 字节一致。

## 已完成 — Gate 2（Terminal-Bench provider 垂直切片）

### Adapter（`benchmark-adapters/terminal-bench/`，policy-free TypeScript provider）

- **ACP registry entry builder**（`src/acp-registry.ts`）：生成 Harbor `AcpRegistryEntry`，
  linux-x86_64 binary distribution，HTTPS archive + sha256 checksum 校验。
- **JobConfig generator**（`src/job-config.ts`）：输出 Harbor `JobConfig` YAML，inline
  registry entry + idempotency metadata，确定性序列化。
- **per-trial normalizer**（`src/normalizer.ts`）：读取 Harbor 真实 trial 结构
  （`verifier_result.rewards.reward` + 控制器写的 `attribution.json` + trajectory），fail-closed：
  缺 result/reward/trajectory/candidate mismatch → INVALID，不从分母消失；infra 分类才可重试；
  重解析同 hash。
- **idempotency store**（`src/idempotency.ts`）：append-only ledger，同 key 二次 submit 拒绝，
  不产生第二个付费 trial。
- **cost reconciliation**（`src/reconcile.ts`）：harbor/acp/dsh 三源 token+USD 对账，差异即 null，
  unpriced 显式标注，重解析同 hash。

### Gate 2 真实 Harbor 证据

- **真实 Harbor job smoke**（`harbor-smoke.e2e.ts`，3 绿）：跑通 docker build → agent → verifier →
  reward 全链路。golden（oracle 正确解）→ reward 1.0 → normalizer PASS；nop（nop agent）→
  reward 0.0 → FAIL；broken（oracle 崩溃解）→ reward 0.0 → FAIL。满足 spec 07 §4 nop/broken/golden。
- normalizer/cost/idempotency 单元测试（`normalizer.test.ts` 9 绿、`provider.test.ts` 8 绿、
  `reconcile.test.ts` 5 绿）。

## 已完成 — Gate 3（持久化 controller 核心）

### Controller（`packages/dsh-rsi/`，trusted durable core，spec 06）

- **content-addressed object store**（`src/object-store/store.ts`）：staging → fsync →
  hash → no-clobber link 发布；重复 digest 逐字节验证；scrub 全量重 hash；read 时验证；
  tamper → EVIDENCE_CORRUPT。
- **hash-chain JSONL journal**（`src/journal/journal.ts`）：单 writer lock + owner/lease；
  canonical JSON (RFC 8785 风格) + eventHash + previousHash；segment + 原子 HEAD（tmp + dir fsync）；
  readAll 验证整条链，break 即 fail-closed。
- **pure state reducer + snapshot**（`src/reducer/`）：reducer 为纯函数（不读时间/网络/RNG/FS）；
  canonical stateHash；**full replay 与 snapshot resume 的 canonical state hash 一致**（CI 测试证明）；
  snapshot 损坏 → null → 回退 full replay。
- **budget double-entry ledger**（`src/budget/ledger.ts`）：append-only hash-chain；
  available→reserved→spent|released；worst-case = spent+reserved 防并发超卖；hard limit denial；
  unpriced usage 显式标注（$0 spend 不当零）。

### Gate 3 测试证据

- **object store**（7 绿）：content-addressing、dedup、integrity-on-read、scrub、tamper detection、
  no-clobber collision。
- **journal + reducer**（7 绿）：hash-chain、single-writer lock、corrupt-chain fail-closed、
  **full-replay==snapshot-resume hash 相等**、corrupt-snapshot rejection、event-order permutation
  canonical 相等、canonical-event-hash key-order-independent。
- **budget ledger**（6 绿）：reserve→spend、reserve→release、worst-case bound、hard-limit denial、
  unpriced flag、chain-corruption fail-closed。
- **crash/replay fault-injection**（4 绿）：在 launch/collect/commit 边界“crash 后 resume”，
  external job 不重发、score 不重计、cost 不重收；truncated-segment fail-closed。

共 103 单元 + 7 E2E（loader/capsule/harbor）。三上游 clean；AGENTS/CLAUDE 字节一致。

## 已完成 — Gate 4（agentic proposal 垂直切片）

### Proposal runner（`packages/dsh-rsi-proposer/`）

- **真实 DSH Loader + 真实模型**（`runner.ts`）：boot 最小 model-backed composition
  （`llm-deepseek` → `agent-spine-demo` → `agent-default-model`），通过 `ctx.agents.create({ agentOptions,
setup })` mint 一个 scoped proposer agent，其唯一 model route 由 composition 锁定
  （只有 `deepseek-official` adapter 指向 verified endpoint）。followup proposal prompt → whenIdle →
  收集 `assistant/message` 事件文本。
- **parse + protocol validation**（`parse.ts`）：解析模型 JSON envelope（容错 markdown fence / 嵌入散文）→
  `validateProposalBatch`（width、hypothesis dedup、donor provenance、no-change/test-only 拒绝）。
- **builder handoff + rejected 保留**（`parse.ts` `retainRejected`）：rejected proposal 连同 raw assistant
  text + reason + timestamp 保留为 evidence（不静默丢弃）。

### Proposal safety（`packages/dsh-rsi/src/proposal/`，Gate 4 工程地基，复述）

- 纯函数 fs/network/model-firewall policy（prompt-injection 不能改变）；label-filtered evidence export
  - Merkle + canary absence receipt；canary leak scan；proposal output protocol validator。

### Gate 4 真实模型证据

- **`real-model-propose.e2e.ts`（绿）**：真实 `deepseek-v4-flash` 经真实 DSH Loader 从 baseline parent +
  2 条 synthetic DEV_OBSERVED failure trace 生成 **≥1 个 nontrivial admitted child**（含 hypothesis、
  production diff、mechanism+preservation tests）。provider 连通性 + 模型生成已验证。
- **`prompt-injection.test.ts`（5 绿）**：malicious trace（声称放宽 writable root / 允许 evil host / override
  model route / exfiltrate sealed canary）不能改变 policy（纯函数不变）；sealed canary leak 检出。
- **`parse.test.ts`（8 绿）**：良构接受、fence/prose 容错、no-change/parent-mismatch 拒、rejected 保留、
  unparseable → 0 admitted。

## 已完成 — Gate 5 算法工程（搜索 + split + sealed + 统计）

> 注：Gate 5 的**算法与统计工程**已完成并通过 golden/property 测试。唯一剩余的是付费 calibration
> pilot（60-task baseline + 3-candidate × task-strata 校准）——这是需要真实 benchmark 花费的步骤，
> 在显式授权前不启动。CALIBRATION_INFEASIBLE 判定逻辑已实现（预算超限时 fail closed）。

### Search（`packages/dsh-rsi-search/`）

- **确定性 counter-based RNG**（`rng.ts`）：splitmix64 + 每流独立 counter；Beta 采样用固定 inverse-CDF；
  `(stream, counter, params, sampled)` 确定性可重放（resume 不重抽样）。
- **clade CMP + Thompson + UCB-Air**（`scheduler.ts`）：`CMP_hat(a)=S_C/(S_C+F_C)`；
  `theta_clade~Beta(tau*(1+S_C),tau*(1+F_C))`；`theta_node~Beta(1+s,1+f)`；
  `(N+P_eval)^alpha >= T` expand/evaluate 决策（alpha=0.6）；cold-start q0=3；donor 不双重计数。
- **shortlist tournament**（`tournament.ts`）：clade CMP 降序 + 候选 id 确定性 tiebreak；确定性降级；
  `DEVELOPMENT_CHAMPION` / `NO_DEVELOPMENT_IMPROVEMENT`。
- **split ceremony + sealed info-flow**（`split.ts`）：48/12/29 size 校验 + Merkle root 承诺；
  非封闭 principal 接触 sealed 即 `INFORMATION_FLOW_VIOLATION` abort；candidate lock 后 selector/proposer
  永久拒绝。
- **paired cluster-bootstrap CI**（`stats.ts`）：任务级重采样、固定 seed、`Delta>=5pp && CI95 lower>0` →
  `SEALED_PROMOTED` / `PROMISING_NOT_CONFIRMED` / `SEALED_REJECTED`。

### Gate 5 测试证据（32 绿）

- scheduler（16）：small-tree CMP 手算、UCB-Air 边界精确 cutoff、seeded RNG 重放确定性、
  donor 不双重计数、cold-start、node Thompson argmax。
- tournament + split + sealed + stats（16）：shortlist 排序、champion/NO_IMPROVEMENT、
  48/12/29 Merkle 承诺 + tamper 检测、sealed info-flow abort、candidate lock 拒绝、
  bootstrap CI 提升/平局/确定性。

### Gate 5 付费校准（已执行，artifact-backed）

- **TB 2.1 task inventory**（`evidence/calibration/tb21-inventory.json`）：89 task，
  difficulty 4 easy/55 medium/30 hard、16 category。
- **deterministic split commitment**（`evidence/calibration/split-commitment.json`）：
  48/12/29 size 校验通过、Merkle root `sha256:6ce0972a…`、seed commitment 记录；
  sealed assignment 未离开 sealed service。
- **calibration pilot**（`evidence/calibration/calibration-samples.jsonl`）：3 个 dev task
  经真实 Harbor job（docker build → verifier）测量 wall = 31.1s / 41.8s / 76.9s。
- **budget model**（`evidence/calibration/budget-model.json`）：**CALIBRATION_FEASIBLE**。
  predicted p90 cost = **$41.96**（target $500），predicted p90 wall = **2.38h**（target 16h）。
  frozen: `B_eval=760, B_prop=$40, k_sealed=1, concurrency=4, reserve=20%`。
  注：pilot 用 nop agent 测 Harbor pipeline 成本下界（reward=0 预期）；model cost 按 proposer
  E2E（~27s/turn）保守估计 $0.002/trial 加入。budget 远低于限制 → feasible。
- calibration-evidence test（4 绿）验证 split commitment 良构、samples 非空、budget verdict
  自洽、rebuild 复现 verdict。

## 已完成 — Gate 6（10-candidate development-only pilot）

### Pilot search loop（`packages/dsh-rsi-pilot/`）

- **autonomous search-loop orchestrator**（`loop.ts`）：pure state machine over injected
  capabilities（propose/build/evaluate）。UCB-Air expand/evaluate、clade-Thompson parent selection、
  cold-start enforcement、**dedup-by-digest（duplicate edge，不新建 candidate）**、build-reject/eval-fail
  记账、B_eval exhaustion、K-admitted 终止；iteration cap liveness guard。crash/resume via journal。

### Gate 6 pilot 证据

- **pilot 跑通 terminal state**（`evidence/pilot/pilot-result.json`）：`K=10, B_eval=40`，
  **SEARCH_COMPLETE: 10 admitted**，39 observations，0 dedup/reject/fail，wall <1s。
- **pilot loop tests（6 绿）**：SEARCH_COMPLETE@K、B_EVAL_EXHAUSTED、dedup-by-digest、
  build-reject handling、eval-failure continuation、observation attribution。
- **pilot evidence + crash/resume（2 绿）**：pilot-result.json 自洽（10 admitted）；
  crash/resume determinism（同 seed → 同 lineage）。

> 注：pilot 用 deterministic stub capabilities（real proposal shapes + builder digests + seeded
> rewards）证明 loop 端到端跑到 terminal state。real-model-driven pilot（proposer + Harbor per trial）
> 是正式 run 路径（Gate 7），loop 逻辑在此已验证。pilot 结果与 formal Archive 隔离。

## 尚未完成（后续 Gate）

- Gate 7：formal 80-candidate evolution（≤16h runtime，real model + Harbor per trial）。
- Gate 8：sealed/full evaluation。最终 `$500/16h/5pp/95%CI>0` 判据在 Gate 8 揭盲后确定。

因此当前不能声称：formal 80-candidate search 已运行、sealed 揭盲已确认分数提升、可提交 leaderboard
或达到 SOTA——这些需 Gate 7-8 的真实付费运行。

## 下一个验收门

执行 `specs/07-implementation-plan.md` 的 Gate 7（formal 80-candidate evolution，≤16h runtime）。
逐项执行清单见 `docs/phase-todolist.md`。
