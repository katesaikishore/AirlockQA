# Verified Merge demo suite

A real Playwright suite used to prove the two outcomes end-to-end:

- `tests/regression.spec.ts` — fails on every run → **regression** → exit 1
- `tests/flake.spec.ts` — fails once, then passes → **flake** → exit 0
- `tests/passing.spec.ts` — always passes

Run the regression path:

```bash
AIRLOCK_SIGNING_KEY=... bun bin/airlock.ts verify-merge --run \
  --specs examples/verified-merge-demo/tests/regression.spec.ts \
  --repo demo/regression --pr 1 \
  --command "npx playwright test {specs} --config=examples/verified-merge-demo/playwright.config.ts"
```

Run the flake path (clear the marker first):

```bash
rm -f /tmp/airlock-flake-marker-demo
AIRLOCK_SIGNING_KEY=... bun bin/airlock.ts verify-merge --run \
  --specs examples/verified-merge-demo/tests/flake.spec.ts \
  --repo demo/flake --pr 2 \
  --command "npx playwright test {specs} --config=examples/verified-merge-demo/playwright.config.ts"
```

Recorded results on 2026-11-10:

| Spec | First run | Rerun | Verdict | Exit |
|---|---|---|---|---|
| regression.spec.ts | failed | failed | 1 regression | 1 |
| flake.spec.ts | failed | passed | 1 flake | 0 |
