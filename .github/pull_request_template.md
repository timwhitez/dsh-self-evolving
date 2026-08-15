# Pull request

## Objective

Describe one bounded change and its acceptance condition.

## Evidence

- Tests added or updated:
- Commands run:
- Artifacts or hashes:
- Paid-provider tests: not run / run (never include credentials or provider bodies)

## Claim boundary

State what this change verifies and what it does not verify.

## Checklist

- [ ] I added or updated the failing contract test before the repair.
- [ ] Format, lint, typecheck, unit, E2E, provenance, upstream-clean, byte-equality, and release checks pass.
- [ ] DSH, Harbor, and Terminal-Bench pinned upstreams remain clean.
- [ ] No credential, private state, reasoning text, provider body, candidate artifact, or concealed data is included.
- [ ] Public docs, schemas, changelog, migration notes, and ADRs are updated where required.
- [ ] I preserved predecessor evidence and created a successor for semantic changes.
