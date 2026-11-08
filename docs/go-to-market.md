# AirlockQA go-to-market: open source first, cloud second

This is the working plan for the CodeRabbit-style motion: the open-source tool earns trust and distribution, the hosted
service earns revenue. It is deliberately explicit about what not to do.

## The one-line position

**AirlockQA runs the app, not just the test suite.** It drives the running UI and the repository's own CLI tests, keeps
the failure screenshots and a signed run result, and puts the verdict where a team already works: a pull request.

## What we do not do

- **No unsolicited pull requests to major repositories.** We do not have permission to push to them, maintainers read
  unsolicited PRs as spam, and a generated "fix" can waste their time. If a real bug is found, open an issue with a
  minimal reproduction and ask before opening a PR. Create PRs only in repositories we own or where a maintainer asked.
- **No "we tested your app" claims without the report.** Every public claim links to the run, the commit and the
  screenshots.
- **No AI-generated verdicts dressed as facts.** Findings say who saw them: Airlock's checker (first-party) or the
  repository's own tests (self-reported).

## The CodeRabbit analogy, made concrete

CodeRabbit is installed on a repository, runs on every pull request, and comments where the team already reviews. Its
open-source presence is the funnel; the hosted app is the product. AirlockQA follows the same shape:

| Layer | What it is | Why it converts |
| :--- | :--- | :--- |
| Open-source CLI | `airlock qa` runs smoke, unit, e2e, a11y, security, load and Airlock's own browser checker | A developer can prove it works before creating an account |
| Reusable GitHub Action | Runs QA on a PR and uploads the report and screenshots | The first "it ran on my repo" moment |
| GitHub App (next) | Installed once, runs on every PR, posts a check and a comment | Removes the workflow copy/paste; the CodeRabbit motion |
| Hosted cloud | Builds/starts the app in an isolated sandbox, runs the suites, stores the signed evidence | No CI minutes, no local browser, no infrastructure |
| Paid plan (next) | Private repositories, more concurrency, longer retention, SSO | The team upgrades when the free run is already useful |

## The funnel

1. **Content that is also a product demo.** Publish a weekly "Airlock QA Index": 3–5 popular open-source web apps, one
   screenshot per real finding, the commit tested, and the exact command to reproduce. Link the repository and the
   report. This is the marketing flywheel; it is not a PR to those repositories.
2. **Free local CLI.** `bunx airlockqa` (once published) or the GitHub clone. No account needed. The CLI writes the same
   report and evidence locally.
3. **Free hosted run for public repositories.** One click from the report page: "Run this on your repo". The free plan
   is the same 100 workflow runs and 5 QA runs per day that already exist; no new billing needed to start.
4. **Install the Action, then the App.** The Action is copy-paste; the App is one install and a check on every PR.
5. **Upgrade for private repos and teams.** Private repositories, more concurrent runs, longer artifact retention,
   SSO, priority queue.

## The first three campaigns

1. **"What unit tests miss" series.** Take one popular app per week, run the Airlock checker, publish the first-party
   findings with screenshots. The fixture app is the control (it has known seeded bugs); real apps are the story.
2. **"Add QA to your PR in 5 minutes" workshop.** A public repo template with the Action, a recorded run, and the
   report. The CTA is the hosted run, not a sales call.
3. **"The QA Index" report.** A monthly table: repository, commit, what ran, what broke, time to result. Publish the
   raw reports as artifacts; let people check the work.

## What must be true before calling it GA

- [x] Failure screenshots stored with the run and downloadable from the API.
- [x] `airlock qa report` writes a Markdown report and can open a PR in a repository we own.
- [x] GitHub Action template runs on a pull request, uploads the report/screenshots and comments with the report.
- [x] Reusable composite action: `katesaikishore/AirlockQA@v1`; callers only add a secret and a four-line workflow.
- [ ] GitHub Marketplace listing for the action.
- [ ] GitHub App: webhook, check run, comment, installation token, private repositories.
- [ ] Private repositories and a secrets/env mechanism for builds.
- [ ] More than one concurrent QA run (the staging host has four slots; the API currently allows one global QA run).
- [ ] Password reset, email verification, billing and a paid plan.
- [ ] A public report gallery with retention and consent rules for screenshots.

## Metrics to watch

- CLI clones → first local QA run.
- First local run → first hosted run.
- Hosted run → Action installed.
- Action installed → App installed.
- App installed → private repo / paid workspace.
- Time from PR opened to verdict; percentage of runs that find at least one S1/S2 finding.

## Guardrails for public reports

Screenshots can contain customer data, tokens in the DOM, or third-party content. Before publishing an external report:
use a throwaway deployment or seeded data, review every screenshot, redact anything that is not the app's own UI, and
never publish a report from a private repository without written permission.
