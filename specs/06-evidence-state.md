# 06 — Evidence store, state machine, and recovery

**Status:** normative draft  
**Principle:** files are authoritative evidence; indexes are disposable

## 1. Requirements

系统必须在以下情况下保持同一逻辑结果：controller crash、worker crash、重复 callback、network
partition、out-of-order completion、partial disk write 和 operator restart。具体要求：

- 每个 mutation 先有 durable intent，再有 side effect，再有 durable receipt；
- 同一 action 可安全 retry/reconcile，但不能重复计 reward、candidate 或 cost；
- Archive/state 可从 append-only events + immutable artifacts 完全重建；
- 数据标签、预算、RNG、split、candidate/protocol identity 均可审计；
- 缺失/损坏证据 fail closed，不通过手工编辑 `archive.json` 修复；
- 10M+ token 历史可由 proposer 在文件系统按需读取，不进入单一 prompt。

## 2. Filesystem layout

```text
evidence/
├── runs/<run-id>/
│   ├── run-manifest.json             # frozen after PREFLIGHT
│   ├── provenance.lock.json
│   ├── split-commitment.json
│   ├── journal/
│   │   ├── events-000001.jsonl
│   │   └── HEAD                      # last committed event hash/seq
│   ├── snapshots/
│   │   └── state-<seq>-<hash>.json   # derived, disposable
│   ├── actions/
│   │   └── <action-id>/
│   │       ├── intent.json
│   │       ├── launch.json
│   │       ├── collect.json
│   │       └── terminal.json
│   ├── archive/
│   │   ├── catalog.jsonl             # derived proposer view
│   │   └── graph.json                # derived visualization
│   ├── evaluations/
│   │   └── <eval-id>/normalized.jsonl
│   ├── budget-ledger.jsonl
│   ├── candidate-lock.json
│   ├── sealed-reveal.json
│   └── reports/
├── objects/sha256/<aa>/<digest>       # immutable content-addressed bytes
├── candidates/<candidate-id>/         # small refs/manifests into objects
├── exports/<export-id>/               # label-filtered read-only views
└── quarantine/
```

Runtime MUST 使用新 run directory；不得覆盖旧 run。`objects` 可跨 run deduplicate，但 object bytes
不可变，run refs 仍记录完整 provenance。

## 3. Object store

所有大/不可变内容先写 staging file，`fsync`，计算 hash，再以 no-clobber rename/link 发布。若 digest
已存在，逐 byte/size 验证一致。Object ref 形态：

```json
{
  "algorithm": "sha256",
  "digest": "...",
  "size": 1234,
  "mediaType": "application/vnd.dsh-rsi.trajectory+json",
  "label": "DEV_OBSERVED"
}
```

目录 artifact 必须 canonical tar 后存储。禁止 object symlink、mutable external URL 作为唯一 ref，
以及先写 metadata 后写 bytes。

定期 scrub 验证所有 reachable object hash。损坏 object 不自动从相同 URL 替换；从有 provenance 的
外部 job 重新 collect 后产生 repair receipt，若无法证明相同 bytes 则 run `EVIDENCE_CORRUPT`。

## 4. Event journal

唯一 writer 追加 canonical JSON event。每条包含：

```json
{
  "schemaVersion": 1,
  "runId": "...",
  "seq": 42,
  "eventId": "...",
  "occurredAt": "2026-08-14T00:00:00.000Z",
  "type": "evaluation.completed",
  "causationId": "action-id",
  "correlationId": "wave-id",
  "actor": "tb-provider",
  "payload": {},
  "previousHash": "sha256:...",
  "eventHash": "sha256:..."
}
```

Canonicalization 使用 RFC 8785/JCS 或项目固定等价实现；`eventHash` 对去掉自身字段后的 canonical
event bytes 计算。Segment close 时写 size/Merkle root，HEAD 原子更新并 fsync directory。

Wall-clock timestamp 只用于审计，不决定排序或策略；`seq` 是 commit order，external occurrence
作为 payload fact。

## 5. State reducer

Reducer 是 pure function：

```text
State_(n+1) = reduce(State_n, Event_(n+1))
```

它拥有：run phase、candidate statuses、lineage、observations、pending/reserved actions、RNG counters、
budget totals、external job mappings、locks 和 information-flow state。它不读网络、当前时间、随机数或
任意 filesystem；所需事实必须在 event payload/object ref 中。

Snapshot 只加速启动：加载前验证 state schema、last seq/hash 和 reducer version；否则从 genesis
replay。CI 对每个 fixture 比较 full replay 与任意 snapshot resume 的 canonical state hash。

## 6. Action lifecycle

每个 proposal/build/evaluation/reveal/formal action 都使用相同 saga：

```text
PLANNED -> RESERVED -> LAUNCHING -> RUNNING -> COLLECTING
        -> COMMITTED | FAILED | CANCELLED | ABANDONED
```

关键事件：

1. `action.reserved`：完整 request、idempotency key、budget reservation、RNG receipt 已 durable；
2. `action.launched`：external job ID/worker receipt durable；
3. `action.observed-terminal`：provider 返回 terminal fact，但尚未改变 Archive；
4. `artifact.collected`：所有 bytes/hash/schema 已验证；
5. `action.committed`：reducer 原子应用 observation、释放/结算 budget；
6. terminal failure/cancel 也有完整 receipt。

Worker 不直接写 journal，只写 staging/upload object，并把 receipt 返回 controller。重复 receipt 由
`actionId + artifact digest` 幂等；同 action 不同 digest 是 integrity incident。

## 7. Idempotency keys

确定性 derivation：

```text
proposal = H(run, wave, reservation, parent, proposer-protocol)
build    = H(run, proposal-action, canonical-source-hash, builder-protocol)
eval     = H(run, candidate, task-handle, split, attempt, eval-protocol)
reveal   = H(run, candidate-lock-hash, split-commitment, reveal-protocol)
```

External provider 必须保存/返回 key。Resume 发现 `RESERVED/LAUNCHING/RUNNING/COLLECTING` 时先 inspect
existing external job；只有 provider 证明 never launched 或 terminal infra retry 才能重新 submit。

## 8. Budget ledger

Budget 是独立的 append-only double-entry ledger，不是 state 中一个可手改总数。Reservation 在 launch
前冻结 upper bound：

```text
available -> reserved -> spent | released
```

维度至少包括 USD、solver tokens、proposer tokens、task trials、proposal calls、wall-clock deadline、
并发 slot 和 storage。Actual usage 由 trusted receipt settle；缺 cost price 时 `unpriced_usage > 0`，不能
当零。总预算检查使用已 spent + 已 reserved 的最坏上界，避免并发超卖。

Hard limit denial 产生 event；operator 若要增加预算必须终止当前 run 并创建新 signed manifest。

## 9. RNG and decisions

Run manifest 固定 master seed commitment。每类随机性使用独立 counter stream：split、scheduler
Thompson、task sampler、wave permutation、bootstrap、audit sample。每次 draw 写：

- stream/counter；
- PRNG algorithm/version；
- input population/order/parameters hash；
- raw or sufficient sampled values；
- result。

Replay 读取 receipt，不重新调用 RNG。Secret split stream 由 sealed service 持有；controller 只记录
commitment。任何 state-dependent population 必须先按 candidate full hash 排序。

## 10. Candidate and evaluation evidence

每个 candidate ref 至少指向：source tar、semantic diff、proposal transcript/session、proposal manifest、
build manifest、compiled bundle、capsule、SBOM、scan/unit/Loader/unload/mock receipts。

每个 evaluation ref 至少指向：request/Harbor config、external job ID、逐 trial config/result、ACP events/
summary、ATIF、DSH session log、verifier logs、resource/process/network audit、usage/cost、normalizer receipt。

Evidence catalog 只存小 metadata/ref；proposer 用 `rg`/manifest 定位 object export。不得维护一份手工
摘要代替 raw evidence。

## 11. Data labels and exports

Label 在 object creation 时确定，不能降级。Export service 接收 `(principal, purpose, query)`，对每个
object 验证 policy，materialize immutable directory，并生成：

```json
{
  "exportId": "...",
  "principal": "proposer:<action>",
  "purpose": "candidate-expansion",
  "allowedLabels": ["PUBLIC_SPEC", "DEV_OBSERVED"],
  "objects": [],
  "createdFromStateHash": "...",
  "merkleRoot": "..."
}
```

Export 本身 read-only、action-scoped、带 guard/sealed canary absence receipt。Proposer 不能自行从
`evidence/runs` 复制文件。

## 12. Recovery algorithm

Controller 启动严格按以下顺序：

1. acquire single-writer lock，验证 owner process/lease；
2. 验证 manifest/provenance/split commitments 未变；
3. 验证 journal chain/segments/HEAD；
4. 从有效 snapshot + replay 重建 state；
5. reconcile object refs、budget ledger 和 external job IDs；
6. 对每个 nonterminal action 调 provider inspect；不启动新 action；
7. collect terminal artifacts 或记录 provider-confirmed lost job；
8. 按 reservation seq commit 已完成 wave；
9. 验证 state hash/invariants；
10. 只有 state 可继续且预算/phase 允许时恢复 scheduler。

若同一 blocking inconsistency 连续出现，状态转 `EVIDENCE_CORRUPT/PROTOCOL_INVALID`，不能无限 retry。

## 13. Crash semantics by boundary

| Crash point                             | Resume behavior                                       |
| --------------------------------------- | ----------------------------------------------------- |
| before intent fsync                     | action never existed                                  |
| after intent, before launch             | launch once with same key                             |
| during launch, no receipt               | provider inspect by key before submit                 |
| after external terminal, before collect | collect existing job                                  |
| during object write                     | discard unreferenced staging file                     |
| after collect, before commit            | validate same object then commit once                 |
| after commit, before snapshot           | replay journal; no duplicate                          |
| during candidate lock                   | lock absent unless full atomic transaction committed  |
| after sealed launch                     | reconcile only; never select/reveal another candidate |

## 14. Checkpoints and successor runs

Checkpoint 是 `(runId, seq, eventHash, stateHash, reachableObjectsMerkleRoot)`。Operator stop 先禁止新
reservation，等待/取消当前 wave，flush checkpoint，再退出。

修复 TCB、改变 protocol/budget/split/model 或 invalidated run 后必须创建 successor：

```json
{
  "predecessorRun": "...",
  "forkCheckpoint": "...",
  "reason": "adapter-fix",
  "inheritedCandidateObjects": [],
  "inheritedResultsPolicy": "none | exact-identity-only"
}
```

默认不继承评测结果；只有全部 identity fields 精确相同且修复不影响 execution/scoring 时，经过明确
compatibility proof 才允许。旧 run 永远不改成 green。

## 15. Retention and privacy

- Raw evidence 至少保留到论文/leaderboard claim 可复核期限；删除只通过 retention policy tombstone，
  不重写 journal。
- Secrets 在进入 log/object 前由 trusted source 结构化 redaction；事后 regex 不是主要控制。
- Model content 可能含 task/public source；发布前按 benchmark/license/privacy policy 生成 sanitized export，
  raw store 保持受限。
- `archive catalog` 不含 prompt/model secrets、sealed/guard identity、guard/sealed 衍生统计
  或 credential metadata；proposer 可见统计只从 `DEV_OBSERVED` trial 派生。

## 16. Required tests

- canonical object/tar/JCS hash cross-platform golden；
- torn write、bad HEAD、bad previous hash、missing object；
- duplicate/out-of-order/conflicting worker receipt；
- crash injection at every action boundary；
- external job exists/does-not-exist/unknown reconciliation；
- budget reservation oversubscription and unpriced usage；
- snapshot/full replay equivalence；
- export label/canary noninterference；
- candidate-lock/sealed one-shot irreversible transition；
- 10M-token synthetic evidence tree 的 bounded prompt/index performance。
