# Testing Guidelines

Detect test environment before writing or running tests.
- Classify changes as `docs_only`, `local_policy`, or `behavior_change`.
- Run the smallest relevant test scope first, then expand if needed.
- `behavior_change` should start from a failing test or deterministic proof when practical; bug fixes need regression coverage or equivalent evidence.
- Do not delete existing tests without an explicit reason.
- `docs_only` and most `local_policy` work may finish with audit plus syntax/evidence checks.
- `behavior_change` work must report missing executable verification and stay conservative.
- For this repository, run focused `node --test` suites plus `npm run typecheck`, `npm run build:check`, and `npm run check:boundaries`; run `bash -n` when shell scripts change.
- `implementation-runner` and `completion-verifier` stay conservative when coverage is missing.
