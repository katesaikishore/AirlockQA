# AirlockQA

[![CI](https://github.com/katesaikishore/AirlockQA/actions/workflows/airlock-ci.yml/badge.svg)](https://github.com/katesaikishore/AirlockQA/actions/workflows/airlock-ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

AirlockQA is a local-first command-line tool for browser testing. It records a browser session, compiles it into a Playwright test, runs tests with a request policy that keeps real credentials out of the test browser, and writes a signed evidence bundle for each run. A bundle can be verified later when its signing key is kept and available (see [Evidence, signing and audit](#evidence-signing-and-audit)).

It runs on your machine or in CI. The optional hosted service, Airlock Cloud at [qbrin.cloud](https://qbrin.cloud), runs workflows for you and is operated separately; its server code is not part of this repository.

## Install

From npm:

```bash
npm install -g airlockqa@1.2.1
airlock --help
airlock verify-merge --help
```

Or from the GitHub release:

```bash
npm install -g https://github.com/katesaikishore/AirlockQA/releases/download/v1.2.0/airlockqa-1.2.0.tgz
```

Or run from a checkout:

```bash
git clone https://github.com/katesaikishore/AirlockQA.git
cd AirlockQA && bun install && bun bin/airlock.ts --help
```


## Status at a glance

Read this table before relying on a feature. Each row describes what this repository implements today.

| Capability | Status | Notes |
| :--- | :--- | :--- |
| `explore`, `compile`, `init` | Implemented | Records clicks, typing, key presses and selects into a trace; compiles it to a Playwright spec. |
| `attach` | Implemented | Adds the Airlock reporter to an existing Playwright suite without editing specs and writes run manifests under `.airlock/reports`. |
| `flake` | Implemented | Aggregates reporter manifests, classifies probable causes, reads request ledgers, and emits terminal, JSON or Markdown reports plus quarantine recommendations. |
| `test --local` | Implemented | Runs specs through Playwright Test. Hand-written specs can use the `airlockTest` fixture; compiled specs attach the gateway in `beforeEach`. |
| `run` (configured workflow) | Implemented | Runs `workflow` steps in one browser, with the gateway attached, and writes signed evidence. |
| Phantom credential substitution | Implemented | Exact string match in request headers and in text request bodies. Other bodies are passed through unchanged. |
| Request policy (egress rules) | Implemented, scoped | Covers browser-context requests and the standalone HTTP proxy. It is not an operating-system firewall. |
| Evidence signing and `audit` | Implemented | HMAC-SHA256 or Ed25519. The SOC 2 mapping fields are `NOT_ASSESSED`; this is not a certification. |
| Browser checkpoints and `fork` | Implemented | Saves cookies, storage and DOM hash, restores them in this run with `restoreCheckpoint` (or into new contexts with `fork`). It does not capture process or VM memory. |
| `chaos` | Observation only | The CLI and a `chaos` workflow step click once and report whether the observed mutation carried an idempotency key. No replay and no fault injection. |
| `warp` | Implemented, browser-page only | A `warp` workflow step offsets `Date` on the page in local and hosted runs. The standalone CLI command is still a no-op. Servers, databases, cron and TLS keep real time. |
| `teleport` | Prototype | Generates a repro spec from a capsule file. It does not replay the capsule. |
| Self-healing locators | Partial | `airlockLocator` accepts an optional healer for a fallback tier. Compiled specs do not pass one, so no healing runs by default. `healer.datasetDir` is used by the dataset command and console; `healer.confidenceThreshold` applies only when a caller passes the runner's healer. `healer.autoHeal` and `healer.saveMutations` are not read yet. |
| `serve` (web console) | Partial | Evidence and checkpoint views read local files. Run lists and metrics are sample data. |
| `qa` (hosted QA on a public repository) | Implemented (hosted) | Builds and starts a pushed commit of a public GitHub repo, runs smoke/unit/e2e/explore (and a11y/security/load when scripts are named), stores findings and failure screenshots, and seals the result. Public repos only; no env/secrets yet; one QA run at a time on the shared staging host. |
| `qa report` | Implemented | Downloads a run, its findings and screenshots, writes `report.md`, can comment on a PR or open a report PR in a repository you own. |
| `ai` (local agent help) | Implemented | `airlock ai ask/explain/doctor` uses an already-signed-in local coding agent; no model API key is stored by Airlock. |
| Browser fixtures (`fixture` workflow step) | Implemented, browser-only | Serves a same-origin, method-specific response in the page; no upstream request. No server-side fixture store. |
| `sync` (encrypted local data) | Implemented | Uploads traces, checkpoints, healing logs, fixtures and capsules, encrypted on the client with `AIRLOCK_SYNC_KEY`. The server stores only ciphertext and metadata; 200 artifacts / 50 MB per workspace, 2 MB each. |
| Airlock Cloud (`login`, `test --cloud`, `usage`, `runs`) | Implemented (hosted) | A hosted service runs declarative workflows in an isolated browser and returns signed evidence. The free plan allows 100 runs per workspace per day. The service is operated separately and is not open source. |

## Attach + flake

Already have a Playwright suite? You do not need to rewrite it.

```bash
bun bin/airlock.ts attach .
npx playwright test --reporter=airlock
bun bin/airlock.ts flake .airlock/reports --markdown
```

`attach` writes a reporter into the project without touching your specs; the reporter writes one Airlock manifest per run. `flake` aggregates those manifests, classifies likely causes, and can include request-ledger evidence. See [docs/attach-and-flake.md](docs/attach-and-flake.md).

## Verified Merge

Run the Playwright specs a pull request affects, rerun failures, and block only reproduced regressions:

```bash
AIRLOCK_SIGNING_KEY=... bun bin/airlock.ts verify-merge --run --base origin/main --head HEAD --repo owner/repo --pr "$PR_NUMBER"
```

The signed verdict and in-toto/DSSE attestation can be verified offline with `airlock verify-intoto`. See [docs/verified-merge.md](docs/verified-merge.md).

## MCP

```bash
bun bin/airlock.ts mcp
```

The public MCP server exposes `airlock_evidence_verify`, `airlock_verify` and `airlock_flake` over stdio. See [docs/mcp.md](docs/mcp.md).

## How it works

1. **Explore** a page to record a trace, or write a spec by hand.
2. **Compile** the trace to a Playwright spec that uses resilient locators.
3. **Test** locally with `airlock test --local`. Requests pass through the gateway, which replaces phantom placeholders with configured real values only after the policy allows the request.
4. **Audit** each run. `airlock run` produces a signed bundle that records the hash chain, the Merkle root and the policy decisions, and `airlock audit` verifies it.

## Quick start

AirlockQA needs [Bun](https://bun.sh) 1.3 or later and Node.js 20 or later.

```bash
git clone https://github.com/katesaikishore/AirlockQA.git
cd AirlockQA
bun install
bun run build
bun test
```

Install a browser for Playwright. If Chrome is installed elsewhere, point AirlockQA at it:

```bash
bunx playwright install chromium
export AIRLOCK_CHROME_PATH="/path/to/chrome"   # optional
```

Run the bundled demo store, then run its workflow:

```bash
bun run demo:server                                   # serves http://127.0.0.1:3900
bun ./bin/airlock.ts run --url http://127.0.0.1:3900  # writes .airlock/compliance/
bun ./bin/airlock.ts audit                            # verifies the bundle
```

Use the CLI from the repository with `bun ./bin/airlock.ts <command>` or `bun run cli <command>`. An npm package is not yet published; the installation steps above are the supported path.

## Typical workflow

```bash
bun run cli init                                                 # create airlock.config.json
bun run cli explore http://localhost:3000 --name checkout        # record a trace
bun run cli compile .airlock/traces/checkout-trace.json --out tests/checkout.spec.ts
bun run cli test --local tests/checkout.spec.ts --url http://localhost:3000
```

Compiled specs import from `airlockqa`, which resolves only where the package is installed. The package is not yet published, so inside this repository point that import at `src/index.ts` before running a compiled spec.

## CLI reference

The examples in this README use `airlock` for brevity. From a clone, substitute `bun ./bin/airlock.ts <command>` or `bun run cli <command>`, which the quick start and typical workflow use.

| Command | Purpose |
| :--- | :--- |
| `airlock init` | Write `airlock.config.json` and create the `.airlock/` directories. |
| `airlock explore [url]` | Open Chromium and record actions to a trace. `-n, --name`, `-o, --out`, `--headless`. |
| `airlock compile <trace>` | Compile a trace to a Playwright spec. `-o, --out`. |
| `airlock test [spec]` | Run specs locally (`-l, --local`) or on Cloud (`-c, --cloud`). `-u, --url`, `-s, --suite`; Cloud only: `-w, --workflow <file>`, `--no-wait`, `--timeout <seconds>`. |
| `airlock run [spec]` | Run `workflow` from the config (or `-w, --workflow <file>`), or a spec, then write signed evidence. `-u, --url`. |
| `airlock fork <checkpoint>` | Restore a checkpoint into parallel contexts, one input per variation. `-v, --variations`, `--values`, `-i, --input`, `-a, --action`, `--expect-selector`, `--expect-text`, `-w, --workers`. |
| `airlock audit [bundle]` | Verify a bundle's hash chain, Merkle root and signature. Exits 1 on failure. |
| `airlock sync` | Encrypt and upload local traces, checkpoints, healing logs, fixtures and capsules. `--kind`, `--dry-run`, `--json`; `sync list`; `sync download <id> --out <file>`. |
| `airlock login` | Save an Airlock Cloud API key in an owner-only file. The key is read from a hidden prompt, `AIRLOCK_API_KEY` or standard input. `--api-url`. |
| `airlock logout` | Remove the saved key from this machine. |
| `airlock whoami` | Show which key, endpoint and plan this machine uses. |
| `airlock usage` | Show today's hosted-run usage and limits. `--json`. |
| `airlock runs [id]` | List recent hosted runs, or show one with its steps. `-n, --limit`, `--status`, `--json`. |
| `airlock dataset` | Print selector-healing statistics from `healer.datasetDir`. |
| `airlock serve` | Start the local console on `127.0.0.1`. `-p, --port` (default 4100). |
| `airlock warp <duration>` | Prototype. Advances an in-memory offset; no browser effect from the CLI. |
| `airlock chaos [url]` | Prototype. Observes idempotency headers for one action. `-a, --action`, `-e, --endpoint`, `-f, --file`. |
| `airlock teleport <capsule>` | Prototype. Writes a repro spec from a capsule. `-o, --out`. |

Run `airlock <command> --help` for the complete option list.

## Configuration

AirlockQA reads `airlock.config.json` from the working directory, falling back to `.airlock/config.json` and `airlock.json`. The file is validated on load; an invalid file stops the command and names the problem.

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
| `AIRLOCK_CHROME_PATH` | Chromium executable used when `browser.executablePath` is not set. |
| `AIRLOCK_SIGNING_KEY` | Signing key for evidence. Takes precedence over `compliance.signingKey`. |
| `AIRLOCK_SIGNING_ALGORITHM` | `HMAC-SHA256` for a plain key; `Ed25519` when the key is a PEM private key. Set it to force an algorithm. |
| `AIRLOCK_TRUSTED_PUBLIC_KEY` | Pins the expected Ed25519 signer for `airlock audit`. |
| `AIRLOCK_CHECKPOINT_KEY` | Encrypts saved checkpoints at rest (AES-256-GCM). Without it, checkpoints are plain text and contain cookies, storage and page HTML. |
| `AIRLOCK_SYNC_KEY` | Passphrase (12+ characters) used by `airlock sync` to encrypt local artifacts before upload. It never leaves the machine; losing it makes synced artifacts unreadable. |
| `AIRLOCK_API_KEY` | Airlock Cloud key. Overrides the key saved by `airlock login`. Sent only as a Bearer token over HTTPS (plain HTTP is allowed only for localhost). |
| `AIRLOCK_CLOUD_URL` | Cloud API base URL. Defaults to `https://api.qbrin.cloud`. Requires HTTPS except for localhost. A saved key is never sent to a different endpoint than the one it was saved for. |
| `AIRLOCK_CONFIG_DIR` | Directory for the saved credentials (default `~/.config/airlock`). |
| `CI` | When set to a value other than `false` or `0`, and no signing key is provided, `run` and `audit` refuse to use the development key. |

Secret values are read from the variable named by `realFromEnv`, and `${env:NAME}` may be used in workflow step values. Names are yours to choose. The container and proxy variables are read by `container/start-proxy.ts` and `container/entrypoint.sh`; see those files and `container/docker-compose.yml`.

## Hosted runs with Airlock Cloud

Airlock Cloud runs a declarative workflow (the same `workflow` steps that `airlock run` reads) in an isolated headless browser and returns the result with signed evidence. Local runs never need it.

1. Create a free account at [qbrin.cloud](https://qbrin.cloud/login?mode=signup). Email addresses are not verified yet and no emails are sent.
2. Create an API key in the console under CI/CD & API. The key is shown once.
3. Save it on your machine and check it:

   ```bash
   airlock login
   airlock usage
   ```

4. Run a workflow against a public URL and read the result:

   ```bash
   airlock test --cloud --url https://staging.example.com --workflow workflow.json
   airlock runs
   ```

`airlock test --cloud` submits the run, waits for it, downloads the evidence and verifies it against the service's signing key, which `airlock login` pinned on first use. Set `AIRLOCK_TRUSTED_PUBLIC_KEY` to pin it yourself.

What hosted runs are, and are not:

- **Limits (free plan):** 100 accepted runs per workspace per UTC day, one run at a time, up to 50 workflow steps, 90 seconds per run.
- **Public targets only.** Private, loopback and link-local addresses are refused, so `localhost` cannot be tested in the cloud. Use `airlock test --local` for that.
- **No secrets.** The service holds no application secrets, workflows may not use `${env:NAME}`, and `phantomConfig` supplies request-policy rules only.
- **Workflows only.** Spec files are not uploaded or executed.
- Request and response details are in [docs/cloud-api.md](docs/cloud-api.md).

`airlock test` chooses its target in this order:

1. `--local` runs on your machine.
2. `--cloud` submits a hosted run (a key from `airlock login` or `AIRLOCK_API_KEY` is required).
3. With neither flag, the command submits a hosted run if `AIRLOCK_API_KEY` is set in the environment, and runs locally otherwise.

## Request policy and phantom secrets

Test code sees placeholder values (phantom tokens). The gateway replaces a placeholder with its real value only when all of these hold:

- the request goes through the Playwright context or the standalone proxy,
- the destination host matches the secret's `allowedHosts`,
- the method and path are not blocked, and
- the egress policy allows the host.

Replacement is an exact string match in request headers and in text request bodies (`text/*`, JSON, XML, form-encoded). Other bodies are passed through unchanged. Encoded, split or transformed values are not detected.

Requests through the gateway or proxy to unlisted hosts are blocked by default (`defaultAction: BLOCK`). The policy does not cover requests that a server makes to other servers, it is not an operating-system firewall, and it does not replace a secrets vault. Read the limits in [docs/HOW-TO-USE.md](docs/HOW-TO-USE.md) before relying on it for production credentials.

## Evidence, signing and audit

Each `run` writes `.airlock/compliance/latest-attestation.json` and an HTML report. A bundle records the ledger hash chain, the Merkle root of the chain, the policy decisions and the signature over the whole bundle.

- A bundle shows that the recorded ledger has not changed since signing, when verified with the signing key (HMAC) or a pinned Ed25519 public key. Without a pinned key, it shows only consistency.
- Anyone holding the HMAC key can verify a bundle. With Ed25519, verify against a pinned public key (`AIRLOCK_TRUSTED_PUBLIC_KEY`). Without one, `audit` checks only that the bundle matches the key embedded in it, which shows consistency but not who signed it. With CI set and no signing key, `audit` refuses an Ed25519 bundle unless `AIRLOCK_TRUSTED_PUBLIC_KEY` is set. A configured PEM signing key also pins the signer.
- A bundle does not prove that the tests passed, that the application is secure, or that any compliance control was met. The SOC 2 mapping fields are `NOT_ASSESSED`.
- In CI without `AIRLOCK_SIGNING_KEY`, the workflow in this repository signs with a random key for that job. Such a bundle cannot be verified later by a key holder.
- Outside CI, with no signing key configured, a run is signed with a development key that is public in this repository. Such a bundle is marked `insecureDevKey` and provides no integrity guarantee. Set `AIRLOCK_SIGNING_KEY` for any bundle you rely on.

## Continuous integration

[`.github/workflows/airlock-ci.yml`](.github/workflows/airlock-ci.yml) runs on pushes and pull requests to `main`. It:

1. installs dependencies with the frozen lockfile and Playwright Chromium,
2. builds the TypeScript and the React console,
3. runs the Playwright + axe GUI suite,
4. starts the demo store and waits for it to respond,
5. runs `bun test`,
6. runs the demo workflow and verifies its bundle,
7. uploads `.airlock/compliance/`, `.airlock/dataset/` and `artifacts/gui-qa/pr/` as artifacts for 30 days.

To produce bundles that can be verified later, add `AIRLOCK_SIGNING_KEY` as a repository secret.

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

Install a browser with `bunx playwright install chromium`. The CLI uses `AIRLOCK_CHROME_PATH` when `browser.executablePath` is not set. The browser-based tests read `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` instead.

## Documentation

- [Full user guide](docs/HOW-TO-USE.md): every command, configuration field and limit.
- [Cloud API](docs/cloud-api.md): the hosted service's public API, limits and quota behaviour.
- [Cloud client and service boundary](docs/cloud-api-auth-and-quota.md): what this repository contains and what it does not.
- [QA test plan](docs/qa-test-plan.md): the flows covered by the GUI suite.
- [QA on GitHub](docs/qa-github.md): the pull-request workflow, the report command and its limits.
- [Go-to-market](docs/go-to-market.md): the open-source-to-cloud plan and the guardrails for public reports.
- [Encrypted local sync](docs/local-sync.md): what `airlock sync` uploads, how the key works and its limits.
- [GitHub Action](docs/github-action.md): run Airlock QA on a pull request with `katesaikishore/AirlockQA@v1`.
- [Case study](docs/case-study-fixture-app.md): the signed fixture-app run with 11 findings and 5 screenshots.
- [QA Index](docs/qa-index/2026-11.md): the November 2026 public check of five real OSS apps, including the MoneyMatter issue.
- [Product boundary](docs/product-boundary.md): exactly what runs in the hosted service and what stays local.
- [Product claims and implementation plan](docs/five-impossible-moats-implementation-plan.md): the status of each advertised capability.

## License

[MIT](LICENSE)
