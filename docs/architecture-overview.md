# Architecture overview

The product path is one bounded pipeline:

```text
versioned config + doctor
          |
          v
durable Cordis controller ---- hash-chain journal + budget ledger
          |
          +--> networkless proposer -- Unix socket --> locked compatible provider
          |
          +--> trusted candidate builder --> immutable candidate identity
          |
          +--> self-contained DSH ACP capsule --> Harbor no-network agent
          |                                      |
          |                                      +-- Unix socket --> per-trial host broker
          |                                                          |
          |                                                          +--> official provider
          +------------------------------------------------------------> Terminal-Bench verifier
          |
          +--> fail-closed normalizer --> frozen DEV archive --> next generation
```

The controller is the single writer. Proposer inputs are read-only, label-filtered development evidence; only its
child output root is writable. Provider credentials remain in the trusted host and never enter the proposal sandbox.
Candidates run through the real Cordis Loader inside one-shot evaluation containers, not inside the controller.

The evaluation capsule contains a fixed Unix-gateway client, not the provider adapter. Harbor receives neither a key
nor a secret mount. Each task/attempt has its own broker, request budget and signed receipt; the copied development
task binds original/overlay digests and runs every agent phase with direct HTTPS disabled. Setup networking is used
only to build the task image and fetch the content-addressed ACP archive.

The filesystem is authoritative. Journal replay reconstructs Archive, lineage, actions and observations; indexes and
status output are derived. Every external evaluation has a durable intent and idempotency key before launch. Resume
inspects the provider before deciding whether launch is permitted.

The stable demo deliberately stops at engineering proof. Optional K=10/K=80, sealed confirmation and full-set
profiles use fresh lineages after v0.1 and retain the stricter protocols in `specs/`.
