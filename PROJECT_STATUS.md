# Project status

**当前权威状态：`GATE_0_ACCEPTED`; `GATE_1_ACCEPTED`; `GATE_2_ACCEPTED`; `GATE_3_ACCEPTED`; `GATE_4_ACCEPTED`; `GATE_5_ACCEPTED`; `GATE_6_ACCEPTED`; `GATE_7_ACCEPTED`; `V011_A_ACCEPTED`–`V011_E_ACCEPTED`; `V020_PROVIDER_ACCEPTED`; `V020_EFFECTIVENESS_ACCEPTED`; `V020_RELEASE_ACCEPTED`; `GATE_8_BENCHMARK_PROFILES_OPTIONAL_NOT_RUN`**
**更新时间：2026-08-28（Asia/Tokyo）**

## 2026-08-28 current-main gate repair

- Issue #238 records that commit `22a5a5a3f9c488db5b0b4f365c193907af036f41` failed the required hosted
  Prettier step, so the remaining CI steps did not execute.
- The merged repair contains formatting-only changes to the 15 files rejected by pinned Prettier. Local gate and
  repository-integrity checks pass; unit is 105 files / 809 passed + 1 skipped. PR #239 passed hosted CI and was
  independently reviewed before merge. This repair makes no benchmark, promotion, or release-performance claim.

## 2026-08-28 Responses continuation compatibility

- Issue #187 was narrowed after current-code verification: a real provider tool-loop already existed, while explicit
  cross-round context survival remained untested.
- The dedicated provider-configurable Responses E2E carries unpredictable user/assistant markers through two real
  function-call/output rounds and requires the final provider text to reproduce all prior markers. It is skipped
  unless all four `OPENAI_*` route variables are supplied, and it never persists or prints the credential.
- On 2026-08-28 it passed against `http://64.186.236.156:24634/v1/`, model `gpt-5.6-luna`, Responses wire API and
  reasoning effort `max`: two tool rounds completed and all six unpredictable context/result markers survived into
  the final text. No-key E2E now reports 36 passed + 4 credential-gated skipped.
- Passing this compatibility test proves only the exercised Responses item shapes on the locked endpoint/model; it
  is not benchmark, candidate-improvement, sealed, promotion, or release evidence.

## 2026-08-28 v0.1.1 candidate identity repair

- Issue #198 identified a deterministic attribution mismatch: the v0.1.1 controller and overlay used an admission
  `sha256:` digest while `capsule.json` exposed the Candidate SDK `c_<base32>` build identity to Gate 5.
- v0.1.1 now uses the admission digest as the single controller/overlay/capsule/evaluator identity. The SDK build ID
  remains explicit as `candidate.buildCandidateId` and is cross-bound in the admission receipt.
- Engine failure-pool selection, trial accounting, outcome pairing and audit derive the baseline role from the actual
  admitted baseline identity instead of the historical `baseline` alias. Resume and audit reject pre-repair stable
  state whose record, receipt and capsule identity chain does not match; there is no silent state migration.
- The repair passes format, lint, typecheck, 813 unit tests (+1 platform skip), and 36 no-key E2E tests (+4
  credential-gated skips), including real Harbor ACP, extract-elf smoke, offline packed Loader and crash/replay paths.
- This is an attribution/correctness repair only. It creates no new benchmark, improvement, promotion, sealed or
  release evidence.

> **v0.2 release accepted:** live product, package, CLI, Cordis service, protocol/MIME and release identities are
> `dsh-self-evolving`. The default route is DeepSeek official Responses, not Codex/CPA. A real low-consumption
> successor proves an admitted child changes the preregistered solve replay while preserving propose replay.
> Historical v0.1/v0.1.1 paths and hashes remain immutable predecessor evidence.

v0.2 current regression passes 291/291 unit tests and 36 no-key E2E tests; all three credential-gated official-provider
cases were also run separately and passed. The clean Apache-2.0 source archive passed checksums, no-Git fresh setup,
exact upstream provenance, Loader/capsule smoke and CLI `init`/`status`.

v0.2 provider/effectiveness 的最终对账见
[`docs/audits/2026-08-15-v0.2-provider-effectiveness.md`](docs/audits/2026-08-15-v0.2-provider-effectiveness.md)。

v0.1.1 的最终 gate/commit/identity/test 对账见
[`docs/audits/2026-08-15-v0.1.1-release-candidate.md`](docs/audits/2026-08-15-v0.1.1-release-candidate.md)；
v0.1 predecessor 证据仍见
[`docs/audits/2026-08-14-v0.1-release-candidate.md`](docs/audits/2026-08-14-v0.1-release-candidate.md)。

> **Scope successor（2026-08-14）**：当前完成口径已由“一次性跑完 Terminal-Bench campaign”调整为
> “证明真实 K=3 闭环可稳定迭代并形成可用开源 v0.1”。下文 Gate 5/6 历史 benchmark artifacts 继续
> 保留，但 60×2、K=10/K=80、sealed/full-set 不再阻塞 Gate 7 开源 release。

**v0.1.1 successor**：schema-v2 multi-file candidate、精确父 Loader、raw-evidence citation、受限工具、
trusted materialization/admission、mechanism outcome 与 schema-11 CLI 已实现并验收。fresh run
的 mechanism outcome 按实际 task/attempt 对 baseline/child 作完整配对；缺失、重复、错配及 invalid
trial 均 fail closed，且相同 trial multiset 的排列产生相同 idempotency bytes。
`v011-20260815-v13` 在执行 commit `9ae960c4b7d39ce7a446fd633500b7fddfbe0bb0` 上完成 2 个 baseline 和
3 个 candidate Harbor trials，连续 admitted 3 个 unique multi-file children，lineage depth 3；真实 external
launch 后 `SIGKILL` 的 resume 只保留一次 launch/observation/commit。独立 audit 接受 52 个 events，状态为
`AUTONOMOUS_PLUGIN_DEVELOPMENT_VERIFIED`，state hash 为
`sha256:75e11727ec3d610016c40c2fe4cc53087226926e6576563eb5fdc205e854bc96`，sealed access 为 0。

所有 `gpt2-codegolf` baseline/candidate observations 都是明确的 `invalid`/reward 0，因此不能声明得分提升。
v1–v2、v4–v12 的失败 lineage 均保留 `QUARANTINED_NOT_ACCEPTED`；v3 是合法的
`NO_REAL_FAILURE_SIGNAL` negative run，未被当作 acceptance evidence。

## Gate 5–7 v0.1 successor（已验收）

统一 stable-demo CLI 已接通真实 proposer、candidate builder、Loader、Harbor evaluator、normalizer、durable
controller 与 Archive，并提供 `init/run/resume/status/audit/doctor`。默认 profile 为 K=3、最多 15 个
solver trials、sealed access 为 0；付费 launch 前 fail closed 检查 credential、route、Docker、Harbor、
task materialization、private state、预算及源码身份。

真实 run `stable-demo-20260814-v10` 完成 6 个 baseline 与 3 个 candidate Harbor trials，产生 3 个 unique
admitted children、lineage depth 3，并在真实 external launch 后注入 `SIGKILL`。resume 后每个 action 只有
一次 launch/observation/commit；独立 audit 接受 73 个 events，终态为 `STABLE_ITERATION_VERIFIED`，state
hash 为 `sha256:1ede79e9a0e702d4f74849be5a0cf5628d75063862746bb1674c5f13aade3bc0`。

Gate 7 已完成 Apache-2.0 source-archive release closure：一条 `pnpm setup:source` 在 fresh extraction 中
完成固定上游、DSH、Harbor 与本项目安装；真实 Loader、无 Git source identity、doctor、backup/restore、
uninstall/rollback、SBOM、dependency licenses、provenance、checksums 与 leak/UTF-8 scan 均通过。发行状态为
`OPEN_SOURCE_V0_1_RELEASE_CANDIDATE`；独立 npm package 明确为 `NOT_INCLUDED`。

完整证据见
[`docs/audits/2026-08-14-v0.1-release-candidate.md`](docs/audits/2026-08-14-v0.1-release-candidate.md)。

## Gate 3 successor（已验收）

`@dsh-self-evolving/core` 现为标准 DSH/Cordis bundle，只暴露生命周期归属的 `ctx.selfEvolving` service；journal
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
root-owned immutable `/opt` release，并以当时的 legacy `dsh-rsi-sealed` UID 和 mode-0700 `/var/lib` store
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
DSH session 保留 10 个 usage events；按用户指定的 DeepSeek-V4-Flash 官方美元价格重算为
`$0.0031026576`，现为 `priced=true` 的单题工程 smoke，但仍不能替代 Gate 5 的完整 matrix。详见
[`docs/audits/2026-08-14-gate5-real-smoke-successor.md`](docs/audits/2026-08-14-gate5-real-smoke-successor.md)。

## Optional formal preflight capability

新增 detached-Ed25519、外部 trusted key 验证的 formal manifest/pre-start verifier，绑定 Git tag/commit、
self-track route、TB 2.1 identity、TCB/protocol/split/search/budget/leaderboard identities，并独立要求
Gate 4/5/6 receipts、real exact-identity baseline、provider smoke、budget reservation 与 operator procedure
receipts。当前所有缺口 fail closed 为 `BLOCKED_NOT_STARTED`；未创建 formal run directory，未启动
80-candidate search，sealed access 为 0。该 capability 属于发布后 optional benchmark profile。详见
[`docs/audits/2026-08-14-gate7-preflight.md`](docs/audits/2026-08-14-gate7-preflight.md)。

## Optional sealed/full evidence verifier capability

新增 sealed/full/release fail-closed verifier：重建完整 29×k paired matrix，固定至少 100,000 次
task-cluster bootstrap 与 5pp/CI 门槛；candidate lock 绑定 baseline/model/protocol/plan/analysis/split；
只有 `SEALED_PROMOTED` 才允许固定 capsule 的 89×≥5 full set，并要求 fresh-profile、Loader、SBOM、
provenance、rollback 与 public leak-scan receipts。当前权威状态仍是 `BLOCKED_NOT_STARTED`：无正式
candidate lock、reveal count=0、sealed/full trials=0、无 promotion/release。详见
[`docs/audits/2026-08-14-gate8-verifier.md`](docs/audits/2026-08-14-gate8-verifier.md)。

## 2026-08-27 audit-hardening batch（证据绑定 / 预算 / 幂等收敛）

远端 issues 的审计硬化批次已全部落地（每项：本地全量门禁 → 独立 subagent adversarial review →
APPROVE 后 squash merge；评审发现的新问题均立为 issue）：

- **#121 / PR216**：Gate6 验证器不再信任 hash 形状的 `normalizedRecordHash`——observation 必须携带
  `normalizedRecord` 内容，验证器重算 canonical digest 并要求 record 的 candidateId/taskId/attemptIndex
  与 observation 行一致；整个证据 envelope 以 `evidenceCommitment`（`gate6EvidenceCommitment`）内容寻址，
  事后任何编辑都会发散。评审确认 commitment 覆盖全部 load-bearing 字段。
- **#219 / PR220**：同一模式移植到 Gate8——sealed/full-set trial records 内容化 + own-enumerable 身份绑定
  （prototype/non-enumerable 身份在 Gate8 从第一天即被拒绝）；search 包新增 candidate-sdk canonical 依赖。
- **#111 slice 2 / PR221**：Gate8 envelope 以 `gate8EvidenceCommitment` 记录式承诺覆盖（divergence 同时
  冻结 promotion 分类为 PROTOCOL_INVALID）；record outcome 绑定（reward 必须等于被统计的行值、full-set
  capsuleDigest 绑定锁定 capsule）；attemptIndex/scheduleIndex 整数化。剩余 receipt 字节化/签名验证仍在 #111。
- **#108 / PR222**：未定价 usage 不再以测得零释放预留——`EvaluationObservation.pricing` 结构化
  priced/unknown 状态（缺失/畸形/非有限成本一律降级 unknown），unknown 按全额预留结算，stable audit 对
  任何未解决 unpriced usage fail closed；real provider 保留 summary 的 priced 标志。
- **#56 / PR224**：proposal gateway 幂等收敛——in-flight 同步注册（同 id 并发 join 同一次 dispatch）、
  durable request store（`wx` 预留 → 原子完成 → 崩溃遗留 pending 永不重发）、replay 前完整 envelope 验证
  （含 responseHash 重算，防 poisoned success）、stale socket 探测重绑（live 拒绝）、reservation 写失败
  上抛而非毒化 id；v1/v011 两条生产 wiring 均指向跨重启稳定的目录。

评审驱动新立 issue：#217（Gate6/8 malformed envelope fail-closed + empty-fixtures 旁路）、#218
（canonicalV011 规范化弱点，需版本化迁移）、#219（已修）、#223（#108 收尾：audit/provider 覆盖、失败
原因粒度、legacy re-settle 文档）。本批合并后全量本地门禁：build/lint/typecheck 干净，unit
103 files / 784 passed + 1 skipped，E2E 36 passed + 3 skipped。

所有上述均为验证器/预算/幂等层的 falsifiability 与 fail-closed 强化；不改变现有已验收 gate 结论，
不产生新的 benchmark/promotion 声明。

## 2026-08-28 issue-convergence batch（验证器加固 / 规范化 / 时序收敛）

上一批（2026-08-27）之后的第二轮流散收敛，同样逐项走本地全量门禁 → 独立 subagent 对抗性
review → APPROVE 后 squash merge；全部评审发现（含两轮 REQUEST_CHANGES 的阻断项）均已
修复并由同一评审复核确认：

- **#227 / PR228**：budget-stale-lock SIGKILL 测试去 flaky。评审定位真实根因（测试自身的
  flock 探针短暂持锁 + worker 单次非阻塞获取碰撞即死），worker 改为有界重试（碰撞延迟而非
  死亡），wait 与 worker 退出竞速实现即时可诊断失败；30+10 次压力运行零失败。
- **#223 / PR229**：#108 收尾——audit 未定价拒绝对正/负控制用例、provider pricing 映射直测、
  writer 把 readDshUsage 的具体失败原因写入 summary（pricingReason）、legacy re-settle 行为
  在 ledger 头部文档化、observationPricing 对 null/-0 fail closed。
- **#217 / PR231**：Gate6/Gate8 malformed envelope 全面 fail closed（两轮 review：第一轮修复
  后评审探测出 Gate6 throwing-getter 与 Gate8 14 个 JSON 可表示崩溃面，全部补齐并 pin 测试）；
  Gate6 fixtures 空对象旁路关闭；Gate6 身份比较移植 own-enumerable 语义。
- **#214 / PR232**：engineering-effect gateway receipts 绑定 run id + 锁定路由哈希
  （`engineeringEffectRouteHash`），外部 run/route 的 receipt 集不再满足 gate。
- **#218 / PR233**：canonicalV011 加固（UTF-16 code-unit 键序、非 plain 叶拒绝、undefined 键
  跳过）。评审发现并纠正了"全量字节稳定"的错误声明：splitReveal 键集是唯一迁移的生产形态，
  新旧 digest 均 pin、且证实无任何已记录 gate8 commitment 先于该变更（exposure 为零）。
- **#234 / PR235**：freezeCapabilityCatalog 行序 bytewise 化（catalog digest 摆脱 ICU 依赖），
  同样 pin 新旧 digest 并证实生产 id 集无 divergence。
- **#230 / PR236**：Gate 2 Harbor E2E 相位计时 + 300s→480s 余量（评审复现相位日志：
  harbor-job ~71-95s、archive pack ~11-18s）。

本批终态门禁：build/lint/typecheck 干净，unit 105 files / 809 passed + 1 skipped，E2E
36 passed + 3 skipped。#226 确认为 #227 重复并关闭。

剩余开放 issue 均为较大设计工作，未动：#213（preflight 签名密钥锚定）与 #111 剩余片
（receipt 字节化/签名验证，依赖 #213）；#198/#197/#187；架构级 #37/#51/#65/#116 需先写 ADR。
本批不改变任何已验收 gate 结论，不产生新 benchmark/promotion 声明。

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

该历史审计当时的声明边界：

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

- `packages/dsh-self-evolving-loader-e2e/`：通过真实 `@deepseek-ai/cordis-plugin-loader` + Include/Group
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
  缺 result/reward/trajectory 或 candidate/task/attempt mismatch → INVALID；reward 仅接受 exact 0/1，
  不从分母消失；只有 attribution 完整、无正常 reward、无损坏/歧义 evidence 且 artifact phase 与精确
  预注册类别一致时才可 infra retry；重解析同 hash。
- **idempotency store**（`src/idempotency.ts`）：append-only ledger，同 key 二次 submit 拒绝，
  不产生第二个付费 trial。
- **cost reconciliation**（`src/reconcile.ts`）：harbor/acp/dsh 三源 token+USD 对账，差异即 null，
  unpriced 显式标注，重解析同 hash。

### Gate 2 真实 Harbor 证据

- **真实 Harbor job smoke**（`harbor-smoke.e2e.ts`，3 绿）：跑通 docker build → agent → verifier →
  reward 全链路。golden（oracle 正确解）→ reward 1.0 → normalizer PASS；nop（nop agent）→
  reward 0.0 → FAIL；broken（oracle 崩溃解）→ reward 0.0 → FAIL。满足 spec 07 §4 nop/broken/golden。
- normalizer/cost/idempotency 单元测试（`normalizer.test.ts` 24 绿、`normalizer-infra-retry.test.ts` 22 绿、`provider.test.ts` 8 绿、
  `reconcile.test.ts` 5 绿）。

## 已完成 — Gate 3（持久化 controller 核心）

### Controller（`packages/dsh-self-evolving/`，trusted durable core，spec 06）

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

### Proposal runner（`packages/dsh-self-evolving-proposer/`）

- **真实 DSH Loader + 真实模型**（`runner.ts`）：boot 最小 model-backed composition
  （`llm-deepseek` → `agent-spine-demo` → `agent-default-model`），通过 `ctx.agents.create({ agentOptions,
setup })` mint 一个 scoped proposer agent，其唯一 model route 由 composition 锁定
  （只有 `deepseek-official` adapter 指向 verified endpoint）。followup proposal prompt → whenIdle →
  收集 `assistant/message` 事件文本。
- **parse + protocol validation**（`parse.ts`）：解析模型 JSON envelope（容错 markdown fence / 嵌入散文）→
  `validateProposalBatch`（width、hypothesis dedup、donor provenance、no-change/test-only 拒绝）。
- **builder handoff + rejected 保留**（`parse.ts` `retainRejected`）：rejected proposal 连同 raw assistant
  text + reason + timestamp 保留为 evidence（不静默丢弃）。

### Proposal safety（`packages/dsh-self-evolving/src/proposal/`，Gate 4 工程地基，复述）

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

### Search（`packages/dsh-self-evolving-search/`）

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

### Pilot search loop（`packages/dsh-self-evolving-pilot/`）

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

## 当前开发范围已完成

- Gate 5：统一 CLI 与真实迭代闭环已验收。
- Gate 6：真实 K=3、三候选、多代谱系与 crash/resume exactly-once 已验收；不要求得分提升。
- Gate 7：Apache-2.0 source release、fresh install、SBOM/provenance/checksums 与操作恢复已验收。
- Gate 8：K=10/K=80、sealed、full-set 全部为发布后 optional profiles，状态为
  `BENCHMARK_PROFILES_NOT_RUN`。

v0.2 另已完成全量 live identity 改名、DeepSeek 官方 Responses 默认路由，以及真实低消耗
effectiveness successor。`v0.2-official-responses-v6` 的 baseline/child 均完成 trusted admission；solve 固定
回放 digest 改变，propose control digest 保持，状态为 `ENGINEERING_EFFECT_VERIFIED`。该结果不等于题目得分提升。

当前可以声明 `STABLE_ITERATION_VERIFIED`、`ENGINEERING_EFFECT_VERIFIED` 与
`OPEN_SOURCE_V0_2_RELEASE_CANDIDATE`。不能声明
Terminal-Bench 提分、sealed promotion、leaderboard 或 SOTA。

## 发布边界

v0.2 已达到本地开源 release-candidate 完成口径。发布到 GitHub 仍等待 maintainer 授权。Gate 8
benchmark profile、K=10/K=80、sealed/full-set 和持续提分属于发布后的独立开发范围，不阻塞本次验收。

## 2026-08-26 远端 issue/PR 修复批次（timwhitez/dsh-self-evolving）

以逐项"先契约测试、后最小修复、单 PR 单门"的方式处理远端 open issues。以下状态仅报告已合并进
main 且带回归测试的修复（各 PR 见对应 squash commit）；未列出的 issue 仍保持 open，不做任何完成宣称。

### 已修复并关闭（合并至 main）

- #31 / #32：reducer exact/logical 状态哈希分离 + 协议状态机强制（动作转移表、lineage/donor 校验、
  observation 唯一性、run-phase 单调、lock/reveal 次序）。E2E crash worker 同步补齐 admission。
- #36：policy scanner 以 TypeScript AST 层强化——`export * from`、注释内 dynamic import、
  `process['env']`、绝对路径 specifier、parse 失败即 reject；regex 层保留为纵深防御。
- #38 / #43 / #95 / #96：sealed-service 与 builder 锁/发布恢复——公共 receipt 改为 staging+link
  原子发布；初始化仅接受确认 ENOENT；锁回收按 inode+字节 compare-and-delete、模糊存活判 BUSY；
  builder 锁原子发布并可安全回收空锁。
- #40 / #119：quiescence 门从构造器名成员比较改为每类型计数 delta，可检同型泄漏；
  afterEach 不再吞 dispose 失败。
- #41 / #42：capsule 于私有 staging 建成后原子 rename 发布，输出目录已存在即 fail-closed；
  SHA256SUMS 覆盖 symlink 目标并要求条目集严格相等（缺失/多余/硬链接/特殊文件全拒）。
- #54：changed-line 预算改用 LCS 顺序感知编辑距离，重排不再零成本；超界文件 fail closed。
- #55：proposal+gateway-receipts 以 manifest 提交点原子成束发布；resume 仅经 manifest 加载，
  未提交目录视为未完成 publication；每次加载重新校验 sha256 绑定。（#45 的崩溃窗口部分
  已由 v011 recovery 的 staging+link 关闭；重复外部工作残余归入 #53。）
- #61：Responses 工具续传按 message 序保留完整会话（user/assistant 文本 → message item，
  cached reasoning/function_call + function_call_output 就位交错）。
- #64：canonical archive 对每个中间路径组件做 no-follow 校验，realpath 全局 containment，
  nlink≠1 硬链接拒绝。
- #70：evaluation saga `pending` 时引擎挂起为 `PENDING_EVALUATIONS`（计数全部派生自 journal），
  不再冻结 failure pool 或写 terminal 事件；恢复经既有幂等路径 exactly-once 完成。
- #71：builder staging 改为独占 mkdir 认领 + 持久 owner intent；死主/前缀残留隔离到
  `reclaimed-*` 后重试，活主 BUSY，torn candidate 根同样隔离重建。
- #73：cost reconciliation 采用与 normalizer 相同的 agent/ 目录布局优先解析，双份不一致记冲突；
  corrupt 来源显式失败而非当作 missing；consistent 要求 input/output/cache/USD 四字段全一致。
- #74：TB 幂等预留改为 per-key 排他 marker + fsync（16 并发恰一胜出）；ledger 校验 fail closed，
  record 必须绑定 (candidate, task, attempt) 身份。
- #75 / #76：预算模型对样本与参数全域校验后fail-closed；Thompson 采样改为精确 Beta
  （Marsaglia–Tsang Gamma 组合），固定流确定性保留并刷新 scheduler golden。
- #77 / #81：Gate 6 用 SDK 规范 `c_<base32>` 身份校验器替换 sha256 形状误用；runtime intent
  按 kind 解析到冻结能力行，跨类替代 disable/unknown 一律拒绝，返回解析绑定供 admission。
- #86：proposal gateway 增加 maxConnections、idleTimeoutMs、requestTimeoutMs，超限主体即刻销毁。
- #92：sandbox 可执行 allowlist 先做组件级规范化（拒绝 `.`/`..`/空/NUL），再匹配规范化路径。
- #105 / #107：summary 复用须与 run-intent 及请求任务集完全对账，provider 不再把 caller 身份
  盖到旧 evidence 上；trial 目录↔任务交叉绑定、attempt 唯一性、既有 sidecar 必须与计划身份一致。
- #118：V0.1.1 proposal 外层 acquire→try/finally 全程恢复 provider key；gateway 先关停后收据，
  清理错误聚合不掩盖原异常；gateway 启动 chmod 失败自清理监听 server。

### 待合并 PR（CI 通过后 merge）

- PR #182（#61 续传保序）、PR #183（#55 原子成束）、PR #184（#71 staging 回收）。

### 明确未完成、保持 open（不构成任何验收声明）

- **大范围审计硬化族**（#78 #79 #82 #83 #85 #87 #110 #111 #113 #114 #121 #125）：共同前提是
  把各 gate verifier 的输入从 caller 断言（hash 形状字符串/布尔）换成可信 object store 中
  artifact 字节的重建与交叉绑定；需按 spec 06 统一设计 receipt schema 与 audit 重放，属多 PR 工程。
- **#53 / #45 残余**：proposal/build 路径尚未走 evaluation 同款 action saga（持久 intent→外部效果→
  durable receipt）；完成后 #45 的重复工作面随之闭合。
- **Provider 传输**（#57 AbortSignal 贯通、#123 重试计费对账）需协议层扩展（deadline/token 入封包）
  并配套 gateway/adapter E2E。
- **架构级**（#37 tsconfig 执行边界、#51 cgroup 配额、#65 构建期单一快照、#116 凭证与候选同进程）
  需要 ADR（含容器/cgroup 拓扑与 DBUS/systemd-run 依赖决策）后方可实施；在 ADR 冻结前不动手。

以上未完成项的存在意味着当前仍不能声明这些攻击面已关闭；现有 v0.2 验收口径不变。

## 2026-08-27 第二批 issue 修复（本地门 + 独立 review + 合并）

GitHub Actions 新运行故障（startup_failure，无法重跑），本批全部改为**本地全量门**（build、单测、E2E、lint、typecheck）

- **独立 subagent review**（对每个 PR 出具 APPROVE/REQUEST_CHANGES，blocker 修复后复审）后合并。所有评审发现的新问题均已立 issue。

### 已修复并合并（均带回归测试）

- **#61（PR #182）**：Responses 工具续传保留完整会话（user/assistant 文本 → message item，cached items 就位交错）；system-role fail-closed。
- **#53/#45（PR #188）**：proposal/build 走 `recoverExternalAction` 持久 saga（PLANNED→RESERVED durable intent →效果→ LAUNCHED→COMMITTED，
  崩溃窗口按语义完成记录 reconcile-before-retry；状态门控写入；audit 接受终态 FAILED）；realProposal 绑定 idempotency key 进证据束。
- **#57（PR #189）**：gateway 传输贯通取消（envelope deadlineMs、client abort、socket close→host AbortController→provider fetch）。
- **#123（PR #192）**：LLM 传输重试逐 attempt 记账（408/5xx ambiguous 分类、丢弃响应 usage 回收并入总额、receipt 携带 attempt 日志；
  review blocker——cache 双计——已修）。
- **#72（PR #194）**：source identity 状态分级 SELF_CONSISTENT / COMMIT_ANCHORED / AUTHENTICATED（仅 archive 字节锚定可称认证），
  releaseFiles 精确清点，doctor 明示无外部锚。
- **#114（PR #196）**：V011 求解器 overlay 注入经 admission 验证的 candidate digest（双 token 替换 + probe receipt 身份校验 + fail-closed）。
- **#125（PR #199）**：finish_proposal 终端化并绑定验证字节 digest（mutating 工具拒绝、worker 出口复核、trusted 物化侧强制比对）。
- **#110（PR #201，部分）**：Gate8 sealed/full 矩阵与 revealed/inventory 列表精确集合相等（按 review 建议保留 open：Merkle/清单认证属 #111 域）。
- **#113（PR #202）**：invalid-replacement fixture 改为真实可复现负向动作（真实校验器拒绝 + digest 绑定 + audit 重放交叉验证）。

### 评审期间新立 issue（未解决，不宣称闭合）

issue #186（空白/不可序列化消息静默丢弃）、#187（Responses 续传无真实端点 E2E）、#190（生产未接线 deadline/signal；半关死客户端仅窗口兜底）、
issue #191（budget-stale-lock flaky）、#193（gateway 失败路径丢 attempt 日志）、#195（pruned 目录名清点盲区）、#197（probe 应加载真实打包 overlay）、
issue #198（V011 capsule c_id 与 controller digest 身份域在 collect 不相交）、#200（slot 元数据绑定 + worker 出口门负测试）、
issue #203（fixture 记录跨绑定 + schema 身份钉扎）。

### 仍开放（原有）

issue #37、#51、#65、#116（架构级，需 ADR）；issue #56、#78、#79、#82、#83、#85、#87、#108、#111、#121（审计/验证器证据字节化族）。

验收口径不变：以上合并项均为工程加固，不构成任何 benchmark 提升或 sealed 结果声明。
