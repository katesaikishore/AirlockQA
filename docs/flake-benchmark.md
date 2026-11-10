# Flake classification benchmark

- Mode: synthetic
- Tests: 400
- Runs analyzed: 5
- Accuracy threshold: 0.9

## Accuracy

| Evidence | Correct | Total | Accuracy |
| :--- | ---: | ---: | ---: |
| Error text only | 281 | 320 | 87.8% |
| Error text + request ledger | 289 | 320 | 90.3% |

## Per-cause precision / recall (request-ledger mode)

| Cause | Precision | Recall | Support |
| :--- | ---: | ---: | ---: |
| network_fixture | 100.0% | 100.0% | 53 |
| policy_block | 100.0% | 85.2% | 54 |
| selector_drift | 100.0% | 85.2% | 54 |
| timing | 100.0% | 85.2% | 54 |
| app_race | 100.0% | 86.8% | 53 |
| unknown | 62.7% | 100.0% | 52 |

## Method and honest limits

- The default suite is **synthetic**: 400 tests × 5 runs with seeded outcomes and error text per class (80 stable controls). Ground truth is known by construction, so this measures the classifier and the harness, not a customer suite.
- Real-suite mode accepts `--reports <dir> --labels <labels.json>`, where labels are test id → cause. That is the number to report publicly; it is intentionally not filled in here.
- Classification is deterministic text matching plus optional request-ledger evidence. Ledger evidence raises confidence when it confirms or contradicts the error text; it is not replay-based causal proof.
- A stable failure is never quarantined; quarantine quality is checked separately by the example demo and the flake tests.
