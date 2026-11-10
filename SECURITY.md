# Security policy

## Reporting a vulnerability

Email security@qbrin.cloud with steps to reproduce and the affected version. Do not open a public issue.
We aim to acknowledge within two business days.

## Scope

This repository contains the local/CI CLI. The hosted service at qbrin.cloud is operated separately and is
not part of this repository. Please do not test against systems you do not own or have permission to test.

## Expectations

- Hosted runs use stand-in credentials; real secrets must never be placed in the test browser.
- Request policies cover browser-context and proxy requests, not an operating-system firewall.
- Evidence signatures prove integrity and signer key possession, not that the tested application is correct.
