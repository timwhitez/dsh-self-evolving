# Project status

**状态：GATE 0 + 1 + 2 COMPLETE — Awaiting Gate 3**  
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

- `format:check`、`lint`、`typecheck`、`test`（57 单元）、`test:e2e`（4 真实 Loader 测试，含
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

## 尚未完成（后续 Gate）

- Gate 3：durable controller（journal/reducer/archive/budget crash-safe）、proposal sandbox、
  search/split/sealed、calibration、pilot、formal 80-candidate、sealed/full evaluation。

因此当前不能声称：闭环可端到端运行、分数提升、满足 `$500`/16 小时、零 reward hacking、
可提交 leaderboard 或达到 SOTA。

## 下一个验收门

执行 `specs/07-implementation-plan.md` 的 Gate 3（持久化 controller 核心）。
逐项执行清单见 `docs/phase-todolist.md`。
