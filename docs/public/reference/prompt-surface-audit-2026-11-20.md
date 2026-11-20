# Moonshot Relay Prompt Surface Audit — 2026-11-20

## Scope and evidence

- Baseline: `main`, `e268bca472118f4f10394f70f9a00eefda8608c0` before this change.
- Method: review of the supplied Codex/Claude Prompt Audit findings, prior `artifacts/kernel-prompt-audit/` evidence, current canonical source, Git search, and the Host's actual prompt-dispatch call sites. Read-only inventory was followed by narrowly scoped fixes.
- Static discovery: 2,842 tracked files, 397 instruction/document candidates, 572 source/tooling code candidates, 82 canonical `skills/*/SKILL.md` files. These are *candidate counts*, not the number of instructions actually loaded into one model request.
- Runtime path: `src/host/kernel/model-capsule-view.ts` projects the six model-visible fields; `src/host/kernel/turn-dispatcher.ts`, `src/host/kernel/adapters/codex.ts`, and `src/host/kernel/adapters/claude.ts` use that projection. The standalone OpenAI/Claude renderer functions have tests, but no non-test import was found in the inspected `src/` and `scripts/` call graph. No conclusion about external consumers or package support follows from that observation.

## Applied fixes and acceptance

| Finding | Evidence | Change | Verification |
| --- | --- | --- | --- |
| Fixed Windows checkout path | `agents/harness-memory-promoter.md:16` and `.ko.md:16` | Express execution scope as the `moonshot-relay` Git worktree root; preserve all promotion approval and safety rules | New static regression test |
| Broken skill-relative Markdown links | `skills/commit-moonshot/SKILL*.md` References, `skills/session-logger/SKILL*.md` References | Correct fourteen link destinations to `../../docs/...` or `../../rules/...` in English and Korean | Resolve each Markdown target relative to its source file; new test |
| Codex profile labels generated code as source | `package/profile-templates/codex/AGENTS.md` Repository Structure versus `package/source-layout.json` | Identify `src/kernel/` and `src/host/kernel/` as canonical; identify `scripts/` as generated | Existing profile validation plus new regression test |
| Current audit inventory became stale after profile edit | `artifacts/kernel-prompt-audit/prompt-inventory.json` | Synchronize only current `AGENTS.md` bytes/lines (2,330 bytes, 51 lines) | Existing exact-byte inventory test |

## Deliberately not changed

- Prior `C01` compact prompt candidate was rejected (`keep-baseline`): historically baseline acceptance 12/12 vs candidate 11/12, with one scope violation. Continue using `buildModelVisiblePromptMessage()` in production; do not activate candidate or guidance ablation without new behavioral evidence.
- Do not remove `Kernel next/report`, bounded mutation, protected evidence, review independence, or completion authority rules based on uppercase emphasis alone. The scan found 66 candidate emphatic lines in 22 files; these are **not 66 confirmed defects**.
- Do not delete independent provider renderers without verifying external/package consumers and the actual desired provider wire interface.
- Do not add a new Prompt Audit framework, scheduled audit, Kernel stage, DB, or mandatory agent. A reusable Codex skill can be separately considered after native Codex invocation is available.
- Keep `artifacts/kernel-prompt-audit/prompt-size-before.json`, `prompt-size-after.json`, and the historical C01 decision unchanged. The live inventory is distinct from these historical records.

## Verification boundary

- Static edits and source-link resolution were tested on the Linux Moonremote workmachine in Pass 1 (`7d619bfa`).
- Per user direction during Pass 2, heavy test-suite runs and live task execution were deferred at this stage so audit and cleanup could finish without runtime delays; only lightweight static consistency checks were executed after the final Pass 2 edits.
- Native Codex task execution behavior, token savings, Claude model behavior, and installed profile link resolution remain **unmeasured** in live runs.
- Success of unit/contract tests or static checks does not establish improvement in real agent task completion. Any future prompt wording changes require the existing baseline/candidate replay quality gate, with failure and scope violations counted.

## Pass 3 — Kernel Relay Workflow Structural Improvements (KR-01 ~ KR-07, 2026-11-20)

| Item | Target | Change | Constraints Preserved |
| --- | --- | --- | --- |
| KR-01 | `src/kernel/bridge/mcp.ts`, `package/kernel/profiles/claude/settings.json`, `src/kernel/profile-install.ts` | Normalize MCP `surface` (`claude`/`gemini`/`ade`/`codex`), inject `MOON_RELAY_KERNEL_SURFACE=claude` into Claude MCP server env, and surface judgment-only `operator-approval` guidance when `execution-readiness-blocked` overrides a review action | Host/Kernel review authority unchanged; hard evidence remains mandatory |
| KR-02 | `src/kernel/control-plane.ts` | Extract shared `resolveRunCapabilityDecision` for `next()` and `buildStageContext()` wiring full semantic contract fields (`changedPaths` + `allowedPaths`/`steps[].allowedPaths` fallback), discovered `testSurfaceAvailable`, `repeatedFailure`/`repeatedBlocker`, and `completionAccepted`/`gitCloseoutRequested`/`knowledgeCommitReceiptExists` | Explicit contract flags take precedence; internal `kernel-test-driven-development` compaction and `GUIDANCE_BUDGET` unchanged |
| KR-03 | `src/kernel/run/run-loop.ts`, `src/kernel/run/model-view.ts` | Fix missing `nextAction` in `buildNextPayload` active-work-unit branch and deduplicate exact-match `requiredVerifications`, `workAuthority.currentWorkUnit`, and `acceptanceIds` in compact view | Top-level compatibility fields and `--verbose` snapshots preserved intact |
| KR-04 | `src/host/kernel/provider-prompt-policy.ts`, `model-capsule-view.ts`, `turn-dispatcher.ts`, `adapters/*`, `host-worker-sessions.ts`, `independent-subagent-review.ts` | Clarify Host-only `PromptEnvelope` vs 6-field `providerMessage` security boundary and unify adapters on `resolveModelVisiblePromptMessage` (`MOON_RELAY_KERNEL_COMPACT_PROMPT_MESSAGE` opt-in, default off) | `envelope` never forwarded to provider launchers; historical C01 baseline preserved by default |
| KR-05 | `package/kernel/profiles/claude/settings.json`, `src/kernel/profile-projection.ts`, `profile-install.ts`, `profile-doctor.ts` | Add `hooks.SessionStart` track guard to Claude `settings.json` (`458` B / `26` L after Pass 3) with empty-container uninstall cleanup and add read-only `detectUnmanagedManagedSectionDuplicates` warning/check to `doctorKernelProfile` | Unmanaged user text outside markers never deleted automatically |
| KR-06 & KR-07 | `src/host/kernel/io-{write,read}-hook.ts`, `kernel/host-boundary.yaml`, `catalog/relay-replacement-matrix.json` | Replace model codename (`Luna`) and `rg` reference in IO hooks with neutral wording; align stale `.mjs` references to compiled `.js` outputs | Existing hook protocols and tests preserved |
| KR-08 (Skill parity) | `skills/kernel-commit-closeout/SKILL.md`, `package/kernel/skills.lock.json` | Align `kernel-commit-closeout` rule with non-blocking knowledge policy (require completion acceptance prior to Git closeout; knowledge receipt non-blocking) and sync Kernel lock hash | Other 14 Kernel skills and 8 standalone skills audited and confirmed clean |

## Pass 2 — Structural Guardrails, Active Prompt Surfaces, and Cross-Provider Parity (2026-11-20, macOS Remediation on `7d619bfa`)

### Applied fixes and acceptance (Pass 2)

| Finding | Evidence | Change | Verification |
| --- | --- | --- | --- |
| F01 — Fixed phase number in generic runner | `skills/moonshot-phase-runner/SKILL*.md:46`, `references/compatibility-contract.md:28`, `tools/evals/public-skill-semantic-contract.json:103` | Replace `Phase 08 owns controlled adoption.` with `before the plan's designated controlled adoption phase.`, sync `policyDigest` (`86145baf...`), and sync `moonshot-phase-runner.hard-stop.09:fe1ef665bd31` | `scripts/lint-skills.mjs`, `skills-audit.mjs`, `generateSkillCompatibilityManifest()` |
| F02 — Stale canonical boundary in Codex repo contract | `package/profile-templates/codex/AGENTS.md:28` | Change protected core path from `scripts/kernel/` to `src/kernel/` per `package/source-layout.json` | Static contract & inventory sync |
| F03 — Implicit `@path` / env-var references in Codex profile | `package/profile-templates/codex/.codex/AGENTS.md:21-26` | State explicitly that Codex does not auto-expand `@path` or shell variables and document on-demand read intent for each reference | `auditAgentsMarkdown` policy check & inventory sync |
| F04 & public skill hygiene | `skills/commit-moonshot/SKILL*.md:92`, `skills/moonshot-orchestrator/SKILL*.md:49-52` | Replace Claude-only `$ARGUMENTS` with `current user request.`; fix procedure numbering `1,4,5,6` to `1,2,3,4`; sync `skills.lock.json` hashes for the 3 edited skills only | `scripts/lint-skills.mjs` (`commit-moonshot`: 2,352/2,353 tok, `moonshot-phase-runner`: 2,276/2,280 tok, `moonshot-orchestrator`: 986/1,087 tok), `skills-audit.mjs` |
| F05 & F06 — Envelope vs provider message & inventory scope | `artifacts/kernel-prompt-audit/prompt-inventory.json`, `prompt-envelope.ts`, `turn-dispatcher.ts` | Tag `prompt-inventory.json` with `"scope": "preset-07-kernel-core-surfaces-only"`, sync `codex/AGENTS.md` (2,326 B / 51 L) and `codex/.codex/AGENTS.md` (1,859 B / 28 L), and add measurement-distinction test | Static `statSync` inventory match & `tests/kernel-turn-dispatcher-envelope.test.ts` |
| F07 — Client leak & template bloat in enabled standalone skill | `skills/codebase-master-guide/{SKILL.md,references/curriculum-and-layout-spec.md,scripts/render_slidebook.py,agents/openai.yaml}`, `package/kernel/standalone-skills.lock.json` | Remove client-specific identifiers (`dgtId`, `ohiRequestId`, `O-HI`, `A40900`, `saveNftHoldings`, `UserIssuanceService`, `ShedLock`, `HikariCP`, `uint256`), reduce `SKILL.md` from 10,017 B (112 L) to 5,741 B (75 L), sync standalone lock hash (`3dc6199f...`), and add leak regression in `tests/active-contracts.test.mjs` | Static leak grep, `buildStandaloneLock()` hash parity, `scripts/lint-skills.mjs` |
| F08 — Stale `PROJECT.md` stack & directory map | `package/profile-templates/{claude/.claude,antigravity/.gemini/antigravity}/PROJECT.md` | Update stack to include Node.js (>=20, ESM), TypeScript, SQLite and list `bin/`, `src/`, `tests/`, and `package/source-layout.json` while preserving `documentPaths` | Static contract & `documentPaths` preservation |
| F09 — Stale `profile-contract.yaml` & non-Claude TOC references | `package/profile-templates/{claude/.claude,antigravity/.gemini/antigravity}/profile-contract.yaml`, `qwen/.qwen/QWEN.md`, `antigravity/.gemini/antigravity/GEMINI.md` | Replace `move_with_wrapper_until_phase_06` with `versioned_migration_only`, add `src/` and `bin/` to `durableSourceRoots`, and add on-demand `@path`/env-var note to Qwen/Antigravity TOCs | Static YAML/Markdown review |
| F10 — Profile-only `rules/` globs & stale rule paths | `rules/agents/{agent-definition,agent-delegation}.md`, `rules/skills/skill-definition.md`, `rules/{coding-style,testing}.md` | Add canonical `agents/**/*.md` and `skills/**/*.md` to `paths:` globs; point React/frontend skill hints to canonical `skills/` (or `${MOONSHOT_RELAY_HOME}` when installed); update `rules/testing.md` repo commands to `node --test`, `typecheck`, `build:check`, `check:boundaries` | Static rule audit |
| W1 — Outdated `AGENTS.md` model-id regex | `src/host/kernel/codex-agents-policy.ts:36` | Expand `model-id` guard from `gpt-5.6` only to include GPT-6 family (`gpt-6`, `gpt-6.1-sol`, `gpt-6-luna`, `gpt-6-astra`) while keeping `codex-gpt-5p6.ts` and `CODEX_PROMPT_REVISION` frozen for C01 corpus parity | Source update & `tests/kernel-codex-agents-md-policy.test.ts` |

### Complete Active Prompt Surface Classification (F05 & F06)

Measured from repository source after Pass 2 code/skill/template edits (`package/runtime-surface.json` and `package/kernel/*.lock.json`):

1. **Execution Path 1 — Kernel Host Envelope vs Delivered Model Message:**
   - `src/host/kernel/prompt-envelope.ts` constructs 6 segments (`tool-stable`, `common-host-stable`, `provider-stable`, `project-stable`, `run-stable`, `volatile`) for cache identity, digesting, and `measurePromptEnvelope()`.
   - `src/host/kernel/model-capsule-view.ts` (`buildModelVisiblePromptMessage()`) projects the 5 short instructions and 6 sanitized fields actually sent as `message` by `src/host/kernel/turn-dispatcher.ts`, `src/host/kernel/adapters/codex.ts`, and `src/host/kernel/adapters/claude.ts`.
   - Stable segment payloads: `src/host/kernel/prompts/common-execution.ts` (`514` B), `src/host/kernel/prompts/claude-opus-5.ts` (`352` B), `src/host/kernel/prompts/codex-gpt-5p6.ts` (`455` B).
2. **Execution Path 2 — Kernel MCP Tool Surface (`src/kernel/bridge/mcp.ts` `KERNEL_MCP_TOOLS`):**
   - 5 tools totaling `3,841` schema JSON bytes: `kernel_attach` (`187` desc / `1,181` schema B), `kernel_next` (`115` / `1,089` B), `kernel_report` (`358` / `871` B), `kernel_status` (`77` / `337` B), `kernel_detach` (`40` / `363` B).
3. **Execution Path 3 — 8 Public Runtime Skills (`package/runtime-surface.json`, totaling `48,061` B / `12,017` est. tokens):**
   - `product-orchestrator`: `7,430` B / `176` L / `1,858` tok (budget `1,858`)
   - `moonshot-architecture`: `5,892` B / `118` L / `1,473` tok (budget `1,473`)
   - `moonshot-orchestrator`: `3,944` B / `70` L / `986` tok (budget `1,087`)
   - `moonshot-phase-runner`: `9,104` B / `97` L / `2,276` tok (budget `2,280`)
   - `moonshot-plan-writer`: `5,788` B / `82` L / `1,447` tok (budget `1,463`)
   - `commit-moonshot`: `9,406` B / `136` L / `2,352` tok (budget `2,353`)
   - `session-logger`: `2,682` B / `76` L / `671` tok (budget `677`)
   - `explain-diff-html`: `3,815` B / `74` L / `954` tok (budget `1,100`)
4. **Execution Path 4 — Kernel & Standalone Skill Catalogs:**
   - `package/kernel/skills.lock.json`: 15 Kernel skills (`8,472` B total across `SKILL.md`; `moon-relay-kernel` `3,232` B / `38` L / `808` tok, plus 14 compact `214`–`574` B skills).
   - `package/kernel/standalone-skills.lock.json`: 8 standalone skills (`20,401` B total across `SKILL.md`, reduced from `24,677` B after sanitizing and slimming `skills/codebase-master-guide/SKILL.md` from `10,017` B / `112` L to `5,741` B / `75` L).
5. **Execution Path 5 — Profile Templates & Kernel Runtime Profiles:**
   - Repository root `AGENTS.md` (`2,810` B / `61` L).
   - Relay templates under `package/profile-templates/`: `codex/AGENTS.md` (`2,326` B / `51` L), `codex/.codex/AGENTS.md` (`1,859` B / `28` L), `claude/.claude/CLAUDE.md` (`2,284` B / `40` L) + `kernel-{planner,implementer,reviewer}.md` (`1,270` / `1,618` / `1,548` B), `qwen/.qwen/QWEN.md` (`2,257` B / `39` L), `antigravity/.gemini/antigravity/GEMINI.md` (`2,004` B / `38` L).
   - Kernel profiles under `package/kernel/profiles/`: `codex/AGENTS.override.md` (`1,336` B / `19` L), `codex/.codex/config.toml` (`258` B / `5` L), `codex/.codex/hooks.json` (`300` B / `16` L), `claude/CLAUDE.md` (`323` B / `3` L), `claude/settings.json` (`142` B / `10` L), `ade/QWEN.md` (`1,283` B / `12` L) + `kernel-{worker,reviewer}.md` (`1,106` / `794` B), `qwen/QWEN.md` (`265` B / `3` L), `antigravity/GEMINI.md` (`185` B / `3` L).
6. **Execution Path 6 — 74 Non-Public Canonical Skills:**
   - Static audit across all 82 skill directories (`243` `.md` files) found `0` broken local Markdown links and `0` `$ARGUMENTS` occurrences (only JS template literals in `vercel-react-best-practices` examples).
   - Across `SKILL.md`, `22` lines matched uppercase emphasis keywords (`CRITICAL`, `MUST NOT DO`) in 7 non-public skills (`build-error-resolver` 1, `codex-review-code` 10, `codex-validate-plan` 3, `doc-auto-sync` 1, `moonshot-teams-runner` 1, `security-reviewer` 2, `vercel-react-best-practices` 4); inspection confirmed these are severity labels and review criteria rather than redundant workflow bloat.

### W0–W4 Structural Guardrails Audit Summary

- **Q1 (Host/Provider Permission & Isolation Boundaries):**
  - `src/host/kernel/route-admission.ts` enforces role-to-filesystem invariants (`REVIEW_NOT_READ_ONLY`, `IMPLEMENTER_NEEDS_WRITE`, and `CAPSULE_GRANTS_AUTHORITY` blocking `canCommit`/`canDelegate`).
  - `src/host/kernel/adapters/codex.ts` derives `sandbox` (`workspace-write` / `read-only`) and `approvalPolicy` (`on-failure` / `on-request`) from `decision.permissions`; `src/host/kernel/adapters/claude.ts` passes `readOnly` and `permissions` without duplicating a generic policy engine.
  - `src/host/kernel/codex-app-server-transport.ts` defaults to `read-only` + `approvalPolicy: 'never'` (`writableWorker` is opt-in with `networkAccess: false`), disables tools when `toolPolicy === 'none'`, and rejects unhandled server approval requests fail-closed (`codex_app_server_unhandled_server_request`).
  - `src/host/kernel/proof/write-containment.ts` enforces OS write containment only via `/usr/bin/sandbox-exec` (`macos-seatbelt`) and fails closed (`PROOF_WRITE_CONTAINMENT_UNAVAILABLE`) on non-Darwin platforms; `src/host/kernel/proof/network-policy.ts` fails closed (`NETWORK_POLICY_UNENFORCEABLE`) unless a verified Linux wrapper (`firejail`/`bwrap`/`unshare`) exists; `src/host/kernel/proof/proof-executor.ts` allows only declared project manifest commands or allowlisted binaries paired with explicit `approvalReceipt` and `argvDigest`.
- **Q2 (Hook Minimalism & Kernel Verification Non-Overlap):**
  - Kernel Codex profile (`package/kernel/profiles/codex/.codex/hooks.json`) installs only `SessionStart` (`moon-relay-kernel assert-track --json`). Relay's `package/profile-templates/codex/.codex/hooks.json` installs only opt-in `UserPromptSubmit` (`moonshot-writer.mjs`, gated on explicit `Writer:`/`References:` syntax and `bypassPermissions`).
  - Kernel installs no `Stop` or per-edit full-test hooks; `src/kernel/proof/trust-authority.ts` and `src/host/kernel/proof/proof-executor.ts` retain verification and completion authority.
- **Q3 (Profile Sync Preservation & Read-Only macOS Account Observation):**
  - `src/kernel/profile-install.ts` and `src/kernel/profile-projection.ts` preserve non-Kernel entries via `MANAGED_SECTION` (`CLAUDE.md`, `AGENTS.md`, `QWEN.md`, `GEMINI.md`, and `config.toml` `developer_instructions`), `JSON_PATHS` (`mcpServers.moon-relay-kernel` in `settings.json`, `hooks.SessionStart` `assert-track` entries in `hooks.json`), and `preserveUnmanagedSkills`.
  - Read-only inspection on macOS (`claude` `2.1.112`, `codex-cli` `0.166.0`; no home directories modified): `~/.claude/settings.json` preserves user `permissions`, `hooks`, `env`, `plugins`, and `mcpServers.codex` alongside `mcpServers.moon-relay-kernel`; `~/.codex/hooks.json` preserves user `herdr-agent-state.sh` alongside Kernel's `SessionStart` hook; `~/.codex/AGENTS.md` contains an unmanaged pre-marker copy of `# Moon Relay Kernel Codex Command Profile` above the `<!-- moon-relay-kernel:start -->` section, noted for user-approved account-root cleanup without modifying `~/.codex`.
- **Surface Budget Baseline Note:**
  - `package/harness-surface-budget.json` (`files` limit `2,402`) was already exceeded on `7d619bfa` (`files: 2,403`, `nonblankLines: 369,320`, `utf8Bytes: 17,247,400`, `estimatedPromptTokens: 4,311,850` after `e268bca4` and `7d619bfa` landed past `5ee8fb37`'s zero-headroom cap). Pass 2 added `0` new tracked files (`files` stays `2,403`) and `0` unregistered tests (`438`/`438` registered), and did not weaken `package/harness-surface-budget.json`.

## Executed checks (Pass 1 baseline on `7d619bfa`)

- `build:tests`: completed after limiting the Node heap to 560 MiB (`tests: 307` generated; this is build output, not 307 passing tests). The initial default-heap build failed at about 390 MiB with JavaScript heap OOM. No persistent memory setting was changed.
- Focused test files for active contracts, prompt inventory, Codex profile, prompt replay, memory promotion, skill lint, and capability assets: **70 tests, 69 pass, 0 fail, 1 environment skip**.
- Public skill lint: **11/11 pass**, with the original token budgets unchanged. The over-budget fixture was enlarged so that it continues to test actual rejection after guidance was shortened.
- Isolated account-root installer merge test: **1/1 pass** with a smaller child-process heap. An earlier combined test hit `ENOMEM` under the 768 MiB cgroup limit; native/account installation is not claimed.
- `skills-audit.mjs audit` using `skills.lock.json`: **pass, 0 findings** after updating only the two changed canonical skill hashes.
- `git diff --check`: pass.

## TODO — verify after actual Codex usage (deferred by user, 2026-11-20)

These are **not release gates for this documentation/link cleanup**. Do not mark completed from static tests or unrelated runs. Collect evidence from the **first relevant native user session after installation**; compare against the current baseline rather than assuming savings from wording changes.

- [ ] **Native account-root adoption:** when the Windows Moonremote host executor is available, verify source `main` revision equals the intended pushed commit, inspect existing user-home profiles without overwriting custom settings, run the existing account-root installer under the user's actual account, and confirm `installId`, `verification[]`, and `profileSurfaceParity[runtime=codex].extraCanonicalCount=0`. Run installed doctor against installed paths and record the installed revision, target home, install result, and any restore/rollback outcome. Do not substitute the Linux workmachine's `/root` home for the user's account.
- [ ] **Prompt delivery:** after an actual Codex task using the installed profile, inspect the Host/Adapter's real provider-message digest or safe redacted observation and confirm that the six fields are preserved; the runtime must still call `buildModelVisiblePromptMessage()` unless a separately approved replay changes this baseline.
- [ ] **Functional acceptance:** for that real task, record its original acceptance criteria, changed path list, focused verification command and result, Kernel evidence/receipt and completion decision. Confirm that a passing test does not conceal out-of-scope file edits or unsupported completion claims.
- [ ] **Behavior and cost:** when a comparable baseline trace is available, report success/acceptance, scope violations, failed/repeated tools, human interventions, token usage and elapsed time. Mark missing data **unmeasured**, not zero; do not declare an optimization win without a sound comparable baseline.
- [ ] **Decision:** document outcome as `keep-baseline`, `candidate-for-controlled-replay`, or `not-evaluable`, with evidence paths and observed model/effort. Do not silently deploy compact-prompt or guidance-ablation candidates rejected by the historical C01 quality gate.

**Evidence to fill in after use:** date / native runtime + account home / installed commit / installId + installed doctor / run or session ID / task + acceptance / prompt digest / evidence + completion decision / baseline comparison / final verdict.

As of 2026-11-20 the Windows native host executor reports `persistence_unavailable`. Repository commit and remote push do **not** imply account-root adoption.

## Stop rule

Close this narrowly scoped audit cleanup when source-link and profile regression tests pass and the source tree is coherent. A separate optimization experiment is justified only by a concrete production prompt defect or measurable before/after behavior; do not re-open historical `keep-baseline` findings by default.
