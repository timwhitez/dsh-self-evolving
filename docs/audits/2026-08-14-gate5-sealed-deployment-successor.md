# Gate 5 sealed deployment successor — 2026-08-14

**Status:** `SEALED_DEPLOYMENT_AND_SPLIT_ACCEPTED`; `GATE_5_NOT_ACCEPTED`
**Sealed access count:** 0
**Candidate lock:** not created

## Runtime closure and deployment

The sealed worker now imports the split and calibration primitives through narrow package exports.
The production closure contains only the sealed worker plus `split.js`, `calibration.js`, and
`rng.js`; it contains neither `@dsh-rsi/core` nor Cordis. A deployment-closure E2E boots that exact
minimal file set and performs a 48/12/29 ceremony.

The immutable root-owned release is
`/opt/dsh-rsi-sealed/releases/0361fc9f59d481ff8085b46039917cb3c085fd05d28c3db42aaac637372b4585`.
All directories are mode 0555 and files mode 0444. `/opt/dsh-rsi-sealed/current` points to that
release. `SHA256SUMS` verifies every runtime file and its own SHA-256 is
`0361fc9f59d481ff8085b46039917cb3c085fd05d28c3db42aaac637372b4585`.

The worker runs as the system principal `dsh-rsi-sealed` (UID 986). Its store is
`/var/lib/dsh-rsi-sealed`, owned by that principal and mode 0700. A synthetic deployment smoke
proved restart idempotence, mode-0600 private state, mode-0644 public receipts, non-service UID
read refusal, single-writer contention refusal, and no-replace refusal after public-receipt tamper.

## Concealed TB 2.1 split

Ceremony `gate5-tb21-20260814-v1` binds:

- dataset digest `sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a`;
- inventory bytes `sha256:e35d8d8d3263e49e4289af0be57ea411c8f6e129e331df66ecdf52443c6e421a`;
- protocol hash `sha256:54733df61a0d51eeed02d81d9fbae045b198c0299e14e169ed68b2d2ad87f91d`;
- runtime/splitter hash `sha256:0361fc9f59d481ff8085b46039917cb3c085fd05d28c3db42aaac637372b4585`;
- Merkle root `sha256:5ae3c9acf3e2a05520274e74ab6e906dac653fe42a5c2fd609d31f44bb8b44b7`.

The committed controller view is [`evidence/gate5/split-commitment.json`](../../evidence/gate5/split-commitment.json),
whose source receipt hash is
`sha256:a9b34865c4f13022a952d98c6d7bdd2ba84cf8ad459f3abb6fd418d641eae940`.
It exposes 48 observed IDs, 12 opaque guard handles, and only the sealed count 29. It contains no
seed, assignment, guard identity, or sealed identity. UID 65534 cannot read the private state.

## Remaining Gate 5 boundary

Gate 5 remains not accepted. No real 60-task x 2-attempt baseline or real three-candidate strata
calibration exists yet, so cost/wall/concurrency and the formal budget cannot be frozen. Historical
nop calibration remains quarantined. The formal split is minted but deliberately not candidate-
locked before the Gate 7 search.
