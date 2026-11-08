# Airlock QA GitHub Action

The repository root contains a composite GitHub Action. It runs Airlock QA against the pull-request commit, writes the
Markdown report with failure screenshots, uploads it as an artifact, and comments on the PR.

## Quick start

Create an API key at **https://qbrin.cloud → CI/CD & API**, store it as the repository secret `AIRLOCK_API_KEY`, then
add this workflow:

```yaml
name: Airlock QA
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
      - uses: katesaikishore/AirlockQA@v1
        with:
          api-key: ${{ secrets.AIRLOCK_API_KEY }}
          suites: smoke,explore
          gate: strict
```

The action checks out nothing itself; the caller must run `actions/checkout` first. It installs Bun, installs the
AirlockQA CLI from the action path, submits a QA run for the PR head commit, waits for the result, writes `qa-report/`,
uploads it, and comments on the PR.

## Inputs

| Input | Required | Default | Meaning |
| :--- | :--- | :--- | :--- |
| `api-key` | yes | — | Airlock Cloud API key; store it as a secret |
| `suites` | no | `smoke,explore` | Comma-separated suites |
| `gate` | no | `strict` | `airlock qa --gate` mode |
| `report-dir` | no | `qa-report` | Report directory inside the runner temp dir |
| `comment` | no | `true` | Comment the report on pull requests |

Outputs: `run-id` (the Airlock run id) and `report-path` (the report directory).

## Requirements and limits

- The repository must be **public**; hosted QA builds from a public GitHub URL.
- The PR head commit must be pushed to GitHub. GitHub does not expose repository secrets to pull requests from forks,
  so fork PRs need a self-hosted runner, a maintainer-run `workflow_dispatch`, or the GitHub App (not built yet).
- The caller grants `contents: read` and `pull-requests: write`. The action never writes to the repository.
- The action uploads a report artifact for 14 days; the hosted run's signed evidence remains in Airlock Cloud.
- The action is not a GitHub App. It runs only from the calling workflow; see the product boundary in
  [go-to-market](go-to-market.md#what-must-be-true-before-calling-it-ga).

## Versioning

Use the moving major tag:

```yaml
- uses: katesaikishore/AirlockQA@v1
```

Pin a full release tag if you need an immutable action. The action follows the same MIT license as the rest of the
repository.


AirlockQA is free for public repositories. The Pro waitlist for private repositories, SSO and longer retention is at https://qbrin.cloud/pricing/.
