# Project status

**当前权威状态：`GATE_0_ACCEPTED`; `GATE_1_ACCEPTED`; `GATE_2_ACCEPTED`; `GATE_3_ACCEPTED`; `GATE_4_ACCEPTED`; `GATE_5_NOT_ACCEPTED`; `GATE_6_NOT_ACCEPTED`; `GATE_7_BLOCKED_NOT_STARTED`; `GATE_8_BLOCKED_NOT_STARTED`**
**更新时间：2026-08-14（Asia/Tokyo）**

最终 gate/commit/identity/test/blocker 对账见
[`docs/audits/2026-08-14-final-disposition.md`](docs/audits/2026-08-14-final-disposition.md)。

## Gate 3 successor（已验收）

`@dsh-rsi/core` 现为标准 DSH/Cordis bundle，只暴露生命周期归属的 `ctx.rsi` service；journal
与 budget 写入原子、fsync、并发串行且 receipt-idempotent。真实 provider saga 按 intent → inspect/
launch → collect → cost settle/release → commit 恢复。4 个独立 Node controller 分别在四个边界后
遭真实 `SIGKILL`，successor 均只产生一次 launch/score/cost，并保留 stale-lock 证据。只读 status
command、unload quiescence 和生成式 replay property tests 同时通过。

完整证据见
[`docs/audits/2026-08-14-gate3-successor.md`](docs/audits/2026-08-14-gate3-successor.md)。

### Gate 4 Zen compatible successor（已验收）

已完成 DEV-only archive catalog 非干扰、immutable label binding、action-scoped read-only raw
export，以及 Bubblewrap 外层 proposal process sandbox（只读 inputs、唯一 child write root、空环境、
无 network、PID namespace timeout drain、symlink 拒绝）。

固定 route 的 Unix-socket gateway 与 DSH `LlmAdapter` 已实现：sandbox 保持无 IP network/无
credential，可信宿主 handler 锁 provider/endpoint/model/reasoning/maxTokens，拒绝 headers 等额外
transport 字段，并按 request hash 幂等返回、记录 content-free receipt。

真实 successor 已按用户授权从 root-only Codex auth store 注入 credential，并冻结 requested
`deepseek-v4-flash-zen`、effective `deepseek-v4-flash`、`high`、1,048,576 context。远端只读审计确认
CPA 的 Responses 合成层把 Chat `finish_reason=length` 错标为 completed；CPA 未修改。项目改走
compatible `/chat/completions`，以单轮 32,768 output budget 在同一 Bubblewrap + fixed gateway 拓扑
生成 1 个 admitted child；sandbox 仍无 IP network、无 credential。content-free receipt 保存用量与
请求/响应/route hash，不保存 reasoning 或模型正文。Gate 4 因而为 `GATE_4_ACCEPTED`。详见
[`docs/audits/2026-08-14-gate4-zen-compatible-successor.md`](docs/audits/2026-08-14-gate4-zen-compatible-successor.md)。

旧 free route 的 429 失败审计继续保留为 predecessor，不被本次 successor 改写。

## Gate 5/6 历史证据隔离

现有 calibration 只有 3 个 `nop` Harbor trial，不是 60 tasks × ≥2 attempts 的 real baseline，
也没有 real 3-candidate × task-strata；现有 `pilot-001` 使用 stub capabilities 与 `Math.random`，
不是正式路径。两组原 artifact 均保留，并通过各自 `STATUS.json` 标记
`QUARANTINED_NOT_ACCEPTED`。新增 Gate 5/6 fail-closed verifier；完整审计见
[`docs/audits/2026-08-14-gate5-gate6-evidence-audit.md`](docs/audits/2026-08-14-gate5-gate6-evidence-audit.md)。

Gate 5 sealed-service 工程 preflight 已新增独立 worker process、`0700/0600` private state、
non-replacing public receipts、非公开 256-bit seed、48/12/29 controller view、split-bound candidate
lock 与 lock 后永久拒绝。synthetic E2E 证明非服务 UID 无法读取 private state，且协议没有
dump/reveal 操作。该验证未部署正式 service account/volume、未 mint 正式 split，故只标记
`ENGINEERING_PREFLIGHT_PASSED`，Gate 5 仍未验收。证据见
[`docs/audits/2026-08-14-gate5-sealed-service-preflight.md`](docs/audits/2026-08-14-gate5-sealed-service-preflight.md)。

Gate 5 sealed deployment successor 已通过窄 runtime exports 去除生产闭包中的 core/Cordis，部署为
root-owned immutable `/opt` release，并以独立 `dsh-rsi-sealed` UID 和 mode-0700 `/var/lib` store
完成 restart、权限、并发锁、tamper/no-replace smoke。新的 TB 2.1 concealed 48/12/29 split 已 mint，
controller 只获得 observed IDs、guard handles 与 Merkle root，seed/assignment 未暴露且 sealed access
仍为 0。Gate 5 仍因缺少真实 60x2 baseline、三候选分层 calibration 与冻结预算而未验收。详见
[`docs/audits/2026-08-14-gate5-sealed-deployment-successor.md`](docs/audits/2026-08-14-gate5-sealed-deployment-successor.md)。

Gate 5 real one-task smoke 的 v1/v2 分别在 TB layout 与 Loader config 阶段失败且未调用 provider；v3
到达真实 Zen-compatible ACP 路径，但发现 Harbor 会把敏感 `agent.env` 展开到宿主 Docker CLI 参数，
因此立即停止 trial/container 并永久标记 `ABORTED_CREDENTIAL_EXPOSURE`。持久化 run root 的 credential
byte scan 为 0；successor 已改为容器内只读 secret-file launcher，并在 provider 层永久拒绝敏感
`agentEnv`。暴露的 CPA client key 尚未轮换，轮换前禁止新的真实 provider 调用。详见
[`docs/audits/2026-08-14-gate5-real-smoke-security-incident.md`](docs/audits/2026-08-14-gate5-real-smoke-security-incident.md)。

用户随后明确授权继续使用原 CPA key。`gate5-real-smoke-v5` 通过容器内只读 secret-file、固定
DSH sandbox/subprocess/bash 工具栈和真实 Zen-compatible Chat Completions，在 DEV_OBSERVED `fix-git`
完成 12 次 bash 调用并获 reward 1；宿主 argv/env 与持久化 byte scan 的 credential 匹配均为 0。
DSH session 保留 10 个 usage events，但 CPA/Harbor 未提供 USD price，因此仍是 `priced=false` 的单题
工程 smoke，不能用于 Gate 5 acceptance。详见
[`docs/audits/2026-08-14-gate5-real-smoke-successor.md`](docs/audits/2026-08-14-gate5-real-smoke-successor.md)。

## Gate 7 formal preflight

新增 detached-Ed25519、外部 trusted key 验证的 formal manifest/pre-start verifier，绑定 Git tag/commit、
self-track route、TB 2.1 identity、TCB/protocol/split/search/budget/leaderboard identities，并独立要求
Gate 4/5/6 receipts、real exact-identity baseline、provider smoke、budget reservation 与 operator procedure
receipts。当前所有缺口 fail closed 为 `BLOCKED_NOT_STARTED`；未创建 formal run directory，未启动
80-candidate search，sealed access 为 0。详见
[`docs/audits/2026-08-14-gate7-preflight.md`](docs/audits/2026-08-14-gate7-preflight.md)。

## Gate 8 evidence verifier

新增 sealed/full/release fail-closed verifier：重建完整 29×k paired matrix，固定至少 100,000 次
task-cluster bootstrap 与 5pp/CI 门槛；candidate lock 绑定 baseline/model/protocol/plan/analysis/split；
只有 `SEALED_PROMOTED` 才允许固定 capsule 的 89×≥5 full set，并要求 fresh-profile、Loader、SBOM、
provenance、rollback 与 public leak-scan receipts。当前权威状态仍是 `BLOCKED_NOT_STARTED`：无正式
candidate lock、reveal count=0、sealed/full trials=0、无 promotion/release。详见
[`docs/audits/2026-08-14-gate8-verifier.md`](docs/audits/2026-08-14-gate8-verifier.md)。

## Gate 2 successor（已验收）

真实 baseline candidate 已被打包为带 root launcher、bundled Node 和确定性 SHA-256 的 ACP
binary archive，并经本地 immutable HTTPS endpoint 交给 Harbor generic ACP agent。Harbor 完成
initialize/prompt/verifier，生成原生 `agent/trajectory.json`、`acp-events.jsonl`、
`acp-summary.json`；normalizer 强制消费三者并得到可复现、可归因的 `reward=0` 有效失败。
这证明执行链路，不构成策略或 benchmark capability 通过。

完整证据见
[`docs/audits/2026-08-14-gate2-successor.md`](docs/audits/2026-08-14-gate2-successor.md)。

## Gate 1 successor（已验收）

Gate 1 已通过 versioned successor 修复：capsule 现在物化真实 pinned runtime closure、生成
SPDX 2.3 package inventory、使用无循环的 manifest/sums 联合 hash，并从 packed bytes 完成 ACP
initialize/session/prompt。验收同时在独立 network namespace 与 fresh `FROM scratch` Docker
容器中通过；容器为只读根文件系统、`NetworkMode=none`，未挂载 source checkout。

完整证据见
[`docs/audits/2026-08-14-gate1-successor.md`](docs/audits/2026-08-14-gate1-successor.md)。

## 2026-08-14 独立验收审计

对 commit `4cbd1b0fe0df80765c9e9292f174b8c5f47c1034` 按 `specs/00–07` 重新逐门审计后，
此前的“Gate 0–6 COMPLETE”口径标记为 `SUPERSEDED`。最早失败门是 Gate 1：当前 capsule
仍通过 source-checkout symlink 提供 DSH packages，只验证真实 Loader boot，没有按 spec 02 §12 / spec
07 §3 完成自包含 stable ACP runtime 的 initialize/session E2E。Gate 2–6 的已有代码和 artifact
继续保留为工程证据，但在 Gate 1 successor 验收前均不得作为已通过门。

完整差距矩阵与修复顺序见
[`docs/audits/2026-08-14-gate-acceptance-audit.md`](docs/audits/2026-08-14-gate-acceptance-audit.md)。

当前声明边界：

```text
GATE_0_ACCEPTED
GATE_1_ACCEPTED
GATE_2_ACCEPTED
GATE_3_ACCEPTED
GATE_4_ACCEPTED
GATE_5_NOT_ACCEPTED
GATE_6_NOT_ACCEPTED
GATE_7_BLOCKED_NOT_STARTED
GATE_8_BLOCKED_NOT_STARTED
FORMAL_SEARCH_NOT_STARTED
SEALED_NOT_ACCESSED
NO_PERFORMANCE_CLAIM
```

## 以下为被审计取代的历史状态（保留，不作为当前验收结论）

**历史状态：GATE 0 + 1 + 2 + 3 + 4 + 5 + 6 COMPLETE — `SUPERSEDED`**

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

### Gate 5 历史 pipeline fixture（已隔离，不是验收）

- **TB 2.1 task inventory**（`evidence/calibration/tb21-inventory.json`）：89 task，
  difficulty 4 easy/55 medium/30 hard、16 category。
- **可公开重放的 fixture split**（`evidence/calibration/split-commitment.json`）：
  48/12/29 size 校验通过、Merkle root `sha256:6ce0972a…`、seed commitment 记录；
  但 seed 已公开，不能证明 sealed assignment 隔离。
- **calibration pilot**（`evidence/calibration/calibration-samples.jsonl`）：3 个 dev task
  经真实 Harbor job（docker build → verifier）测量 wall = 31.1s / 41.8s / 76.9s。
- **历史 budget 输出**（`evidence/calibration/budget-model.json`）：记录为 `CALIBRATION_FEASIBLE`，
  但当前权威状态是 `QUARANTINED_NOT_ACCEPTED`。
  predicted p90 cost = **$41.96**（target $500），predicted p90 wall = **2.38h**（target 16h）。
  frozen: `B_eval=760, B_prop=$40, k_sealed=1, concurrency=4, reserve=20%`。
  注：fixture 用 nop agent 测 Harbor pipeline 成本下界；model cost 是人工假设，不能据此判定
  real baseline/model 路径 feasible。
- calibration-evidence test（4 绿）只验证历史 bytes 自洽，不是 Gate 5 acceptance。

## Gate 6 历史 loop fixture（已隔离，不是 pilot 验收）

### Pilot search loop（`packages/dsh-rsi-pilot/`）

- **autonomous search-loop orchestrator**（`loop.ts`）：pure state machine over injected
  capabilities（propose/build/evaluate）。UCB-Air expand/evaluate、clade-Thompson parent selection、
  cold-start enforcement、**dedup-by-digest（duplicate edge，不新建 candidate）**、build-reject/eval-fail
  记账、B_eval exhaustion、K-admitted 终止；iteration cap liveness guard。crash/resume via journal。

### 非验收 fixture 证据

- **pilot 跑通 terminal state**（`evidence/pilot/pilot-result.json`）：`K=10, B_eval=40`，
  **SEARCH_COMPLETE: 10 admitted**，39 observations，0 dedup/reject/fail，wall <1s。
- **pilot loop tests（6 绿）**：SEARCH_COMPLETE@K、B_EVAL_EXHAUSTED、dedup-by-digest、
  build-reject handling、eval-failure continuation、observation attribution。
- **pilot evidence + crash/resume（2 绿）**：pilot-result.json 自洽（10 admitted）；
  crash/resume determinism（同 seed → 同 lineage）。

> 更正：该历史 artifact 使用 synthetic stub capabilities 与 `Math.random` reward，只证明旧 loop
> 到达 terminal state；它不是 deterministic evidence，也不是 Gate 6。real proposer/builder/Harbor
> successor 必须先完成 Gate 6，且结果与 formal Archive 隔离。

## 尚未完成（真实运行与外部依赖）

- Gate 4：Zen/high/1m compatible successor 已验收；CPA 保持未修改。
- Gate 5：正式独立 principal/volume split ceremony、60×≥2 real baseline、real 3-candidate
  calibration 与 accepted budget。
- Gate 6：新的 real K=10 pilot、真实 crash/reconcile、raw evidence 与成本误差审计。
- Gate 7/8：只有上述 receipts 齐全后才可签名启动 formal 80-candidate run，再决定是否 single reveal、
  29×k sealed、89×≥5 full set 与 release。

因此当前不能声称：formal 80-candidate search 已运行、sealed 揭盲已确认分数提升、可提交 leaderboard
或达到 SOTA——这些需 Gate 7-8 的真实付费运行。

## 下一个可执行验收门

下一验收门是部署正式 sealed-service principal/volume 并 mint successor split；之后才可运行 Gate 5
付费基线与 calibration。不得跳到 Gate 7 formal search 或 Gate 8 reveal。逐项清单见
`docs/phase-todolist.md`。
