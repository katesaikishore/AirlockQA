# Requiring Airlock Verified Merge

Verified Merge reports the context **`Airlock Verified Merge`**. Make it a required check before merging to
`main` or a release branch.

## Required App permissions

| Permission | Access | Why |
|---|---|---|
| Metadata | read | installation token |
| Contents | read | checkout in the customer's CI (the hosted app does not need write) |
| Pull requests | write | PR comment |
| Statuses | write | fallback commit status |
| Checks | write | preferred native check run (optional) |

The App currently uses the commit-status fallback because `checks: write` has not been granted. Both the
check run and the status use the same context name, so branch protection works either way.

## GitHub UI

Settings → Branches → Branch protection rules → `main`:

1. Enable **Require status checks to pass before merging**
2. Add **`Airlock Verified Merge`**
3. Optionally enable **Require branches to be up to date**

## GitHub rulesets API

```bash
gh api -X POST repos/OWNER/REPO/rulesets \
  --input - <<'JSON'
{
  "name": "protected-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [{ "context": "Airlock Verified Merge" }]
      } }
  ]
}
JSON
```

Do this only after the first Verified Merge report has been uploaded, otherwise PRs will wait for a check
that never arrives.

## CI workflow

```yaml
name: Verified Merge
on: pull_request
permissions:
  contents: read
jobs:
  verified-merge:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bunx playwright install --with-deps chromium
      - run: bun bin/airlock.ts verify-merge --run --upload
        env:
          AIRLOCK_API_KEY: ${{ secrets.AIRLOCK_API_KEY }}
          AIRLOCK_SIGNING_KEY: ${{ secrets.AIRLOCK_SIGNING_KEY }}
          GITHUB_SHA: ${{ github.event.pull_request.head.sha }}
          GITHUB_BASE_SHA: ${{ github.event.pull_request.base.sha }}
```

The hosted service never runs the customer's repository code; it only stores the signed verdict and posts
the check/status and comment.
