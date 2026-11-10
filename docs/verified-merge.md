# Verified Merge

Verified Merge is QAFind's required-check moat: triage the Playwright specs a PR affects, re-run the
failures, and report only **reproduced regressions**. A failure that passes on rerun is a flake and does
not block the merge. The verdict is signed and can be uploaded to QAFind Cloud.

## One-command CI

```bash
QAFIND_SIGNING_KEY=... QAFIND_API_KEY=... \
qafind verify-merge --run --base origin/main --head HEAD \
  --repo owner/repo --pr "$PR_NUMBER" --upload
```

`--run` selects the affected specs from the diff, runs `npx playwright test <specs> --reporter=json`, reruns the
failed spec files once, triages the two reports, signs the verdict and uploads it. Pass `--command` to use a
project-specific command; `{specs}` is replaced by shell-escaped affected paths and the JSON reporter must write
to `PLAYWRIGHT_JSON_OUTPUT_NAME`.

## Real Playwright proof

`examples/verified-merge-demo` runs a real suite through `--run`:

- `regression.spec.ts` fails twice → **1 regression**, exit 1
- `flake.spec.ts` fails then passes → **1 flake**, exit 0

The demo README records the exact commands and results.

## Two-report CI (existing pipelines)

Run the affected Playwright specs with the JSON reporter, then run the same failed specs once more:

```bash
npx playwright test <affected specs> --reporter=json > first.json
# deterministic rerun of the same specs
npx playwright test <affected specs> --reporter=json > rerun.json

qafind verify-merge \
  --base origin/main --head HEAD \
  --results first.json --rerun-results rerun.json \
  --repo owner/repo --pr "$PR_NUMBER" \
  --out .qafind/verified-merge/verdict.json \
  --intoto .qafind/verified-merge/intoto.json \
  --upload
```

Required environment for upload: `QAFIND_API_KEY`. Signing requires `QAFIND_SIGNING_KEY`
(HMAC secret or Ed25519 PEM). The command exits `1` only when a **reproduced regression** is present.

## Result formats

`--results` and `--rerun-results` accept:

- **Playwright JSON** (`.json`)
- **JUnit XML** (`.xml`, or XML detected by content)

JUnit XML is the bridge for Cypress, Selenium, WebdriverIO and most CI runners. The triage is identical:
a test that failed in the first report and passes in the rerun is a flake; one that fails again is a
reproduced regression. No framework-specific special cases.

Detection is automatic; there is no `--format` flag to get wrong.

## What counts

| Result | Meaning | Blocks merge? |
|---|---|---|
| regression | failed on first run and every rerun | yes |
| flake | failed first, passed on rerun | no |
| not rerun | failed but no rerun report supplied | no |
| unreproduced | rerun produced a different non-passing result | no |

The CLI prints a PR-comment Markdown report with `--markdown`, writes a **signed in-toto/DSSE test-result
attestation** with `--intoto`, and supports the same verification through the MCP tool `qafind_verify`.

Verify the attestation offline:

```bash
qafind verify-intoto .qafind/verified-merge/intoto.json --json
```

The DSSE payload is the in-toto Statement v1; the signature is HMAC-SHA256 or Ed25519. Tampering with the
payload or presenting it under the wrong type fails verification.

## Integrations

Verified Merge completion can post to Slack or any HTTPS endpoint. See [webhooks.md](webhooks.md).

## Required check

See [branch-protection.md](branch-protection.md). The context is `QAFind Verified Merge`; the server posts a
native check run when the App has `checks: write`, otherwise the equivalent commit status.

## Status

Implemented: affected-spec selection from the git diff, Playwright JSON ingest, deterministic triage,
signed verdict, cloud ingest, in-toto export, MCP offline verify, and GitHub commit status + one idempotent
PR comment from the uploaded report. The status context is `QAFind Verified Merge` and can be required
in branch protection. A GitHub *check run* additionally needs the App's `checks: write` permission; the
current App uses the commit-status API (`statuses: write`).

Next: optional `--run` so the CLI executes Playwright itself; the current flow relies on the customer's CI
to produce the two JSON reports.
