# Security policy

## Supported version

Security fixes are accepted for the latest v0.1 release candidate and the default branch.

## Reporting

Do not open a public issue for a credential leak, sandbox escape, sealed-data disclosure, provider replay flaw or
arbitrary candidate write. Use the repository host's private security advisory channel after publication. Until a
public host exists, contact the maintainer privately through the channel used to obtain this source.

Include the affected commit, minimal reproduction and whether credentials or concealed evaluation data were exposed.
Do not include live secrets. The maintainer will preserve evidence, revoke exposed authority when authorized, and
publish a versioned successor rather than overwrite the affected artifact.

This project never authorizes real financial orders. Candidate code is untrusted and must not be run outside the
documented one-shot isolation boundary.
