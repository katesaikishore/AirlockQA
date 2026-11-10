# Changelog

## 2.1.0

- `qafind hunt`: audit an existing Playwright suite for unawaited assertions, assertion-free tests, fixed waits, focused tests and tracked skips.
- `qafind dedupe`: check a candidate against GitHub issues/PRs before filing.
- `qafind verify`: record failing-repro / fixed-success evidence.
- Hunt now ignores Vitest, Jest, Testing Library and `node:test` files so it does not emit Playwright-only false positives.

## 2.0.0

- **Renamed to QAFind** (qafind.si). Breaking: the CLI is now `qafind` (the `airlock` command is gone), the npm package is `qafind`, the config file is `qafind.config.json`, the output directory is `.qafind/`, environment variables are `QAFIND_*` (e.g. `QAFIND_API_KEY`), and MCP tools are `qafind_*`.
- GitHub Action: `uses: katesaikishore/QAFind@v2`. The hosted API is `https://api.qafind.si`.

## 1.2.2

- Marketplace badge colour is now blue to match the QAFind brand.

## 1.2.1

- `qafind --version` reads the package version instead of the stale 1.0.0 literal.

## 1.2.0

- `verify-merge` runs affected specs, reruns failures, and blocks only reproduced regressions.
- Signed Verified Merge verdicts and in-toto/DSSE attestations; `verify-intoto` offline verification.
- Public MCP `qafind_verify` tool.

## 1.1.0

- `attach` for existing Playwright suites; writes reporter manifests without changing specs.
- `flake` triage over reporter manifests, including request-ledger evidence.
- Published attach/flake docs.

## 1.0.0

Initial public CLI release.
