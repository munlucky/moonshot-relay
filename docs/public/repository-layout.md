# Repository Layout

This repository separates canonical source, local runtime profiles, generated package payloads, compatibility wrappers, and runtime state.

## Canonical Source

Kernel/Host source lives in `src/`. `package/source-layout.json` owns source/output mappings and dependency boundaries. `tools/build/` generates the `.mjs` runtime. See [development.md](development.md).

Durable source files live in the root-level source directories:

- `skills/` for skill definitions
- `catalog/` for skill catalog authority, public/internal routing metadata, and package surface drift checks
- `agents/` for agent definitions
- `rules/` for workflow and policy rules
- `scripts/` for maintained installer, MCP, memory, and closeout support scripts
- `archive/scripts/legacy-phase-adapters/` for preserved delegated-terminal adapters, diagnostics, and script-local tests that are no longer installed
- `bin/` for CLI entrypoints
- `tools/` for runtime tooling source
- `schemas/` for machine-readable contracts
- `templates/` for reusable templates
- `tests/` for package and materialization checks
- `tests/fixtures/` for deterministic regression inputs
- `docs/public/` for contributor-facing documentation
- `docs/public/reference/` for source-owned operational reference catalogs that are not active runtime contracts
- `docs/public/roadmaps/` for source-owned long-running roadmap packages that should be reviewed and tracked
- `.github/` for CI/security source configuration and `required-checks.json` check-name fixtures

Do not add new canonical source under root `.claude/`, `.codex/`, or `.qwen/`. Those directories are local runtime profiles and must not be tracked by Git. References to `.claude/...`, `.codex/...`, or `.qwen/...` are valid when they describe installed payloads, local runtime wrapper entrypoints, active local profile contracts, or legacy generated-state cleanup. They are not valid when they tell contributors to edit `.claude/skills`, `.claude/agents`, `.claude/scripts`, `.claude/bin`, `.claude/tools`, `.claude/schemas`, `.claude/templates`, `.codex/skills`, or `.qwen/skills` as the durable source of truth.

## Generated Kernel Runtime

`scripts/kernel/`, `scripts/host/kernel/`, and the shared/CLI output files declared in `package/source-layout.json` are generated compatibility paths. Edit `src/` instead. `npm ci` builds them through prepare; `npm run build` refreshes them. `dist/runtime-build.json` is an ignored build receipt. Package and installer entrypoints reject stale checkout output. Installed payloads execute without source or the TypeScript compiler. Other scripts/bin/tool paths retain their existing ownership.

## Local Runtime Profile

Root `.claude/`, `.codex/`, and `.qwen/` are runtime profile locations for local execution only. They may contain compatibility wrappers, generated copies, repository-local configuration, or runtime-specific profile files, but remote repositories must not contain them. They are not the canonical source location for new skills, support scripts, CLI entrypoints, tools, rules, schemas, templates, verification contracts, or project knowledge state.

The root-level canonical directories must contain real harness files, not README-only placeholders. `tests/package-layout.test.mjs` guards that requirement so an empty scaffold cannot pass as the refactored repository shape.

Local agents may still read `.claude/CLAUDE.md`, `.claude/verification.contract.yaml`, and selected `.claude/rules/**` files after installation or materialization. Treat those files as local runtime output derived from canonical docs, schemas, or root source directories.

## Package Payload

`package/package-contract.yaml` declares what Claude, Codex, Qwen, and Antigravity package assembly must include. `package/profile-templates/`, `package/build-package.mjs`, `.claude-plugin/`, and `.codex-plugin/` are the committed package boundary. `package/claude/profile/`, `package/codex/profile/`, `package/qwen/profile/`, and `package/antigravity/profile/` are ignored generated payload roots derived from canonical source and the package contract.

Default installs materialize shared Moonshot Relay runtime assets under `.moonshot-relay/` and only runtime-discovered exposure entries under `.claude/`, `.codex/`, `.qwen/`, and `.gemini/antigravity/`, with Antigravity public skills additionally projected to `.gemini/config/skills/`. The shared common payload preserves canonical `skills/**` and `catalog/moonshot-catalog.json`, while runtime skill discovery is allowlisted by `package/runtime-surface.json` to `product-orchestrator`, `moonshot-architecture`, `moonshot-orchestrator`, `moonshot-phase-runner`, `moonshot-plan-writer`, `commit-moonshot`, `session-logger`, and `explain-diff-html`. Reinstalling prunes canonical source skills that are no longer in the service profile payload and keeps unrelated user-installed skills. Claude keeps `.claude/rules/`, `.claude/skills/`, and `.claude/agents/`; Codex keeps `.codex/rules/`, `.codex/skills/`, and `.codex/agents/`; Qwen keeps `.qwen/rules/`, `.qwen/skills/`, and `.qwen/agents/`; Antigravity keeps `.gemini/antigravity/agents/` and `.gemini/antigravity/rules/` while its global discovery skills live under `.gemini/config/skills/`. Project-local installs continue to materialize local `.claude/` payloads only when `install-claude.sh --project` is used from a supported macOS/Git Bash compatibility shell. Workflow orchestration no longer receives `scripts/**` wholesale. This compatibility behavior is intentional and should be verified with `node scripts/catalog-check.mjs --json`, `node bin/moonshot-relay.mjs install --dry-run --runtime all`, `node scripts/install-account-root-harness.mjs --runtime all --dry-run`, and Git Bash/macOS `bash install-claude.sh --project --dry-run` when project-local compatibility output changes. In WSL/Linux bash environments where `install-claude.sh` reports `unsupported shell: Linux`, use the Node installer path.

Account-root installs use `scripts/install-account-root-harness.mjs` and write common harness-owned payloads into `MOONSHOT_RELAY_HOME`, defaulting to `~/.moonshot-relay`, with thin Claude/Codex/Qwen exposure layers in `%USERPROFILE%/.claude`, `%USERPROFILE%/.codex`, and `%USERPROFILE%/.qwen` plus Antigravity profile files in `%USERPROFILE%/.gemini/antigravity` and global skills in `%USERPROFILE%/.gemini/config/skills` on Windows or the corresponding account roots on macOS/Linux. Use `%MOONSHOT_RELAY_HOME%` in `cmd.exe`, `$env:MOONSHOT_RELAY_HOME` in PowerShell, and `${MOONSHOT_RELAY_HOME}` in bash/zsh. They do not create or depend on nested `harness-core` directories. Runtime-local files such as settings, auth, sessions, caches, plugins, memories, sqlite databases, project knowledge state, execution evidence, phase status, logs, and verification verdicts remain outside the installed harness payload.

## Generated State

Generated state is excluded from package payloads. Logs, caches, traces, browser artifacts, browser runtime materialization, sqlite runtime state, memorygraph data, temporary directories, audit outputs, and verification verdict files must remain outside canonical source and package assembly. Regression fixtures are source-owned test inputs under `tests/fixtures/`, not runtime payload.

## Roadmaps And Execution Scratch

Tracked roadmap packages live under `docs/public/roadmaps/` when they define durable harness direction, review evidence, phase contracts, or implementation gates. For example, `docs/public/roadmaps/harness-control-plane-modernization/` is a source-owned roadmap package.

Default implementation plan packages live under `${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}/state/projects/<projectId>/planning/packages/<plan-slug>/`, where `<projectId>` is resolved by `scripts/project-identity.mjs`. This keeps concurrent work across repositories separated. Source-local implementation plan packages may still live under `docs/implementation/<plan-slug>/` only when they are intentionally tracked source design artifacts. New `docs/implementation/**` files are ignored by default; explicit tracked-source packages need a slug-specific `.gitignore` exception from `scripts/install-project-runtime-bridge.mjs --plan-package docs/implementation/<plan-slug>` or a deliberate force-add. Runtime execution scratch defaults to `${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}/state/projects/<projectId>/execution/.../plans/<plan-slug>/runs/<runId>/execution/` and remains excluded from package payloads. Phase-runner readiness JSON, attempt manifests, QA reports, scorecards, handoffs, local phase status, and generated execution evidence are not tracked source and are not package payload.

`scripts/prepare-phase-runner-state.mjs` exposes the selected plan root as `planRootKind`. `source_roadmap` means durable roadmap source under `docs/public/roadmaps/**`; `tracked_source_design` means intentionally tracked implementation design under `docs/implementation/**`; `account_project_planning` means the default operational package under the account-root project namespace. Source roadmaps may still be inspected by the runner, but ordinary implementation should use an account-root package unless the operator explicitly wants source-owned plan artifacts.

## CI And Release Protection

`.github/workflows/**`, `.github/dependabot.yml`, `.github/CODEOWNERS`, and `.github/required-checks.json` are tracked source configuration.
They can establish `source-ci-ready` when local parse and dry-run gates pass.
They do not prove `github-settings-applied` or `release-protected`.

GitHub branch protection, required status checks, CODEOWNERS review enforcement, dependency review enforcement, secret scanning, and push protection must be applied through GitHub UI/API and captured as operational evidence before claiming `release-protected`.

## Public Guideline Classification

`docs/public/guidelines/**` is a durable public policy/reference layer. These files are intentionally compact anchors unless a row below is classified as `operational-procedure`. Operational details belong in durable source such as `docs/public/reference/**`, `package/package-contract.yaml`, `skills/**`, `agents/**`, or `scripts/**`; phase plans record execution decisions and evidence, not the long-term operational source of truth.

| Guideline file | Class | Durable detail owner |
|----------------|-------|----------------------|
| `agent-operating-policy.md` | policy-anchor | `skills/moonshot-orchestrator/**`, `skills/moonshot-phase-runner/**`, `schemas/agent-operation.contract.yaml`, `tests/agent-policy/**` |
| `artifact-routing-policy.md` | policy-anchor | `schemas/artifact-routing.schema.yaml`, `tests/agent-policy/artifact-routing.test.mjs`, source/runtime package boundary docs |
| `asr-extraction.md` / `asr-extraction.ko.md` | policy-anchor | `skills/moonshot-architecture/**`, planned architecture artifact schemas |
| `brownfield-architecture-recovery.md` / `brownfield-architecture-recovery.ko.md` | policy-anchor | `skills/moonshot-architecture/**`, planned `skills/codebase-architecture-recovery/**` |
| `c4-adr-design-contract.md` / `c4-adr-design-contract.ko.md` | policy-anchor | `skills/moonshot-architecture/**`, planned architecture templates |
| `code-review-graph-workflow.md` | policy-anchor | `skills/codex-review-code/**`, `scripts/code-review-graph-mcp-wrapper.js` |
| `context-readiness-schema.md` / `context-readiness-schema.ko.md` | reference-index | `skills/context-readiness-gate/**`, `agents/context-builder*` |
| `context-relevance-policy.md` | policy-anchor | `scripts/knowledge-context-build.mjs`, `skills/*orchestrator*/**`, project-local knowledge anchor contracts |
| `daily-retro-workflow.md` / `daily-retro-workflow.ko.md` | operational-procedure | planned retro schemas, templates, tools, skill, and tests |
| `demo-first-mvp-gate.md` | policy-anchor | `skills/product-orchestrator/**`, `skills/product-gate-reviewer/**` |
| `document-memory-policy.md` | policy-anchor | `agents/*memory*`, `skills/doc-auto-sync/**`, `skills/commit-moonshot/**` |
| `external-skill-pattern-transfer.md` | policy-anchor | `skills/moonshot-relay-maintainer/**`, `skills/moonshot-teams-runner/**`, `rules/workflow*`, `templates/agent-teams-config.yaml` |
| `harness-bootstrap-lab.md` | operational-procedure | `tools/harness-lab/harness-lab.mjs`, `tests/harness-lab-contract.test.mjs` |
| `kernel-codex-host-dispatch-recovery.md` | policy-anchor | `scripts/host/kernel/adapters/codex.mjs`, Kernel Codex host tests |
| `kernel-codex-independent-review.md` | policy-anchor | `scripts/host/kernel/adapters/codex.mjs`, `scripts/kernel/proof/review-receipt.mjs`, Kernel review tests |
| `kernel-execution-capsule-and-step-ledger.md` | policy-anchor | `scripts/kernel/run/execution-capsule.mjs`, `scripts/kernel/run/run-step-ledger.mjs`, `scripts/kernel/routing/route-admission.mjs`, `scripts/kernel/proof/review-receipt.mjs`, `schemas/kernel.execution-capsule.schema.json`, `schemas/kernel.route-admission.schema.json` |
| `kernel-evidence-and-completion-lifecycle.md` | policy-anchor | `scripts/kernel/control-plane.mjs`, `scripts/kernel/proof/proof-executor.mjs`, `scripts/kernel/run/run-loop.mjs`, Kernel completion/evidence tests |
| `knowledge-repository-ops.md` | policy-anchor | `scripts/knowledge-*.mjs`, `docs/public/project-knowledge-plane.md` |
| `long-running-harness.ko.md` | policy-anchor | `skills/moonshot-phase-runner/**`, `skills/moonshot-in-session-coordinator/**` |
| `memory-control-plane.md` | policy-anchor | `schemas/memory-claim.schema.json`, `schemas/task-evidence-graph.schema.json`, `scripts/lib/memory-control-plane-contracts.mjs`, `tests/*memory*contract.test.mjs` |
| `memory-control-plane-rollout.md` | operational-procedure | `package/build-package.mjs`, `scripts/install-account-root-harness.mjs`, package materialization tests, eval and lab gates |
| `moon-relay-kernel-codex-app.md` | policy-anchor | `scripts/kernel/runtime-home.mjs`, `scripts/skill-router.mjs`, `bin/moon-relay-kernel.mjs`, Kernel profile package |
| `moon-relay-kernel-installation.md` | operational-procedure | `scripts/kernel/installer.mjs`, `scripts/kernel/package-build.mjs`, Kernel install isolation tests |
| `moon-relay-kernel-session-run-lifecycle.md` | policy-anchor | `scripts/kernel/control-plane.mjs`, `scripts/kernel/run/execution-capsule.mjs`, `bin/moon-relay-kernel.mjs` |
| `moon-relay-kernel-track.md` | policy-anchor | `scripts/kernel/runtime-home.mjs`, `package/kernel/manifest.json`, Kernel isolation tests |
| `memorygraph-workflow.md` / `memorygraph-workflow.ko.md` | policy-anchor | `scripts/memorygraph-*.mjs`, `skills/project-memory-refresh/**` |
| `minimal-correct-implementation.md` | policy-anchor | `skills/moonshot-orchestrator/**`, `skills/moonshot-phase-runner/**`, `templates/execution/SCORECARD.template.md` |
| `moonshot-architecture.md` / `moonshot-architecture.ko.md` | policy-anchor | `skills/moonshot-architecture/**`, `docs/public/roadmaps/moonshot-architecture/**` |
| `product-acceptance-gate.md` | policy-anchor | `skills/completion-verifier/**`, `skills/product-gate-reviewer/**` |
| `product-definition-workflow.md` | policy-anchor | `skills/product-orchestrator/**`, `templates/product-definition/**` |
| `plan-review-canvas.md` | operational-procedure | `tools/plan-canvas/plan-canvas.mjs`, `schemas/plan-feedback.schema.json`, `tests/plan-canvas-contract.test.mjs` |
| `provider-neutral-model-routing.md` | policy-anchor | runtime profile config templates and routing docs |
| `codex-gpt-5-6-cost-control.md` | policy-anchor | Codex GPT-5.6 adapter policy and cost-guard tests |
| `requirements-traceability-harness.md` | policy-anchor | `skills/task-slicer/**`, tracked `docs/public/roadmaps/**` contracts, runtime `docs/implementation/**` execution scratch |
| `research-evidence-policy.md` | policy-anchor | `skills/product-orchestrator/**`, `skills/moonshot-architecture/**`, `schemas/retrieval-evidence.schema.yaml` |
| `resumable-session-layer.md` | policy-anchor | phase-runner state helpers and runtime state docs |
| `retrieval-and-recency-policy.md` | policy-anchor | `schemas/retrieval-evidence.schema.yaml`, `tests/agent-policy/retrieval-policy.test.mjs` |
| `safety-drift-and-cumulative-risk.md` | policy-anchor | `schemas/agent-operation.contract.yaml`, runtime event and verification evidence payloads |
| `session-compaction.md` | policy-anchor | `skills/session-logger/**`, `docs/public/reference/session-logger-reference.md` |
| `skill-composition.md` | policy-anchor | `skills/**`, `package/package-contract.yaml` |
| `skill-readiness-policy.md` | policy-anchor | `schemas/skill-readiness.schema.yaml`, `tests/agent-policy/skill-readiness.test.mjs`, task-profile skill consultation evidence |
| `strategy-gate-rubric.md` / `strategy-gate-rubric.ko.md` | reference-index | `skills/plan-ceo-review/**`, `skills/plan-eng-review/**` |
| `token-optimization.md` | policy-anchor | `skills/commit-moonshot/**`, session logging guidance |
| `untrusted-content-boundary.md` | policy-anchor | `schemas/untrusted-content-boundary.schema.yaml`, `tests/agent-policy/untrusted-content-boundary.test.mjs`, sandbox/protected-path policy |
| `verification-contract.md` / `verification-contract.ko.md` | reference-index | `schemas/verification.contract.yaml`, `agents/verification/**` |
| `verification-workflow-evidence.md` / `verification-workflow-evidence.ko.md` | policy-anchor | `skills/completion-verifier/**`, `docs/public/guidelines/verification-contract.md` |

The existing public guideline content test is a placeholder detector only. Add semantic required-field tests only for files classified as `operational-procedure`.

## Contributor Rule

When adding a new skill, catalog entry, agent, rule, support script, CLI entrypoint, runtime tool, schema, template, or test:

1. Edit the matching canonical root directory first, such as `skills/`, `catalog/`, `agents/`, `rules/`, `scripts/`, `bin/`, `tools/`, `schemas/`, `templates/`, or `tests/`.
2. Update public docs in `docs/public/` when the contributor workflow or installed behavior changes.
3. Regenerate or refresh profile/package output through the materialization path declared by `package/package-contract.yaml`.
4. Keep root `.claude/`, `.codex/`, and `.qwen/` local-only; regenerate them from canonical source instead of committing them.

Do not manually maintain duplicate source directories under root `.claude/`, `.codex/`, or `.qwen/`; duplicate runtime output must be reproducible from canonical source or explicitly documented as a temporary compatibility wrapper.
