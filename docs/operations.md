# Operations: stop, backup, restore, rollback and uninstall

## Stop

Send `SIGTERM` to the foreground CLI process and wait for Harbor children to exit. If forced termination is needed,
preserve the state and external evaluator directories; use `resume`, not a new `run` command.

## Backup and restore

Stop the writer, then archive the private state while retaining modes:

```bash
tar --numeric-owner -C /var/lib/dsh-rsi-controller -czf /root/dsh-rsi-state-backup.tgz RUN_ID
mkdir -m 0700 /var/lib/dsh-rsi-controller/RESTORED_RUN_ID
tar --numeric-owner -C /var/lib/dsh-rsi-controller -xzf /root/dsh-rsi-state-backup.tgz
```

Restore to the same absolute state path because schema v9 binds `stateDir`. Run `status` and `audit` before any
resume. Never merge two state directories.

## Release rollback

Reinstall the previous source archive in a new checkout, bootstrap its pinned upstreams, then point operations back
to the prior untouched state directory. Do not run older code against state created by a newer config schema unless
that release explicitly supports it.

## Uninstall

Stop active controllers. Remove only the installed source checkout and generated package store selected by the
operator. Private run state under `/var/lib/dsh-rsi-controller` is evidence and must be backed up before deletion;
the project never deletes it automatically.
