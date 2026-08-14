# Project status

**状态：GATE 0 + 1 + 2 + 3 COMPLETE; Gate 4 工程地基 COMPLETE（真实模型生成待集成）**  
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

## 已完成 — Gate 4 工程地基（proposal safety + protocol）

> 注：Gate 4 的**安全工程地基**已完成并通过测试。最后一步——parent candidate 经真实 DSH Loader
> （`ctx.agents.create`）+ 真实模型生成 ≥1 个 admitted child——是把已验证的 proposal protocol/sandbox
> 接入 DSH agent spine + ACP 的集成工作，留给后续。provider 连通性已验证（`PONG` probe 成功）。

### Proposal 模块（`packages/dsh-rsi/src/proposal/`）

- **proposal sandbox policy**（`sandbox.ts`）：纯函数 fs/network/model-firewall 决策；parent/archive/
  evidence/contracts 只读、childrenRoot 唯一可写；host 敏感路径（home/SSH/docker.sock/controller IPC/
  .aws）一律拒；traversal 拒；build phase 全禁网；model firewall 锁 provider/endpoint/model，拒 candidate
  自定 route/billing tags。**决策是纯函数 → prompt-injection 不能改变 policy**。
- **label-filtered evidence export**（`export.ts`）：proposer 视图只含 allowed labels（PUBLIC_SPEC/
  DEV_OBSERVED），GUARDED/SEALED 永不进入；Merkle root 防篡改；canary absence receipt 记录 excluded
  数量与 hash。
- **canary leak scan**：sealed/guard canary token 若泄漏进 proposer transcript 即被检出（information-
  flow incident）。
- **proposal output protocol validator**（`protocol.ts`）：width=3、hypothesis dedup、donor provenance 校验；
  拒绝 no-change / test-only / 空 hypothesis / 缺测试 / 超 width / 坏 donor。

### Gate 4 测试证据（23 绿）

- sandbox fs policy（6）：read-only 输入、唯一可写、host 敏感拒、traversal 拒、纯函数。
- network policy（2）：proposal allowlist、build 全禁。
- model firewall（4）：locked route、拒 model/endpoint override、拒 billing tags。
- evidence export（3）：GUARDED/SEALED 不进入 proposer 视图、Merkle 防篡改、canary leak 检出。
- proposal protocol（8）：良构接受、no-change/test-only/空 hypothesis/缺测试/duplicate/超 width/坏 donor 全拒。

## 尚未完成（后续 Gate）

- Gate 4 剩余：parent candidate propose mode 经真实 DSH Loader（`ctx.agents.create` + ACP）+ 真实模型
  生成 ≥1 个 admitted child 的端到端集成；builder handoff；rejected proposal 证据保留。
- Gate 5+：search/split/sealed、calibration、pilot、formal 80-candidate、sealed/full evaluation。
  **需要付费 benchmark 运行**。

因此当前不能声称：闭环可端到端运行、分数提升、满足 `$500`/16 小时、零 reward hacking、
可提交 leaderboard 或达到 SOTA。

## 下一个验收门

完成 Gate 4 的真实模型生成集成（DSH agent spine + ACP + 已验证 provider），或推进 Gate 5
（需要付费 baseline/calibration 运行）。逐项执行清单见 `docs/phase-todolist.md`。
