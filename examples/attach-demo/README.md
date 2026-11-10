# Attach demo — an unmodified Playwright suite

This project is a normal Playwright suite: its config imports only `@playwright/test`, and its specs
have no Airlock imports. The attach path adds one generated wrapper, a reporter, and (with
`--determinism`) a tsconfig alias + auto-use fixture for network replay and a fixed clock.

From this directory, with the repository dependencies installed:

```bash
# 1. Attach (writes .airlock/*; original config untouched)
bun ../../bin/airlock.ts attach . --determinism

# 2. Seed deterministic network + record the suite (starts the local store)
AIRLOCK_CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  AIRLOCK_ATTACH_NETWORK=record FLAKE_ROUND=1 bunx playwright test --config .airlock/playwright.airlock.config.ts

# 3. Replay with no network dependency (webServer is disabled by the config for replay)
AIRLOCK_CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  AIRLOCK_ATTACH_NETWORK=replay FLAKE_ROUND=1 bunx playwright test --config .airlock/playwright.airlock.config.ts

# 4. Triage (run rounds 1..3 to seed the three flaky cases first)
AIRLOCK_ATTACH_NETWORK=record FLAKE_ROUND=2 bunx playwright test --config .airlock/playwright.airlock.config.ts
AIRLOCK_ATTACH_NETWORK=record FLAKE_ROUND=3 bunx playwright test --config .airlock/playwright.airlock.config.ts
bun ../../bin/airlock.ts flake .airlock/reports --markdown
bun ../../bin/airlock.ts flake .airlock/reports --owner-map owners.json --quarantine .airlock/quarantine.json
```

Each round exits non-zero because one test fails by design; the reporter still writes the manifest.
`airlock flake` reports the three seeded tests as flaky (network fixture, selector drift, timing), the
stable failure as not flaky, and it reads `.airlock/ledgers/` as corroborating evidence.

The generated `.airlock/` directory is disposable; the demo's original config and all specs are
unchanged by attach except the seeded tests themselves. Replay proof is in
[`artifacts/attach-flake-demo/determinism`](../../artifacts/attach-flake-demo/determinism).
