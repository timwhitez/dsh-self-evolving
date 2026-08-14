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
          +--> self-contained DSH ACP capsule --> Harbor --> Terminal-Bench verifier
          |
          +--> fail-closed normalizer --> frozen DEV archive --> next generation
```

The controller is the single writer. Proposer inputs are read-only, label-filtered development evidence; only its
child output root is writable. Provider credentials remain in the trusted host and never enter the proposal sandbox.
Candidates run through the real Cordis Loader inside one-shot evaluation containers, not inside the controller.

The filesystem is authoritative. Journal replay reconstructs Archive, lineage, actions and observations; indexes and
status output are derived. Every external evaluation has a durable intent and idempotency key before launch. Resume
inspects the provider before deciding whether launch is permitted.

The stable demo deliberately stops at engineering proof. Optional K=10/K=80, sealed confirmation and full-set
profiles use fresh lineages after v0.1 and retain the stricter protocols in `specs/`.
