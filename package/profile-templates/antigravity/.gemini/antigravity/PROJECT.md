# PROJECT.md

> Contract for the Harness Project repository that stores reusable Antigravity workflow settings and verification tooling.

Last-Reviewed: 2026-07-16

## Project Overview

- **Service**: Harness Project - self-hosted repository for reusable Moonshot Relay rules, skills, agents, scripts, templates, and verification contracts
- **Stack**: Node.js (>=20, ESM), TypeScript, SQLite, Bash, Python 3, Markdown, YAML, Git worktrees
- **Response Language**: Korean by default unless the request explicitly asks for another language

## Core Rules

1. `main` receives only reusable harness source files; generated test outputs, temporary worktrees, and run artifacts stay ignored.
2. Recursive harness improvement runs happen on an isolated recursive branch/worktree, and `main` stays clean until an explicit selective release step.
3. Updating `main` is an explicit release step limited to the approved harness whitelist and strict `meta_harness` verification checks; a temporary release-candidate worktree is optional, not part of the daily default.
4. Real implementation tests must define `IMPLEMENTATION_TEST_BRIEF.md` and `RUN_MANIFEST.md` before implementation begins if the run will count toward harness quality normalization.
5. Release-readiness evidence should prioritize `large` full-stack web benchmark runs that separate `one-prompt baseline` from `recursive improvement delta`.
6. A large-web benchmark that only proves contract fit is not enough to validate the harness execution engine; release evidence should also include a `phase_runner_execution` run.

## Testing Rules

- **Test framework**: Node test contract gates plus account-root installer/package dry-run checks
- **Commands**:
  - `npm test`
  - `npm run test:package`
  - `node package/build-package.mjs --runtime all --dry-run --json`
  - `node scripts/install-account-root-harness.mjs --runtime all --source-root . --dry-run --json`
- **Legacy compatibility**: profile-local workflow script adapters are not active package/install commands. Use archived legacy adapter checks only with an explicit legacy compatibility reason.

## Directory/Structure

```text
[project root]/
|-- bin/
|-- src/             # canonical Kernel/Host TS source (edit src/, not generated scripts/kernel/ or scripts/host/kernel/)
|-- agents/
|-- skills/
|-- rules/
|-- scripts/
|-- schemas/
|-- templates/
|-- tests/
|-- docs/public/
|-- package/source-layout.json
|-- package/profile-templates/
`-- README.md
```

## API/Data Communication Patterns

- **API endpoints**: No persistent network API; repository behavior is exposed through local shell scripts and Git workflows
- **Helper functions**: installed shared scripts under `<MOONSHOT_RELAY_HOME>/scripts/` and verification helpers exposed through profile-local `agents/verification/`
- **Contract exchange**: Policy lives in profile-local `verification.contract.yaml`, task memory lives under `documentPaths.tasksRoot`, and generated workflow evidence is written under `.moonshot-relay/`; daily work happens on an isolated worktree and any release-candidate worktree is temporary

## Type/Domain Patterns

- **Type definition location**: YAML contracts in profile-local `verification.contract.yaml`; operational schemas and checklists in `${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}/docs/public/guidelines/`
- **Domain models**: `REQ-*`, `SCN-*`, `UAT-*`, `policySets`, scorecard objectives, and harness promotion whitelist entries

## Auth/Authorization

- **Auth method**: Local filesystem permissions and Git branch/worktree isolation
- **Authorization model**: Destructive or out-of-sandbox actions require explicit approval; `main` updates require an explicit selective release step from the recursive branch or an optional temporary release-candidate worktree
- **Sensitive-path policy**: `.gitignore`, ignored `.tmp/harness-*` directories, and strict `meta_harness` verification prevent runtime artifacts from being committed

## Document Paths

```yaml
documentPaths:
  tasksRoot: ".moonshot-relay/docs/tasks"
  agreementsRoot: ".moonshot-relay/docs/agreements"
  guidelinesRoot: "${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}/docs/public/guidelines"
```

## Environment Variables

```text
HARNESS_RECURSIVE_BRANCH
HARNESS_RECURSIVE_WORKTREE
HARNESS_RECURSIVE_BASE_BRANCH
HARNESS_PROMOTION_TARGET_BRANCH
HARNESS_PROMOTION_TARGET_WORKTREE
HARNESS_PROMOTION_TARGET_BASE_BRANCH
HARNESS_PROMOTION_PATHS_FILE
HARNESS_AGENT_CONFIG_SOURCE
```
