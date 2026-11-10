# QAFind OSS audit report

Use this template for a consented, read-only audit. Do not publish a report without the maintainer's approval.

## Header

| Field | Value |
|---|---|
| Repository | `owner/repo` |
| Commit | full SHA |
| Pull request / branch | link or ref |
| Audit date | ISO date |
| QAFind version | `qafind --version` |
| Consent | link to maintainer approval or issue comment |
| Environment | OS, Node/Bun, Playwright version, browser projects |
| Scope | affected specs, full suite, or selected CI runs |

## What was run

```bash
# exact command
```

- First run: Playwright JSON report attached
- Rerun: failed spec files only
- No repository secrets or private data accessed

## Verdict

| Result | Count |
|---|---|
| Reproduced regressions | 0 |
| Flakes (failed first, passed on rerun) | 0 |
| Unproven (not rerun / unreproduced) | 0 |
| Passed | 0 |

**Blocking verdict:** PASS / FAIL

## Finding

### Finding 1 — short title

- Test: `path/to/spec.ts :: test title`
- First run: failed
- Rerun: failed
- Classification: **regression**
- Evidence: signed verdict, in-toto statement, CI run link, trace/video (redacted)
- Minimal reproduction:
  ```bash
  npx playwright test path/to/spec.ts --project=chromium
  ```
- Suspected cause: observable facts only; no speculation without evidence

Repeat for each reproduced regression or flake worth reporting.

## Signed evidence

| Artifact | Value |
|---|---|
| Verdict SHA-256 | `…` |
| Signature algorithm | HMAC-SHA256 / Ed25519 |
| Signing key ID | `…` |
| in-toto DSSE | path or URL |
| Verify command | `qafind verify-intoto <file> --json` |
| Public report | URL, only with approval |

## What this report does not prove

- It does not prove the application is correct.
- It does not prove every failure is caused by this PR.
- It does not cover tests outside the stated scope.
- It does not reproduce third-party service outages.

## Suggested next step

- [ ] Maintainer reviews the finding
- [ ] If wanted, QAFind prepares a minimal fix PR
- [ ] No required check or repo file is added without permission

## Footer

QAFind is MIT-licensed: https://github.com/katesaikishore/QAFind. If this audit was useful, a star helps other maintainers find it — optional, never a condition of the work.
