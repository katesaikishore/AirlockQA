# Attach and flake: trustworthy signal from the suite you already run

This is the P0 attach path behind the positioning in [docs/positioning.md](positioning.md): an existing
Playwright suite keeps its specs, config and CI. Two commands make its signal triageable:

- `airlock attach` writes a wrapper Playwright config that appends the Airlock reporter to the suite's
  existing reporters. It never edits the original config or a spec.
- `airlock flake` aggregates the reporter manifests across runs and reports per-test instability,
  probable cause, owner and quarantine recommendation.

Nothing in this path needs an Airlock Cloud account. It is local, MIT licensed, and reads only files
under the project.

## Attach in about ten minutes

From the root of an existing Playwright project:

```bash
bunx airlockqa attach . --determinism   # wrapper + reporter + replay/clock shim
AIRLOCK_ATTACH_NETWORK=record npx playwright test --config .airlock/playwright.airlock.config.ts
AIRLOCK_ATTACH_NETWORK=replay npx playwright test --config .airlock/playwright.airlock.config.ts
npx airlockqa flake .airlock/reports --markdown
```

`attach` writes:

| File | Purpose |
| :--- | :--- |
| `.airlock/playwright.airlock.config.ts` | Wrapper config: imports your original config, preserves its reporters, appends the Airlock reporter, and (with `--determinism`) points at the generated tsconfig alias. |
| `.airlock/attach.json` | What was attached, where, and the reporter output directory. |
| `.airlock/airlock-test.ts` | `--determinism`: re-exports Playwright's `test` extended with Airlock's auto-use fixtures; a tsconfig path alias maps `@playwright/test` here. |
| `.airlock/tsconfig.airlock.json` | `--determinism`: the path alias (extends the project tsconfig when present). |

Your original `playwright.config.*` is read, never written. Keep it in CI by changing one command:
`npx playwright test --config .airlock/playwright.airlock.config.ts`. Commit the two generated files if
CI should reuse the wrapper; re-run `attach --force` when the base config changes.

### What the wrapper handles

Playwright resolves config-relative paths against the directory of the config file it loads. Because
the wrapper lives in `.airlock/`, the generated config rebases `testDir`, `outputDir`, `snapshotDir`,
`tsconfig`, `globalSetup`, `globalTeardown` and project-level paths back onto the base config's
directory. Without that rebase Playwright would find no tests.

The wrapper preserves a reporter given as a string, a single `[name, options]` tuple, an array, or a
class. The Airlock reporter entry is appended as a module specifier; Playwright 1.65 requires reporter
entries to be `[name, options]` and crashes on a class instance.

Relative reporter module paths, `use.storageState` and `webServer.cwd` are now rebased too:
`storageState` and `webServer.cwd` are made absolute (Playwright resolves them against the process
cwd), and relative reporter module paths are rebased to the base config directory. Base reporter
options are preserved verbatim, so a relative output path inside a base reporter option is still
relative to `.airlock/`; WebSockets and service workers are not recorded.

### Determinism without touching specs (`--determinism`)

`--determinism` generates a tsconfig alias + auto-use fixture shim. Existing specs keep
`import { test } from '@playwright/test'`; the alias resolves that import to the shim for the wrapper
run, and the fixture:

- records every http(s) request/response into `.airlock/network/<test-hash>.json` with
  `AIRLOCK_ATTACH_NETWORK=record`;
- replays it byte-for-byte with `AIRLOCK_ATTACH_NETWORK=replay` (and fails loudly if a fixture is
  missing, instead of silently going to the network);
- installs Playwright's fixed clock before navigation (`AIRLOCK_ATTACH_CLOCK=fixed`, default enabled;
  `AIRLOCK_ATTACH_TIME` chooses the instant; `off` disables it);
- writes a request ledger to `.airlock/ledgers/<test-hash>.json` and attaches it to the test result.

The demo in [`examples/attach-demo`](../examples/attach-demo) proves this end to end: the record run
starts the local store, then the replay run **disables the web server** and still passes the page
document/navigation test from the fixture; the clock test asserts the frozen instant. The record and
replay runs produce the same pass/fail set.

Limits: WebSockets and service workers are not recorded, redirects are captured as final responses,
and the fixture directory must be committed or cached for CI to replay. The path alias replaces the
project's `compilerOptions.paths` with a merge of the existing map plus `@playwright/test`; unusual
tsconfig inheritance may need a manual look.

## The manifest

The reporter writes one JSON file per run: `.airlock/reports/<runId>.json`. The format is defined in
[`src/testing/airlock-report.ts`](../src/testing/airlock-report.ts):

- run: version, tool, runId, start/finish/duration, cwd, project names;
- test: stable id (`project::file::title path`), title path, file, project, status
  (`passed | failed | skipped | timedOut | interrupted`), retries, duration, error messages, and
  attachment metadata only (name, path, content type).

No request bodies, headers, cookies, storage state or credentials are recorded by the reporter. A
truncated manifest from a killed CI job is ignored by `flake`.

## `airlock flake`

```bash
airlock flake [path]                       # path defaults to .airlock/reports
  --json                                   # machine-readable stdout
  --markdown                               # PR-comment report
  --min-runs <count>                       # default 1
  --threshold <0..1>                       # default 0.2
  --owner-map <file>                       # JSON object: test id or file → owner
  --quarantine <file>                      # write quarantine JSON
  --fail-on-flake                          # exit 1 when any test is flaky
```

The terminal output shows runs, flakes, probable cause, confidence, owner and quarantine. Markdown is
deterministic (no timestamps), so a PR comment changes only when the evidence changes.

### Evidence: error text + request ledger

When `--determinism` is attached, flake automatically reads `.airlock/ledgers/` and marks causes as
`request-ledger` evidence: a recorded transport failure confirms `network_fixture` (and can reclassify
an ambiguous timeout), a clean ledger with real traffic contradicts a network label, and a silent
ledger (no browser traffic) leaves the error-text confidence alone. The Markdown report adds a
`Request-ledger evidence` section; JSON includes `evidenceTier` and the ledger counts.

### Classification

Classification is a deterministic priority over the recorded error text:

| Cause | Typical signal |
| :--- | :--- |
| `network_fixture` | `net::`, `ERR_`, `ECONN`, request failed |
| `policy_block` | policy / safety-door / blocked |
| `selector_drift` | locator, waiting for selector, strict-mode violation |
| `timing` | timeout without a selector/locator context |
| `app_race` | assertion/expect mismatch, or an application 5xx |
| `unknown` | no recorded evidence matched |

A test is **flaky** when it has failed at least once and also passed (including after a retry). Stable
failures are reported and classified but never quarantined. Owner lookup uses the exact test id first,
then the file; `--quarantine` writes only recommendations. Evidence fragments are quoted and
credentials are redacted.

**Classification is still a recommendation, not replay-proven causality.** It is deterministic text
matching plus optional request-ledger evidence; a ledger can confirm transport failures, not prove why
an application assertion flipped. Verify before deleting or quarantining a test.

The reproducible benchmark harness is [`scripts/flake-bench.ts`](../scripts/flake-bench.ts): it
generates a seeded 400-test × 5-run suite with known causes (including missing error text) and measures
per-class precision/recall before and after ledger evidence. Latest synthetic baseline: 87.8% error-text
accuracy, 90.3% with ledgers, per-cause precision 100% for the classified causes. It also accepts
`--reports <dir> --labels <labels.json>` to measure a **real** suite; that customer number is the one to
publish, and the repository does not substitute the synthetic number for it. See
[docs/flake-benchmark.md](flake-benchmark.md).

### Example output

The runnable demo in [`examples/attach-demo`](../examples/attach-demo) seeds one flake per round across
three rounds; the stable failure is not quarantined:

| Test | Runs | Flakes | Cause | Quarantine |
| :--- | ---: | ---: | :--- | :--- |
| cart fixture returns totals | 3 | 1 | `network_fixture` | yes |
| login selector exists | 3 | 1 | `selector_drift` | yes |
| slow recommendations endpoint | 3 | 1 | `timing` | yes |
| known checkout total mismatch | 3 | 3 | `app_race` | no |
| pricing copy is stable | 3 | 0 | `unknown` | no |

## CI wiring

```yaml
- name: Attach reporter and run suite
  run: npx playwright test --config .airlock/playwright.airlock.config.ts
- name: Triage flakes
  if: always()
  run: npx airlockqa flake .airlock/reports --markdown --owner-map .airlock/owners.json --quarantine .airlock/quarantine.json
- name: PR comment
  if: always()
  run: gh pr comment "$PR" --body-file <(npx airlockqa flake .airlock/reports --markdown)
```

`--fail-on-flake` turns the step red when any flaky test is found; most teams should publish the report
first and only gate on it after an owner accepts the classification.

## Verification in this repository

- `tests/attach.test.ts` — 9 tests: config detection, wrapper generation, reporter preservation, write
  semantics, original config unchanged.
- `tests/attach-reporter.test.ts` — 6 tests: status/retry mapping, flaky final pass, attachment
  metadata, multiple projects, manifest shape, write failure safety.
- `tests/flake.test.ts` — 19 tests: classification priority, redaction, confidence, quarantine,
  owners, determinism, markdown.
- `examples/attach-demo` — a real Playwright 1.65 run through the generated wrapper, three seeded
  rounds, manifests aggregated by `airlock flake`. Demo outputs are in
  [`artifacts/attach-flake-demo`](../artifacts/attach-flake-demo).

With `bun` in this repository:

```bash
bun test tests/attach.test.ts tests/attach-reporter.test.ts tests/flake.test.ts
```
