# QA on GitHub pull requests

Airlock QA can run on a pull request, save the failure screenshots, and put the verdict and findings in the PR. This is
the open-source half of the CodeRabbit-style motion: the workflow is copy-paste, the hosted run does the work, and the
report is the marketing.

## What the run does

1. The cloud builds and starts the repository at the requested commit in an isolated sandbox.
2. `smoke` checks that the app answers on its health path.
3. The requested suites run: the repository's `unit` / `e2e` scripts, its a11y/security/load scripts when named, and
   Airlock's own browser checker (`explore`).
4. A failed checker finding or a failed script becomes a finding. `strict` makes a failed or unrun suite fail the gate.
5. Failure screenshots are stored with the run. `airlock qa report` downloads them and writes `report.md`.

## Run it by hand

```bash
# From the repository you want to test (public GitHub remote, commit pushed).
airlock qa --suites smoke,unit,e2e,explore --gate strict --wait

# Write the report and screenshots locally.
airlock qa report <runId> --out qa-reports/<runId>

# Open a pull request that commits the report (in a repository you own).
airlock qa report <runId> --create-pr
```

`airlock qa --create-pr` is deliberately limited to the repository the command runs in. It cannot open a pull request
on someone else's repository without permission; use the workflow there instead.

## Add the workflow

Copy [`templates/github-actions/airlock-qa.yml`](../templates/github-actions/airlock-qa.yml) to
`.github/workflows/airlock-qa.yml` and add the repository secret `AIRLOCK_API_KEY` (create a key in the console under
CI/CD & API). The workflow:

- checks out the PR head commit and the AirlockQA CLI,
- runs `smoke,explore` (add `unit,e2e` when the repository has those scripts),
- uploads `qa-report/` as a workflow artifact (the screenshots live here),
- comments the Markdown report on the pull request.

## Limits and honest caveats

- **Public repositories only.** The QA service clones a public `https://github.com/owner/repo`; private repositories are
  not supported yet.
- **Fork pull requests do not receive secrets.** The workflow needs `AIRLOCK_API_KEY`; a PR from a fork does not get it.
  Run the workflow on a branch in the repository, or use a GitHub App installation (next).
- **The head commit must exist on GitHub.** For a same-repository PR the head SHA is on GitHub; for a fork it may not
  be reachable from the base repository. The service refuses a commit it cannot fetch.
- **Your scripts run in the sandbox.** They can install dependencies and run a server. They do not receive application
  secrets: there is no environment-variable or vault mechanism yet. Do not put real credentials in the repository.
- **Screenshots are evidence, not a compliance result.** They can contain data the app rendered. Use a throwaway
  deployment or seeded data, and review before publishing.
- **One QA run at a time** on the shared staging host today. The service returns `429 RATE_LIMITED` while another QA
  run is queued or running.

## The next step: a GitHub App

The workflow is the low-friction demo; the App is the product. The App should:

- receive `pull_request` and `check_suite` webhooks,
- create a check run with the gate verdict and a link to the report,
- post one comment with the worst findings and screenshots,
- use an installation token instead of a user's key,
- support private repositories and a per-installation quota.

Until that exists, the workflow and `airlock qa report` are the supported path.
