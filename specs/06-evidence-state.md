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
  "mediaType": "application/vnd.dsh-self-evolving.trajectory+json",
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

Journal protocol v1 在 append 与 replay 边界都验证完整、无扩展字段的 envelope。每个 event 必须包含
固定 `schemaVersion: 1`、与 journal 配置相同的非空 `runId`、正 safe-integer `seq`、非空
`eventId/type/actor`、canonical ISO timestamp、nullable 但非空的 causation/correlation ID、JSON object
payload，以及严格的 SHA-256 previous/event hash。持久化 event 必须是单行 canonical JSON；重复 key、空行、
未知字段、非 canonical number 或非法 segment 文件名均 fail closed。HEAD 本身使用同一 protocol/run binding，
完整字段为 `schemaVersion/runId/seq/eventHash/segment`，并通过 seq/hash/segment 精确引用已验证的 tail event。

`segmentMaxBytes` 必须是正 safe integer，并按持久化 canonical event 加换行后的 UTF-8 byte length 执行。
若下一条完整 record 会使当前非空 segment 超过上限，writer 必须先以 exclusive-create 打开下一个 canonical
segment；恰好等于上限时不得提前 rotate。单条 record 自身超过上限时不得拆分，它独占一个 segment，下一条
append 再 rotate。已有的目标 segment、空或非 regular 的 active segment 均视为损坏并 fail closed。

Journal v1 的 commit point 是经原子发布的 `HEAD`，不是 segment fsync。Reader 只验证并 replay 到 `HEAD`
精确指定的 `(seq, eventHash, segment)`；同一 segment 中该 record 之后的 bytes、后续 canonical segment，
以及没有 `HEAD` 时的 segment/`HEAD.tmp` 都是 uncommitted crash residue，绝不能隐式 roll forward。Writer 在
下一次 append 前先把 residue 以 content hash 身份写入 `crash-residue/` 并 fsync，再截断 active suffix 或移走
后续文件；已提交 prefix 的任一 byte 不匹配则 fail closed。新 segment 的 directory entry 必须在 HEAD
发布前 fsync。这样在 segment write/file-fsync/directory-fsync、HEAD staging write/fsync、HEAD rename 或
directory fsync 任一边界中断，重启只会得到旧 prefix 或完整的新 tail。

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

文件发布与 controller acknowledgement 是两个 durable phase。Proposal/mechanism-outcome 先以同目录
staging file 写入并 fsync，再用 no-clobber 原子发布并 fsync parent directory；无论结果是 `CREATED` 还是
`REUSED`，都必须完整验证 artifact 后调用 reconciliation。Reconciliation identity 固定包含 artifact kind、
action/idempotency key、精确 artifact byte digest，以及 domain-separated reconciliation ID。Controller 以该
reconciliation ID 作为 immutable journal `eventId` 执行 `recordOnce`：相同 ID/相同 canonical event 返回
`REUSED`，相同 ID/不同内容 fail closed。回调入口、回调执行中或 event commit 后崩溃，resume 都必须收敛为
一个 semantic event；不得因 artifact 已存在而跳过 reconciliation，也不得重复 model/provider action。

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

Budget accounting protocol v1 使用固定精度：USD 的 ledger/API 数值必须精确映射到非负 safe-integer
micros（最多六位小数），token、trial、call、wall-clock second、concurrency slot 与 storage byte
必须是非负 safe integer；所有 limit 使用相同域。Replay 必须 runtime-validate entry 的完整且无扩展字段的
schema（seq、kind、dimension、actionId、amount、canonical ISO timestamp、hash chain），以整数单位执行
每一步运算，并在接受下一项前检查 action/global reserved、spent 和 `spent + reserved` 均非负、未溢出且
不超过冻结 limit。`refund` 是 `spend` 的逆向转移（spent 回到 reserved），且不得超过该 action 已 spent
余额。任何 schema、精度、余额或算术不变量失败都属于 `EVIDENCE_CORRUPT`，不得写入修复记录或继续运行。

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

每个本地 untrusted execution 的 resource receipt 至少绑定版本化 policy id 与 digest、完整 limits、
cgroup/rlimit/writable-mount enforcement、memory/PID/CPU/I/O/storage peak 与 event counters、exit/signal 以及
唯一 termination cause。receipt 缺失或控制通道损坏不能解释为正常完成；成功 publication 必须把 receipt
与 proposal/build/admission artifact 一起内容绑定，失败路径也必须保留可审计诊断。
`sandbox` enforcement 还必须明确记录 target 位于 supervisor 下级私有 PID namespace；capability drop
不能替代该隔离，因为单 UID user namespace 内的同 UID target 仍可能影响可信 supervisor/control channel。
成功收据还必须由 verifier 重放完整结构与语义：冻结 policy/mount 精确相等，storage peaks 非空且不越界，
limit events 为零，termination 为 `COMPLETED`、exit 为 0 且 signal 为空。仅重算 digest 或 candidate id
不足以恢复/审计成功。长期运行服务的 one-shot probe 必须走可信正常停止协议，让 supervisor 先发布
control receipt；主动杀整个 cgroup 只能记录失败。proposal 的 resource receipt digest 是 materialization
receipt 的 required 顶层字段，cache 和正式 audit 必须同时验证 receipt bytes、语义与 digest binding。
proposal execution 使用 manifest-last commit：manifest 精确绑定 worker output、resource receipt、gateway
receipts 和 diagnostic。child export 后但 manifest 前的任何崩溃都只能留下 quarantined residue，不能成为
resume authority。导出文件与 staging 目录树必须先 fsync，原 tree → backup、staging → active 和 backup
删除的每个 rename/remove 边界都必须 fsync parent；只有随后才可提交 execution manifest。已提交 manifest
若与安装 worker/tree 缺失或 digest 漂移，必须把两侧一起移入 `incomplete-executions/` 后从 immutable parent
重放；rename 中断留下的随机 staging/backup 目录也必须移入同一去权 namespace，不能永久卡住 action 或
形成隐形 active tree。materialization cache 只能把完整 fsynced staging inode 以 no-clobber link 发布，随后
fsync action directory；不得直接在最终 authority path 写入。cache 已存在但 JSON/CAS/execution/worker/tree
任一侧损坏时，必须在 cache adoption 前把 cache、execution 与 child 一起隔离，同时保留 durable gateway
request store 供确定性重放。active cache 在 adoption 全程必须是 regular single-link inode；存在外部 hard-link
alias 时不得规范化后采用，隔离留存必须复制为新的 fsynced inode 后删除 active name。staging path 无法检查或
清理也必须使 publication fail closed。publisher 必须持有 directory/staging descriptor，cleanup 后验证请求目录
仍是同一 dev/inode、final path 仍是 staged 的 stable single-link inode 且 bytes 未变，再 fsync held directory 并
重复验证；目录替换或 final name 删除必须失败。materialization wrapper 必须无扩展字段，并与 content-addressed receipt/analysis bytes、
stable proposal artifact digest 交叉验证。candidate staging claim 在最终 rename 前清除且 fsync；rename 后
fsync parent directory，正式 candidate root 不得携带 live claim marker。
稳定 proposer 的 proposal/resource/gateway/idempotency bundle 服从同一规则：manifest 必须先在 staging
完整写入并 fsync，再以 no-clobber link 发布并 fsync parent；不得直接写最终 marker。provider request 的
pending record 必须在调用 provider 前完成 file + directory fsync，completion 必须用 fsynced temp + rename +
directory fsync。durable request store 的首次父目录也必须持久化。正式 audit 必须读回 bundle 的精确 inventory、
proposal/journal/idempotency binding 与 resource receipt 完整语义，不能只数 proposal event 或相信 digest。
gateway receipt 还必须把 route hash 重新绑定到冻结 provider/endpoint/model/reasoning/max-token tuple，并逐字段
验证非空 request identity、transport attempt index/status/retry/ambiguity/usage/response id 与非空 error；合法
hash 格式、任意数组或空字符串都不是 authority。完成 proposal 的每个 request id 必须具有成功终态；仅
retryable failure 可被后续 receipt 接续，2xx/non-retryable 终态后不得出现额外 attempt/receipt。该规则必须
同时在 stable bundle audit 与 V011 execution load/binding/final audit 重放，不能仅绑定 receipt count。
V011 final audit 必须先对 active action namespace 中的 manifest-committed execution 与 materialization 做严格
一一 inventory，再枚举每一个 `proposal.completed` action 并重放其 materialization、resource、gateway、
worker-output/tree 与 journal binding；额外 committed execution、缺 execution 的 materialization、后续 build
rejection 或未进入最终三代都不能逃过审计。`incomplete-executions/` 下的留存 bytes 已显式去权，不属于 active
inventory，但必须继续作为 crash/corruption evidence 保留。inventory 和 semantic replay 必须来自同一份
direct-action scan；quarantine subtree 不得被第二次递归选中，active symlink/hardlink/special entry 必须产生明确
拒绝原因。

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

Gate 8 的最终 verifier 只能消费 trusted store 中实际存在的 versioned artifact bytes。Bare digest、caller
boolean 或同一 caller 可重算的 envelope commitment 不证明 provenance。Candidate lock/reveal、sealed/full
journal/action replay、official/local verification 和 release receipts 必须由 verifier 读取、重算、交叉绑定并
验证外部 authority；在这些 schema 与 producer 尚不存在时，acceptance API 必须 fail closed。

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
