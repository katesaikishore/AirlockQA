# Contributor path

## First contribution

1. Install: `npm install -g qafind` or clone this repo and run `bun install`
2. Run the tests: `bun test`
3. Pick an issue labeled `good first issue` or `docs`
4. Comment that you are taking it

Good first tasks that need no deep knowledge:

- add a Playwright project layout to `examples/`
- improve a docs page with a failing screenshot or command
- add a test fixture for a CI provider
- report a false flake classification with the reporter manifest

## Before a pull request

- Add a test if behavior changed
- Run `bun test` and `bun run build`
- Do not commit secrets, customer data, or generated artifacts
- For browser-code changes, add or update the request-policy tests

## Review

Maintainers aim to respond within two business days. Small focused PRs are easier to review than large
mixed changes. If a PR is stale, a polite bump is fine.
