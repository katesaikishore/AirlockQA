# QAFind

[![CI](https://github.com/katesaikishore/QAFind/actions/workflows/qafind-ci.yml/badge.svg)](https://github.com/katesaikishore/QAFind/actions/workflows/qafind-ci.yml)
[![npm](https://img.shields.io/npm/v/qafind.svg)](https://www.npmjs.com/package/qafind)
[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-QAFind%20CI-blue?logo=github)](https://github.com/marketplace/actions/qafind-ci)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Make the Playwright suite you already run trustworthy.** QAFind runs the specs a pull request affects, reruns failures, blocks a merge only on reproduced regressions, and writes signed evidence for every run.

- **Local-first CLI** (`qafind`): attach to an existing Playwright suite, find flaky tests, record and compile new specs, and run them behind a request policy that keeps real credentials out of the browser.
- **GitHub Action** ([QAFind CI](https://github.com/marketplace/actions/qafind-ci)): run QAFind on every pull request.
- **Hosted service** ([qafind.si](https://qafind.si)): optional. Runs workflows and pull-request reviews for you; its server code is not in this repository.

> **Formerly Airlock QA.** Version 2.0.0 renamed everything: the CLI is `qafind` (the `airlock` command is gone), the npm package is `qafind`, the Action is `katesaikishore/QAFind@v2`, and variables are `QAFIND_*`. See the [changelog](CHANGELOG.md#200).

## Install

```bash
npm install -g qafind
qafind --help
```

Or run from a checkout (needs [Bun](https://bun.sh) 1.3+ and Node.js 20+):

```bash
git clone https://github.com/katesaikishore/QAFind.git
cd QAFind && bun install && bun bin/qafind.ts --help
```

## Use it on pull requests

Add a `QAFIND_API_KEY` repository secret (create a key in the [console](https://qafind.si/console) under CI/CD & API), then:

```yaml
# .github/workflows/qafind.yml
name: QAFind
on:
  pull_request:
permissions:
  contents: read
  pull-requests: write
jobs:
  qa:
    runs-on: ubuntu-latest
    timeout-minutes: 90
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: katesaikishore/QAFind@v2
        with:
          api-key: ${{ secrets.QAFIND_API_KEY }}
```

All inputs are described in [docs/github-action.md](docs/github-action.md).


## Open source

QAFind is MIT-licensed and built in public. Read [CONTRIBUTING.md](CONTRIBUTING.md), the [contributor path](docs/CONTRIBUTOR-PATH.md), and the [roadmap](docs/ROADMAP.md).

Maintainers of open-source projects using Playwright can apply to the [open-source program](docs/open-source-program.md): Verified Merge in comment-only mode, free, with no public mention without approval.

If QAFind helped your project, open a **Showcase** issue with the repository and what it caught. No marketing copy needed — the evidence is the point.
## Status at a glance

Read this table before relying on a feature. Each row describes what this repository implements today.

| Capability | Status | Notes |
| :--- | :--- | :--- |
| `explore`, `compile`, `init` | Implemented | Records clicks, typing, key presses and selects into a trace; compiles it to a Playwright spec. |
| `attach` | Implemented | Adds the QAFind reporter to an existing Playwright suite without editing specs and writes run manifests under `.qafind/reports`. |
| `flake` | Implemented | Aggregates reporter manifests, classifies probable causes, reads request ledgers, and emits terminal, JSON or Markdown reports plus quarantine recommendations. |
| `test --local` | Implemented | Runs specs through Playwright Test. Hand-written specs can use the `qafindTest` fixture; compiled specs attach the gateway in `beforeEach`. |
| `run` (configured workflow) | Implemented | Runs `workflow` steps in one browser, with the gateway attached, and writes signed evidence. |
| Phantom credential substitution | Implemented | Exact string match in request headers and in text request bodies. Other bodies are passed through unchanged. |
| Request policy (egress rules) | Implemented, scoped | Covers browser-context requests and the standalone HTTP proxy. It is not an operating-system firewall. |
| Evidence signing and `audit` | Implemented | HMAC-SHA256 or Ed25519. The SOC 2 mapping fields are `NOT_ASSESSED`; this is not a certification. |
| Browser checkpoints and `fork` | Implemented | Saves cookies, storage and DOM hash, restores them in this run with `restoreCheckpoint` (or into new contexts with `fork`). It does not capture process or VM memory. |
| `chaos` | Observation only | The CLI and a `chaos` workflow step click once and report whether the observed mutation carried an idempotency key. No replay and no fault injection. |
| `warp` | Implemented, browser-page only | A `warp` workflow step offsets `Date` on the page in local and hosted runs. The standalone CLI command is still a no-op. Servers, databases, cron and TLS keep real time. |
| `teleport` | Prototype | Generates a repro spec from a capsule file. It does not replay the capsule. |
| Self-healing locators | Partial | `qafindLocator` accepts an optional healer for a fallback tier. Compiled specs do not pass one, so no healing runs by default. `healer.datasetDir` is used by the dataset command and console; `healer.confidenceThreshold` applies only when a caller passes the runner's healer. `healer.autoHeal` and `healer.saveMutations` are not read yet. |
| `serve` (web console) | Partial | Evidence and checkpoint views read local files. Run lists and metrics are sample data. |
| `qa` (hosted QA on a public repository) | Implemented (hosted) | Builds and starts a pushed commit of a public GitHub repo, runs smoke/unit/e2e/explore (and a11y/security/load when scripts are named), stores findings and failure screenshots, and seals the result. Public repos only; no env/secrets yet; one QA run at a time on the shared staging host. |
| `qa report` | Implemented | Downloads a run, its findings and screenshots, writes `report.md`, can comment on a PR or open a report PR in a repository you own. |
| `ai` (local agent help) | Implemented | `qafind ai ask/explain/doctor` uses an already-signed-in local coding agent; no model API key is stored by QAFind. |
| Browser fixtures (`fixture` workflow step) | Implemented, browser-only | Serves a same-origin, method-specific response in the page; no upstream request. No server-side fixture store. |
| `sync` (encrypted local data) | Implemented | Uploads traces, checkpoints, healing logs, fixtures and capsules, encrypted on the client with `QAFIND_SYNC_KEY`. The server stores only ciphertext and metadata; 200 artifacts / 50 MB per workspace, 2 MB each. |
| QAFind Cloud (`login`, `test --cloud`, `usage`, `runs`) | Implemented (hosted) | A hosted service runs declarative workflows in an isolated browser and returns signed evidence. The free plan allows 100 runs per workspace per day. The service is operated separately and is not open source. |

## Attach + flake

Already have a Playwright suite? You do not need to rewrite it.

```bash
bun bin/qafind.ts attach .
npx playwright test --reporter=qafind
bun bin/qafind.ts flake .qafind/reports --markdown
```

`attach` writes a reporter into the project without touching your specs; the reporter writes one QAFind manifest per run. `flake` aggregates those manifests, classifies likely causes, and can include request-ledger evidence. See [docs/attach-and-flake.md](docs/attach-and-flake.md).

## One-URL cloud pipeline

```bash
qafind app https://example.com --watch
```

Starts the QAFind Cloud pipeline: LLM + Playwright discovery, feature inventory, generated tests,
cloud runs, signed evidence, security baseline and labs.

## QA hunt

Audit the test suite a project already has, then check the tracker before filing anything:

```bash
qafind hunt . --repo owner/repo --json
qafind dedupe --repo owner/repo --title "Unawaited Playwright expectation"
qafind verify --command "npx playwright test failing.spec.ts" --expect failure
```

`hunt` reports unawaited Playwright matchers, assertion-free tests, fixed waits, focused tests and tracked skips. It now ignores Vitest, Jest, Testing Library and `node:test` files so it does not emit framework-mismatched false positives. `dedupe` checks issues and pull requests before a report is filed. `verify` records the failing-repro and fixed-success evidence.

## Verified Merge

Run the Playwright specs a pull request affects, rerun failures, and block only reproduced regressions:

```bash
QAFIND_SIGNING_KEY=... bun bin/qafind.ts verify-merge --run --base origin/main --head HEAD --repo owner/repo --pr "$PR_NUMBER"
```

Results can be Playwright JSON or JUnit XML from Cypress, Selenium, WebdriverIO or another runner. The signed verdict and in-toto/DSSE attestation can be verified offline with `qafind verify-intoto`. See [docs/verified-merge.md](docs/verified-merge.md).

## MCP

```bash
bun bin/qafind.ts mcp
```

The public MCP server exposes `qafind_evidence_verify`, `qafind_verify` and `qafind_flake` over stdio. See [docs/mcp.md](docs/mcp.md).

## How it works

1. **Explore** a page to record a trace, or write a spec by hand.
2. **Compile** the trace to a Playwright spec that uses resilient locators.
3. **Test** locally with `qafind test --local`. Requests pass through the gateway, which replaces phantom placeholders with configured real values only after the policy allows the request.
4. **Audit** each run. `qafind run` produces a signed bundle that records the hash chain, the Merkle root and the policy decisions, and `qafind audit` verifies it.

## Quick start

QAFind needs [Bun](https://bun.sh) 1.3 or later and Node.js 20 or later.

```bash
git clone https://github.com/katesaikishore/QAFind.git
cd QAFind
bun install
bun run build
bun test
```

Install a browser for Playwright. If Chrome is installed elsewhere, point QAFind at it:

```bash
bunx playwright install chromium
export QAFIND_CHROME_PATH="/path/to/chrome"   # optional
```

Run the bundled demo store, then run its workflow:

```bash
bun run demo:server                                   # serves http://127.0.0.1:3900
bun ./bin/qafind.ts run --url http://127.0.0.1:3900  # writes .qafind/compliance/
bun ./bin/qafind.ts audit                            # verifies the bundle
```

With the npm package installed, run `qafind <command>`. From a checkout, use `bun ./bin/qafind.ts <command>` or `bun run cli <command>`.

## Typical workflow

```bash
bun run cli init                                                 # create qafind.config.json
bun run cli explore http://localhost:3000 --name checkout        # record a trace
bun run cli compile .qafind/traces/checkout-trace.json --out tests/checkout.spec.ts
bun run cli test --local tests/checkout.spec.ts --url http://localhost:3000
```

Compiled specs import from `qafind`, so install the package in the project under test (`npm install -D qafind`). Inside this repository, point that import at `src/index.ts` instead.

## CLI reference

The examples use the installed `qafind` command. From a clone, substitute `bun ./bin/qafind.ts <command>` or `bun run cli <command>`.

| Command | Purpose |
| :--- | :--- |
| `qafind init` | Write `qafind.config.json` and create the `.qafind/` directories. |
| `qafind explore [url]` | Open Chromium and record actions to a trace. `-n, --name`, `-o, --out`, `--headless`. |
| `qafind compile <trace>` | Compile a trace to a Playwright spec. `-o, --out`. |
| `qafind test [spec]` | Run specs locally (`-l, --local`) or on Cloud (`-c, --cloud`). `-u, --url`, `-s, --suite`; Cloud only: `-w, --workflow <file>`, `--no-wait`, `--timeout <seconds>`. |
| `qafind run [spec]` | Run `workflow` from the config (or `-w, --workflow <file>`), or a spec, then write signed evidence. `-u, --url`. |
| `qafind fork <checkpoint>` | Restore a checkpoint into parallel contexts, one input per variation. `-v, --variations`, `--values`, `-i, --input`, `-a, --action`, `--expect-selector`, `--expect-text`, `-w, --workers`. |
| `qafind audit [bundle]` | Verify a bundle's hash chain, Merkle root and signature. Exits 1 on failure. |
| `qafind sync` | Encrypt and upload local traces, checkpoints, healing logs, fixtures and capsules. `--kind`, `--dry-run`, `--json`; `sync list`; `sync download <id> --out <file>`. |
| `qafind login` | Save a QAFind Cloud API key in an owner-only file. The key is read from a hidden prompt, `QAFIND_API_KEY` or standard input. `--api-url`. |
| `qafind logout` | Remove the saved key from this machine. |
| `qafind whoami` | Show which key, endpoint and plan this machine uses. |
| `qafind usage` | Show today's hosted-run usage and limits. `--json`. |
| `qafind runs [id]` | List recent hosted runs, or show one with its steps. `-n, --limit`, `--status`, `--json`. |
| `qafind dataset` | Print selector-healing statistics from `healer.datasetDir`. |
| `qafind serve` | Start the local console on `127.0.0.1`. `-p, --port` (default 4100). |
| `qafind warp <duration>` | Prototype. Advances an in-memory offset; no browser effect from the CLI. |
| `qafind chaos [url]` | Prototype. Observes idempotency headers for one action. `-a, --action`, `-e, --endpoint`, `-f, --file`. |
| `qafind teleport <capsule>` | Prototype. Writes a repro spec from a capsule. `-o, --out`. |

Run `qafind <command> --help` for the complete option list.

## Configuration

QAFind reads `qafind.config.json` from the working directory, falling back to `.qafind/config.json` and `qafind.json`. The file is validated on load; an invalid file stops the command and names the problem.

```json
{
  "baseUrl": "http://localhost:3000",
  "secrets": {
    "STRIPE_SECRET_KEY": {
      "realFromEnv": "STRIPE_SECRET_KEY",
      "real": "REPLACE_ME_STRIPE_SECRET_KEY",
      "phantom": "ph_sec_stripe_test_placeholder",
      "allowedHosts": ["api.stripe.com"],
      "blockedPaths": ["*/refund*"]
    }
  },
  "policy": {
    "defaultAction": "BLOCK",
    "allowedEgressHosts": ["localhost", "127.0.0.1"]
  }
}
```

The main fields are documented in [docs/HOW-TO-USE.md](docs/HOW-TO-USE.md). A few advanced fields are described only in the schema at `src/config/schema.ts`. Do not commit real credentials. Load them from the environment with `realFromEnv`.

## Environment variables

| Variable | Effect |
| :--- | :--- |
| `QAFIND_CHROME_PATH` | Chromium executable used when `browser.executablePath` is not set. |
| `QAFIND_SIGNING_KEY` | Signing key for evidence. Takes precedence over `compliance.signingKey`. |
| `QAFIND_SIGNING_ALGORITHM` | `HMAC-SHA256` for a plain key; `Ed25519` when the key is a PEM private key. Set it to force an algorithm. |
| `QAFIND_TRUSTED_PUBLIC_KEY` | Pins the expected Ed25519 signer for `qafind audit`. |
| `QAFIND_CHECKPOINT_KEY` | Encrypts saved checkpoints at rest (AES-256-GCM). Without it, checkpoints are plain text and contain cookies, storage and page HTML. |
| `QAFIND_SYNC_KEY` | Passphrase (12+ characters) used by `qafind sync` to encrypt local artifacts before upload. It never leaves the machine; losing it makes synced artifacts unreadable. |
| `QAFIND_API_KEY` | QAFind Cloud key. Overrides the key saved by `qafind login`. Sent only as a Bearer token over HTTPS (plain HTTP is allowed only for localhost). |
| `QAFIND_CLOUD_URL` | Cloud API base URL. Defaults to `https://api.qafind.si`. Requires HTTPS except for localhost. A saved key is never sent to a different endpoint than the one it was saved for. |
| `QAFIND_CONFIG_DIR` | Directory for the saved credentials (default `~/.config/qafind`). |
| `CI` | When set to a value other than `false` or `0`, and no signing key is provided, `run` and `audit` refuse to use the development key. |

Secret values are read from the variable named by `realFromEnv`, and `${env:NAME}` may be used in workflow step values. Names are yours to choose. The container and proxy variables are read by `container/start-proxy.ts` and `container/entrypoint.sh`; see those files and `container/docker-compose.yml`.

## Hosted runs with QAFind Cloud

QAFind Cloud runs a declarative workflow (the same `workflow` steps that `qafind run` reads) in an isolated headless browser and returns the result with signed evidence. Local runs never need it.

1. Create a free account at [qafind.si](https://qafind.si/login?mode=signup). Email addresses are not verified yet and no emails are sent.
2. Create an API key in the console under CI/CD & API. The key is shown once.
3. Save it on your machine and check it:

   ```bash
   qafind login
   qafind usage
   ```

4. Run a workflow against a public URL and read the result:

   ```bash
   qafind test --cloud --url https://staging.example.com --workflow workflow.json
   qafind runs
   ```

`qafind test --cloud` submits the run, waits for it, downloads the evidence and verifies it against the service's signing key, which `qafind login` pinned on first use. Set `QAFIND_TRUSTED_PUBLIC_KEY` to pin it yourself.

What hosted runs are, and are not:

- **Limits (free plan):** 100 accepted runs per workspace per UTC day, one run at a time, up to 50 workflow steps, 90 seconds per run.
- **Public targets only.** Private, loopback and link-local addresses are refused, so `localhost` cannot be tested in the cloud. Use `qafind test --local` for that.
- **No secrets.** The service holds no application secrets, workflows may not use `${env:NAME}`, and `phantomConfig` supplies request-policy rules only.
- **Workflows only.** Spec files are not uploaded or executed.
- Request and response details are in [docs/cloud-api.md](docs/cloud-api.md).

`qafind test` chooses its target in this order:

1. `--local` runs on your machine.
2. `--cloud` submits a hosted run (a key from `qafind login` or `QAFIND_API_KEY` is required).
3. With neither flag, the command submits a hosted run if `QAFIND_API_KEY` is set in the environment, and runs locally otherwise.

## Request policy and phantom secrets

Test code sees placeholder values (phantom tokens). The gateway replaces a placeholder with its real value only when all of these hold:

- the request goes through the Playwright context or the standalone proxy,
- the destination host matches the secret's `allowedHosts`,
- the method and path are not blocked, and
- the egress policy allows the host.

Replacement is an exact string match in request headers and in text request bodies (`text/*`, JSON, XML, form-encoded). Other bodies are passed through unchanged. Encoded, split or transformed values are not detected.

Requests through the gateway or proxy to unlisted hosts are blocked by default (`defaultAction: BLOCK`). The policy does not cover requests that a server makes to other servers, it is not an operating-system firewall, and it does not replace a secrets vault. Read the limits in [docs/HOW-TO-USE.md](docs/HOW-TO-USE.md) before relying on it for production credentials.

## Evidence, signing and audit

Each `run` writes `.qafind/compliance/latest-attestation.json` and an HTML report. A bundle records the ledger hash chain, the Merkle root of the chain, the policy decisions and the signature over the whole bundle.

- A bundle shows that the recorded ledger has not changed since signing, when verified with the signing key (HMAC) or a pinned Ed25519 public key. Without a pinned key, it shows only consistency.
- Anyone holding the HMAC key can verify a bundle. With Ed25519, verify against a pinned public key (`QAFIND_TRUSTED_PUBLIC_KEY`). Without one, `audit` checks only that the bundle matches the key embedded in it, which shows consistency but not who signed it. With CI set and no signing key, `audit` refuses an Ed25519 bundle unless `QAFIND_TRUSTED_PUBLIC_KEY` is set. A configured PEM signing key also pins the signer.
- A bundle does not prove that the tests passed, that the application is secure, or that any compliance control was met. The SOC 2 mapping fields are `NOT_ASSESSED`.
- In CI without `QAFIND_SIGNING_KEY`, the workflow in this repository signs with a random key for that job. Such a bundle cannot be verified later by a key holder.
- Outside CI, with no signing key configured, a run is signed with a development key that is public in this repository. Such a bundle is marked `insecureDevKey` and provides no integrity guarantee. Set `QAFIND_SIGNING_KEY` for any bundle you rely on.

## Continuous integration

[`.github/workflows/qafind-ci.yml`](.github/workflows/qafind-ci.yml) runs on pushes and pull requests to `main`. It:

1. installs dependencies with the frozen lockfile and Playwright Chromium,
2. builds the TypeScript and the React console,
3. runs the Playwright + axe GUI suite,
4. starts the demo store and waits for it to respond,
5. runs `bun test`,
6. runs the demo workflow and verifies its bundle,
7. uploads `.qafind/compliance/`, `.qafind/dataset/` and `artifacts/gui-qa/pr/` as artifacts for 30 days.

To produce bundles that can be verified later, add `QAFIND_SIGNING_KEY` as a repository secret.

## Development

| Command | Purpose |
| :--- | :--- |
| `bun run build` | Compile TypeScript to `dist/` and build the React console into `public/app/`. |
| `bun test` | Run the test suite. |
| `bun run cli <command>` | Run the CLI from source. |
| `bun run demo:server` | Start the demo store on port 3900. |
| `bun run qa:gui` | GUI smoke and axe accessibility suite with Playwright: the site, every console section, the dashboard recording and the demo store. Runs locally with no network, and in CI. `BASE_URL=<url>` tests a deployment instead. |
| `bun run qa:report -- <runId>` | Download a QA run and write `report.md` plus screenshots; add `--create-pr` to open a report PR in the current repository. |
| `bun run qa:hunt` | Run QA over the public repositories in `scripts/qa-hunt-repos.txt`, one at a time, and write a report for each. `--max`, `--suites`, `--create-pr`. |

Install a browser with `bunx playwright install chromium`. The CLI uses `QAFIND_CHROME_PATH` when `browser.executablePath` is not set. The browser-based tests read `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` instead.

## Documentation

- [Full user guide](docs/HOW-TO-USE.md): every command, configuration field and limit.
- [Cloud API](docs/cloud-api.md): the hosted service's public API, limits and quota behaviour.
- [Cloud client and service boundary](docs/cloud-api-auth-and-quota.md): what this repository contains and what it does not.
- [QA test plan](docs/qa-test-plan.md): the flows covered by the GUI suite.
- [QA on GitHub](docs/qa-github.md): the pull-request workflow, the report command and its limits.
- [Encrypted local sync](docs/local-sync.md): what `qafind sync` uploads, how the key works and its limits.
- [GitHub Action](docs/github-action.md): run QAFind on a pull request with `katesaikishore/QAFind@v2`.
- [Case study](docs/case-study-fixture-app.md): the signed fixture-app run with 11 findings and 5 screenshots.
- [QA Index](docs/qa-index/2026-11.md): the November 2026 public check of five real OSS apps, including the MoneyMatter issue.
- [Product boundary](docs/product-boundary.md): exactly what runs in the hosted service and what stays local.
- [Product claims and implementation plan](docs/five-impossible-moats-implementation-plan.md): the status of each advertised capability.

## License

[MIT](LICENSE)
