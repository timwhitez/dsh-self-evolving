# Security policy

## Supported versions

| Version        | Supported           |
| -------------- | ------------------- |
| `0.2.x`        | Yes                 |
| `0.1.x`        | Critical fixes only |
| Older versions | No                  |

The default branch receives security fixes first. Affected evidence is preserved and superseded by a versioned
successor; it is never silently rewritten.

## Report a vulnerability privately

Do **not** open a public issue for:

- credential, token, or private provider-response exposure;
- proposal-sandbox escape or arbitrary candidate write;
- sealed/concealed evaluation-data disclosure;
- provider replay, idempotency, journal, or budget-integrity flaws;
- release provenance, archive, or dependency-supply-chain compromise.

Use GitHub's **Report a vulnerability** / private security advisory channel for this repository. If that channel is
unavailable, contact a maintainer privately through their GitHub profile. Do not include a live secret; redact it and
describe its type, scope, and exposure window.

Include, when safe:

- affected version and commit;
- minimal reproduction or malformed artifact;
- security boundary crossed;
- whether credentials or concealed evaluation data may have been exposed;
- logs with secrets, model bodies, trajectories, and task identities removed.

## Response process

Maintainers will acknowledge a complete report, preserve relevant evidence, classify the affected authority, and
prepare a versioned fix. Credential revocation or external disclosure occurs only through the authorized owner. A
public advisory will describe impact and remediation without exposing secrets or sealed data.

## Security model

Candidate code is untrusted. It must run only through the documented one-shot process/container boundary; `node:vm`
and in-process dynamic loading are not security boundaries. Provider credentials remain in the trusted host and must
not enter candidates, sandboxes, prompts, durable evidence, command lines, or Git.

This project does not authorize financial trading or real-world order execution.
