# Outreach targeting: QA-first, framework-aware

QAFind is a QA product. Playwright is today's deepest integration, not the boundary of the product.

## What we can honestly offer today

| Project type | Offer | Do not claim |
|---|---|---|
| Playwright suite, public CI/artifacts | Full read-only Verified Merge audit: affected specs, rerun, regression vs flake, signed evidence | Nothing about tests we did not run |
| Cypress / Selenium / WebdriverIO / Puppeteer / TestCafe | Hosted browser QA audit of a public environment, or a framework-integration conversation; require maintainer consent | That QAFind ingests their reporter output today |
| QA/test-infra project | Read-only audit of its own public test suite; flake/reproduction analysis where artifacts exist | That QAFind replaces their tool |
| Public website with no suite | Hosted browser QA audit only after maintainer permission | Unsolicited testing of private or staging systems |
| Framework-agnostic flaky/CI issue | Reproduce from public artifacts where possible; classify with evidence | Guessing at a root cause without a reproduction |

## Roadmap implication

Framework-agnostic ingestion is a product requirement, not an outreach trick:

1. JUnit XML ingest (Cypress, Selenium, WebdriverIO, most CI runners)
2. Cypress JSON / Mochawesome
3. WebdriverIO and Playwright JSON normalization
4. One signed verdict format across all of them

Until then, outreach must say **"Playwright is supported today; here is what we can do for your stack"** — never imply parity.

## Message rules

- One issue per project; no follow-up without a reply.
- Offer a read-only audit first.
- No cold PR, no required-check change, no repository files.
- No star request in a first message or PR. Optional star footer only in the audit report after delivering value.
- If the maintainer says no, record it and do not contact again.
