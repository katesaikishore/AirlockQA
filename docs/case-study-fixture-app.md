# Case study: 11 findings in one seeded fixture app

This is the public proof run for the GitHub Action and the hosted QA pipeline. The target is
[`katesaikishore/airlock-fixture-app`](https://github.com/katesaikishore/airlock-fixture-app), a deliberately seeded
fixture app. **The bugs are intentional**; this is a control, not a claim about a customer.

## The result

| | |
| :--- | :--- |
| Run | [`run_qa_5c2f33c545f64790`](https://qbrin.cloud/console#qa/run_qa_5c2f33c545f64790) |
| Repository | https://github.com/katesaikishore/airlock-fixture-app |
| Commit | `5880ef5f0242ef050c46500f3dff50d67ccd7ffd` |
| Gate | `strict` |
| Suites | `smoke` passed, `explore` failed |
| Findings | **11** (2 × S2, 7 × S3, 2 × S4) |
| Screenshots | **5** |
| Signed evidence | Ed25519, key `ed25519:5a088e6176da6d26` |

The merged report and screenshots are in the fixture repository:
[`report.md`](https://github.com/katesaikishore/airlock-fixture-app/blob/main/qa-reports/run_qa_5c2f33c545f64790/report.md)
· [pull request #1](https://github.com/katesaikishore/airlock-fixture-app/pull/1)

The two S2 findings were visible only after driving the running app:

- `GET /api/stats` returned **HTTP 500** on `/dashboard`.
- An **uncaught TypeError** fired on `/dashboard` (`Cannot read properties of undefined (reading 'run')`).

The checker also recorded a dead docs link, missing security headers, insecure session cookies, a console error, a
missing image alt and an oversized asset. Each finding has its own screenshot and the run has a signed ledger.

## What this proves

- The checker drives the **running UI**, not just a test suite.
- Failure screenshots are stored with the run and can be attached to a PR.
- The run produces a **signed evidence bundle** that can be verified with the service public key.
- The same report can be posted by the GitHub Action; the merged fixture PR is the end-to-end example.

## A real-repository run

The weekly hunt also ran against [`umami-software/umami`](https://github.com/umami-software/umami) at a pinned commit.
That run passed (`run_qa_4d138e11684f45bb`) and its report is in
[`qa-hunt/2026-11-08`](https://github.com/katesaikishore/AirlockQA/tree/main/qa-hunt/2026-11-08). A passing run is a
useful result too: it is evidence that the checker completed rather than a claim that the app is bug-free.

## Reproduce it

```bash
# Local, against any public repository
airlock qa --repo https://github.com/owner/repo --sha <commit> --suites smoke,explore --wait

# Hosted, from GitHub Actions
# Copy actions template or use katesaikishore/AirlockQA@v1
```

The fixture app is intentionally vulnerable and slow. Do not deploy it as a template for production.


AirlockQA is free for public repositories. The Pro waitlist for private repositories, SSO and longer retention is at https://qbrin.cloud/pricing/.
