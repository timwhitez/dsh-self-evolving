# v0.2 migration to dsh-self-evolving

v0.2 renames every live product-facing identity from `dsh-RSI` / `dsh-rsi` to `dsh-self-evolving`:

| Surface              | v0.2 identity                                |
| -------------------- | -------------------------------------------- |
| npm scope            | `@dsh-self-evolving/*`                       |
| CLI                  | `dsh-self-evolving`                          |
| Cordis service       | `ctx.selfEvolving`                           |
| core package         | `@dsh-self-evolving/core`                    |
| protocol             | `dsh-self-evolving-candidate-tree-v2`        |
| evidence MIME prefix | `application/vnd.dsh-self-evolving.*`        |
| private state root   | `/var/lib/dsh-self-evolving-controller`      |
| source identity      | `.dsh-self-evolving-source-identity.json`    |
| source archive       | `dsh-self-evolving-v<version>-source.tar.gz` |

Package directories carrying the former project prefix are likewise renamed to `packages/dsh-self-evolving*`.
Environment variables use the `DSH_SELF_EVOLVING_` prefix.

The rename is a fresh-lineage boundary. Existing v0.1/v0.1.1 state, capsules, journal events, protocol strings,
absolute paths, hashes and audits are not rewritten or upgraded in place. They remain valid predecessor evidence
under their original names. Start v0.2 with a new run ID and a new state directory.
