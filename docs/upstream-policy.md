# DSH upstream and compatibility policy

`dsh-self-evolving` has two deliberately separate DSH channels.

## Reproducible installation channel

`pnpm setup:source` automatically downloads DeepSeek Harness at the exact commit in
`provenance.lock.json`. Users do not install DSH manually, and a project tag always resolves to the same DSH source,
lockfile hash, package versions, and acceptance evidence.

The default installer never follows a moving branch or `latest` alias. Silent upgrades would make one release tag
non-reproducible and would invalidate Loader, sandbox, provider, and benchmark evidence.

Check whether the accepted pin is still upstream HEAD with:

```bash
pnpm dsh:latest:check
```

## Latest compatibility channel

The scheduled `dsh-latest-compatibility` GitHub workflow checks out current upstream DSH `HEAD` in an ephemeral
runner. It builds DSH and this project, then runs typecheck, unit tests except the intentional pin-identity guard,
and no-key real Loader/E2E tests.

A green latest-compatibility run means the current project source is compatible with the tested DSH commit. It does
not change the accepted pin and does not retroactively rebind a release.

## Promoting a new DSH pin

When upstream advances:

1. run or inspect the latest-compatibility workflow;
2. create a successor branch that updates the DSH commit, lockfile digest, and package-version records;
3. run the full normal CI, real-provider checks when affected, and fresh source-release installation;
4. review behavior and security changes, then merge the upgrade PR;
5. publish a successor project release with new receipts and hashes.

An incompatible latest workflow is evidence to investigate, not permission to weaken tests or silently retain a
partial installation.
