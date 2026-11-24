# W0 활성 경로

- observed_head: `86246b72b059699d1fd628d6ec26ed36194ab569`
- clean_before_sha: `86246b72b059699d1fd628d6ec26ed36194ab569`
- source_owner: `src/` (`package/source-layout.json` sha256:`29ab270af51d3fef298c5b6d86690a4f532a0ba4c1d508dd741ea71d73690763`), `skills/`, `agents/`, `rules/`, `schemas/`, `templates/`, `tests/` (`*.ts` canonical source → `npm run build` / `npm run build:tests` materializes runtime `.js`/`.mjs`)
- execution_entrypoint:
  - CLI entrypoint: `bin/moon-relay-kernel.mjs` → `scripts/application/kernel-cli/main.js` (`src/application/kernel-cli/main.ts:runKernelCliApplication`)
  - MCP bridge entrypoint: `bin/moon-relay-kernel-mcp.mjs` → `scripts/kernel/bridge/mcp.js` (`src/kernel/bridge/mcp.ts:handleMcpToolCall`)
- host_dispatch_chain:
  - `src/application/kernel-cli/main.ts:runKernelCliApplication` / `src/kernel/bridge/mcp.ts:handleMcpToolCall`
  - `src/host/kernel/turn-dispatcher.ts:dispatchKernelTurn` → `dispatchKernelTurnAttempt`
  - `src/host/kernel/host-turn.ts:captureHostExecutionSnapshot` → `prepareHostTurn` → `settleHostTurnResult`
  - `src/host/kernel/loop-handoff.ts:saveKernelLoopHandoff` → `continueKernelCodexLoop` → `runKernelCodexLoopTurn` → `src/host/kernel/codex-app-server-transport.ts:runCodexAppServerTurn`
  - `src/host/kernel/adapters/{codex,claude,gemini,qwen}.ts`
- kernel_next_report_chain:
  - `src/kernel/control-plane.ts:createKernelControlPlane` (`next` → `prepareNext` → `buildNextForRun` → `src/kernel/run/run-loop.ts:buildNextPayload`; `report` → `reportUnderLease` → `proofRequestsForReport` → `executeProof` → `settleVerifiedReport` → `finalizeRun`)
  - `src/kernel/run/model-view.ts:projectKernelModelView` (projects compact model-facing CLI/MCP JSON payload)
- actual_model_visible_surface:
  - Source: `src/host/kernel/prompts/{common-execution,claude-opus-5,codex-gpt-5p6}.ts`, `src/host/kernel/provider-prompt-policy.ts`, `src/host/kernel/context-segments.ts:buildKernelContextSegments`, `src/host/kernel/prompt-envelope.ts:buildPromptEnvelope`, `src/host/kernel/model-capsule-view.ts:buildModelVisiblePromptView` & `resolveModelVisiblePromptMessage`, `src/host/kernel/{openai,claude}-prompt-renderer.ts`, `src/kernel/capability-guidance.ts`, `src/kernel/knowledge/context-render.ts:renderExecutionContext`, `skills/moon-relay-kernel/SKILL.md`
  - Generated (`npm run build`): `scripts/host/kernel/**`, `scripts/kernel/**`, `dist/runtime-build.json`
  - Installed runtime consumers: account-root `~/.moon-relay-kernel` / `~/.moonshot-relay` and profile projections (`.claude/`, `.codex/`, `.qwen/`) materialized by `src/application/install/` (not edited directly; isolated in temp directories during tests)
- proof_and_completion_consumer:
  - `src/kernel/control-plane.ts:reportUnderLease` → `proofRequestsForReport` → `executeProof`
  - `src/kernel/proof/evidence-reuse.ts:findReusableVerificationEvidence` & `canReuseVerificationForRequirement`
  - `src/host/kernel/proof/proof-executor.ts:executeTrustedProof`
  - `src/kernel/proof/trust-authority.ts:buildTrustAuthorityView` & `evaluateTrustCompletion`
  - `src/kernel/run/completion.ts:evaluateCompletion`
  - `agents/verification/{verify-changes,verify-runtime,run-verify-changes}.sh`
- supported_surfaces:
  - `codex` (`codex-gpt-5p6`, `owner-direct` default + `codex-app-server` fresh-thread continuation loop, raw usage telemetry `input_tokens`, `cached_input_tokens`, `output_tokens`)
  - `claude` (`claude-opus-5`, `owner-direct` default, raw usage telemetry `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`)
  - `gemini` / `qwen` (compatibility adapters; raw cache hit/write fields unobserved unless present in provider output)
- repeated_admin_or_proof_calls:
  - `src/kernel/control-plane.ts:prepareNext` (lines 3887–4075): during a single `next()` call, `currentProjectCommands()` is invoked 3 times (`prepareNext`, `refreshProofPolicyBindings`, `resolveRunCapabilityDecision`), `store.getVerifications(runId)` is queried 5 times (`prepareNext`, `evaluateRunCompletion`, `buildNextForRun`, and post-update recomputation), and `buildTrustAuthorityForRun`, `buildKnowledgeAuthorityForRun`, `resumeViewForRun`, and `verificationScopeIdentities` are computed twice per `next()` call (once inside `buildNextForRun` and immediately recomputed at lines 4050–4074).
  - `src/kernel/control-plane.ts:verificationScopeIdentities` & `executeProof`: within a single `next()` or `report()` invocation, workspace identity observation (`observeWorkspaceIdentity({ projectRoot })`) and project command discovery (`currentProjectCommands()`) are repeated across obligation refresh, capability resolution, scope identity calculation, and post-verification settlement even when the workspace has not mutated between internal steps.
  - `src/host/kernel/turn-dispatcher.ts:buildTurnPromptEnvelope`: `projectStable` segment was previously left empty (`[]`) even when stable knowledge records (`context.records`) exist in the prepared execution context, while `model-capsule-view.ts` and `cache-replay.ts` already support `project-stable` prefix segmenting.
- existing_Keep_decisions_checked:
  - `docs/public/reference/prompt-diet-keep-baseline-2026-10-19.md` (`C01 keep-baseline` default `buildModelVisiblePromptMessage()` retained; `buildCompactModelVisiblePromptMessage` remains opt-in via `MOON_RELAY_KERNEL_COMPACT_PROMPT_MESSAGE=on`)
  - `docs/public/reference/prompt-surface-audit-2026-11-20.md` & `artifacts/kernel-prompt-audit/{prompt-inventory.json,instruction-classification.json,removed-instructions.md}` (`KR-01..KR-08` already removed; `tests/kernel-prompt-inventory.test.ts` and `tests/kernel-prompt-size-budget.test.ts` enforce exact byte contracts on the 9 audited prompt surface files)
  - `tests/kernel-turn-dispatcher-envelope.test.ts` (already enforces single `controlPlane.next(runId)` reuse via `captureHostExecutionSnapshot` when snapshot is fresh, and deduplicated review receipts via `findReusableReviewReceipt`)
- overlapping_Host_owned_Worker_files:
  - `src/host/kernel/loop-handoff.ts`, `src/host/kernel/codex-app-server-transport.ts`, `src/kernel/bridge/mcp.ts` (settled in parent commit `c5f09ccea53f148ba570dca4bdfe527058cde170`; write-ownership and single-writer SQLite lease invariants preserved)
- verified / inferred / unverified:
  - **verified**: clean baseline `86246b72b059699d1fd628d6ec26ed36194ab569`; source/runtime boundaries (`npm run typecheck`, `npm run build:check`, `npm run check:boundaries`, `npm run build:tests:check`, `npm run test:kernel-unification`, `npm run lint:kernel` all PASS); active Host→Kernel→Prompt→Proof call chain; redundant internal query/authority recomputation in `control-plane.ts:prepareNext` and `reportUnderLease`; Track A 4 Golden-PR commits and their deterministic held-out test oracles.
  - **inferred**: reducing redundant `prepareNext` authority/verification/workspace-identity calls (`B2a`/`B2b`) directly lowers per-turn control-plane SQLite/git-status overhead without altering Work/Trust/Knowledge/Completion semantics.
  - **unverified**: live remote LLM provider 12-run Before/After agent execution (`codex` / `claude` API billing & live cache hit telemetry across 6 Golden tasks) and external repository Track B live agent runs (`NOT_RUN` in local deterministic environment).

## 구현 단위별 최소 변경 후보 및 실패 모드 (W0-3)

| 단위 | 활성 경로 근거 | 최소 변경 후보 | 실패 모드 및 보호 조건 |
| --- | --- | --- | --- |
| **B1a** | `src/host/kernel/prompts/*.ts`, `src/host/kernel/model-capsule-view.ts`, `skills/moon-relay-kernel/SKILL.md` | 9개 프롬프트 표면 파일은 `prompt-inventory.json` 및 `prompt-size-after.json`의 바이트 고정 계약(`tests/kernel-prompt-inventory.test.ts`, `tests/kernel-prompt-size-budget.test.ts`)과 C01 `keep-baseline` 결정으로 잠겨 있음. `src/kernel/run/model-view.ts`의 CLI/MCP compact projection에서 모델에 불필요한 빈 메타 필드가 있는지 점검하되, 계약 파괴 시 `NO_CHANGE` 유지 | 바이트 잠금·C01 회귀 테스트 실패 시 즉시 `NO_CHANGE` 유지 |
| **B2a** | `src/kernel/control-plane.ts:prepareNext`, `buildNextForRun`, `resolveRunCapabilityDecision` | `prepareNext` 단일 호출 내 `currentProjectCommands()` 3회 재스캔, `store.getVerifications(runId)` 5회 중복 조회, `buildTrustAuthorityForRun` / `buildKnowledgeAuthorityForRun` / `resumeViewForRun` 2회 중복 계산을 사전 조회·전달 방식으로 1회로 통합 | Owner·lease·freshness·approval·review obligation 결과가 동일해야 함 (`tests/kernel-turn-dispatcher-envelope.test.ts`, `tests/kernel-compression-audit.test.ts`) |
| **C** | `src/`, `package/source-layout.json`, `src/host-tooling/kernel-public/runtime-boundary-audit.ts` | `check:boundaries` (9 modules, 324 files) 및 `test:kernel-unification` (G1~G15)로 이미 단일 canonical source 경계가 강제됨. 동적 import/export 및 `package/source-layout.json` 소비자를 깨지 않는 범위에서만 정리하고, 모든 경로에 활성 소비자가 있으면 `NO_CHANGE` | dynamic import/export, `npm run build:check`, `npm run check:boundaries` 깨짐 방지 |
| **B1b** | C 의존 프롬프트/문서 | C에서 제거된 코드 경로가 없으면 `NO_CHANGE` | C와 연동 의존성 유지 |
| **B2b** | `src/kernel/control-plane.ts:verificationScopeIdentities`, `reportUnderLease`, `executeProof` | 단일 `next()` / `report()` 사이클 내 동일 프로젝트 루트에 대한 `observeWorkspaceIdentity({ projectRoot })` 및 ` verificationScopeIdentities` 반복 실행을 호출 스코프 내 메모이제이션하고, 실제 proof 실행 후에만 무효화/재관측하여 fresh verification 증거는 100% 보존 | 미실행 검증을 fresh PASS로 승격 금지; 실제 proof 실행 후 workspace 변이 시 재관측 보장 |
| **D** | `tools/build/check-boundaries.mjs`, `src/host-tooling/kernel-eval/static-analysis.ts` | 기존 컴파일러/경계/정적 검사기가 모두 PASS하며 미탐지 결함이 없으면 `NO_CHANGE` (신규 상시 감사기 도입 금지) | 신규 분석기/상시 감사 추가 금지 |
| **S6** | `src/host/kernel/turn-dispatcher.ts:buildTurnPromptEnvelope`, `src/host/kernel/context-segments.ts`, `src/host/kernel/usage-receipt.ts` | `buildTurnPromptEnvelope` 및 `usage-receipt` / `cache-replay` 경로에서 stable prefix(`tool-stable`, `common-host-stable`, `provider-stable`, `project-stable`, `run-stable`)와 `volatile` tail 분리 및 raw provider usage telemetry(`input_tokens`, `cached_input_tokens` / `cache_read_input_tokens`, `cache_creation_input_tokens`) 보존 검증 | 기존 `tests/kernel-turn-dispatcher-envelope.test.ts`, `tests/kernel-cache-replay.test.ts`, `tests/kernel-cache-usage-receipt.test.ts` 통과 필수 |
