# Documentation

This index separates normative specifications, operator guidance, evidence, and historical records. Start with the
short path that matches your task.

## Get started

| Document                              | Use it for                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| [Quickstart](quickstart.md)           | Supported environment, source setup, first run, resume, and effectiveness check |
| [Configuration](configuration.md)     | Frozen profiles, limits, provider route, credentials, and state schemas         |
| [Troubleshooting](troubleshooting.md) | Fail-closed diagnoses and safe recovery                                         |

## Understand the system

| Document                                          | Use it for                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [Architecture overview](architecture-overview.md) | Controller, proposer, builder, Loader, evaluator, and evidence flow                                     |
| [DSH integration](dsh-integration.md)             | Source-verified Cordis and Loader contracts                                                             |
| [Research basis](research-basis.md)               | Papers, prior systems, adopted mechanisms, and corrected assumptions                                    |
| [Architecture decisions](decisions.md)            | ADRs and trade-offs                                                                                     |
| [`specs/00`–`specs/07`](../specs/)                | Normative product, architecture, candidate, algorithm, evaluation, safety, evidence, and gate contracts |

## Operate and audit

| Document                                                | Use it for                                                |
| ------------------------------------------------------- | --------------------------------------------------------- |
| [Operations](operations.md)                             | Stop, backup, restore, rollback, and uninstall            |
| [Evidence guide](evidence-guide.md)                     | What each receipt proves and does not prove               |
| [Terminal-Bench runbook](terminal-bench-2.1-runbook.md) | Harbor/TB integration and optional benchmark profiles     |
| [Project status](../PROJECT_STATUS.md)                  | Current accepted state, quarantines, and claim boundaries |

## Releases and migration

| Document                                    | Use it for                                                        |
| ------------------------------------------- | ----------------------------------------------------------------- |
| [v0.2 release gates](v0.2-release-gates.md) | Current provider, effectiveness, and release acceptance           |
| [v0.2 migration](migration-v0.2.md)         | Renamed packages, CLI, protocols, paths, and predecessor evidence |
| [Phase checklist](phase-todolist.md)        | Completed and optional post-release work                          |
| [Audit index](audits/README.md)             | Versioned gate and incident evidence                              |
| [Changelog](../CHANGELOG.md)                | User-visible changes by release                                   |

## Document authority

When records conflict, use this precedence:

1. frozen run manifest and content-addressed receipts;
2. normative files in `specs/`;
3. operational documents in `docs/`;
4. README and historical discussion.

Historical audits intentionally retain predecessor names, paths, failures, and claim wording. Do not modernize them
in place; add a successor record.
