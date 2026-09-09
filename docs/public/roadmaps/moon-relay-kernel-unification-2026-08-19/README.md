# Moon Relay Kernel Unification

Status: implemented in the current checkout; final acceptance remains owned by the Kernel Control Plane.

## Authority boundary

The Kernel Control Plane is the only authority for task contracts, capability decisions, work steps, capsules, mutation provenance, proof receipts, independent review receipts, knowledge promotion, and completion. Standalone utilities may read the project and write account-root artifacts, but they cannot mutate source, prove a Kernel obligation, issue a Review Receipt, or complete a run.

The public standalone membership is catalog-driven by [`catalog/standalone-skills.json`](../../../../catalog/standalone-skills.json). The materialized package lock is [`package/kernel/standalone-skills.lock.json`](../../../../package/kernel/standalone-skills.lock.json); the generic dispatcher is [`bin/moon-relay-standalone.mjs`](../../../../bin/moon-relay-standalone.mjs).

## Utility groups

- Project utilities: `project-memory`, `kernel-commit`, and `codebase-understanding`.
- Analysis utilities: `explain-diff-html`, `ui-audit`, and `codebase-master-guide`.
- Pre-work utilities: `product-definition` and `architecture-artifacts`.

Pre-work emits a `TASK_CONTRACT_SEED` containing artifact digest, source provenance, referenced artifacts, objective, acceptance, constraints, non-goals, and seed digest. Kernel normalization rejects a stale or invalid seed before execution.

## Kernel-native behavior

Frontend, browser-proof, security-review, systematic-debugging, and simplification guidance are conditional Kernel capabilities. Browser evidence depth is derived from the task contract, and security review is independent when the risk surface requires it; neither utility artifacts nor static analysis can fabricate the corresponding Kernel receipts.

Kernel installs and runs the managed Node runtime only. Provider binaries remain native to the host installation, provider data remains in the isolated provider home, and the Kernel payload declares Relay runtime dependency as forbidden. Account-root setup installs and bootstraps Kernel ownership before materializing the legacy Relay compatibility profile; `npm run setup:kernel` exposes the Kernel-only path. The policy is implemented by [`scripts/switcher/native-provider.mjs`](../../../../scripts/switcher/native-provider.mjs) and declared in [`package/kernel/manifest.json`](../../../../package/kernel/manifest.json).

## Replacement and closeout

The complete legacy replacement classification is [`catalog/relay-replacement-matrix.json`](../../../../catalog/relay-replacement-matrix.json). `npm run test:kernel-unification` verifies G1-G14, including catalog/lock/CLI parity, non-authority boundaries, mutation-only closeout admission, native provider policy, replacement coverage, and declared regression gates.

Git mutation is admitted only from a completed Kernel run with matching project/workspace identity, source identity, mutation revision, changed paths, and recorded mutation provenance. The official closeout implementation is [`scripts/kernel/standalone/kernel-commit.mjs`](../../../../scripts/kernel/standalone/kernel-commit.mjs).
