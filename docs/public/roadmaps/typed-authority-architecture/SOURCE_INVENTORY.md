# 계획 기준선 원본 197개와 전환 배정

현재 전환 원본은 [CURRENT_SOURCE_CLOSURE.md](CURRENT_SOURCE_CLOSURE.md)에서 확인한다. 아래 경로와 배정은 기존 계획의 기준선으로 보존한다.

기준 e328127. 현재 source-layout graph에서 수집한 파일 목록이다. 아래 owner는 **계획상의 배정**이며 기존 코드가 이미 해당 책임만 갖는다는 뜻이 아니다. 복합 책임 표시는 함수별 분리가 필요하다. TASK-001에서 exported symbol과 write/effect를 확인하고 실행 scope를 확정한다.

Kernel 155 / Host 36 / Shared 4 / CLI 2. mjs 195 / mts 2. 정적 import edge 450. 스크립트·manifest 문자열·spawn·asset closure는 이 197개 밖의 별도 inventory이며 IMPACT_MAP과 PLAN에 필수 작업으로 지정했다.

| Current source | Target owner | Task | 분리·보존 조건 |
| --- | --- | --- | --- |
| `src/cli/moon-relay-kernel.mjs` | CLI / Composition | TASK-008 | argv와 실제 main 호출 분리 |
| `src/cli/moon-relay-standalone.mjs` | CLI / Composition | TASK-008 | argv와 실제 main 호출 분리 |
| `src/host/kernel/adapters/ade.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/adapters/claude.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/adapters/codex.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/adapters/fable.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/adapters/gemini-cli.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/adapters/gemini.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/ade-context-policy.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/admission-revalidator.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/cache-replay.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/claude-effort-policy.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/codex-actor-router.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/codex-agents-policy.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/codex-model-policy.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/codex-session-observer.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/common-model-policy.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/host-boundary.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/host-routing.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/host-turn.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/independent-subagent-review.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/lifecycle-bridge.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/model-capsule-view.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/model-registry.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/parallel-dispatcher.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/prompt-envelope.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/prompts/claude-opus-5.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/prompts/codex-gpt-5p6.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/prompts/common-execution.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/provider-prompt-policy.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/review-readiness.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/review-transport-resolver.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/route-admission.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/session-affinity.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/tool-manifest.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/turn-dispatcher.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/usage-receipt.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/host/kernel/workspace/physical-worktree.mjs` | Host | TASK-006 | native/provider 의존을 contracts로 축소 |
| `src/kernel/artifact-paths.mjs` | Persistence/Host primitive | TASK-007 | 기술 I/O와 semantic policy 분리 |
| `src/kernel/bridge/coordinator-surface.mjs` | Composition + public contract | TASK-007 | Host 연결은 composition |
| `src/kernel/bridge/mcp.mjs` | Composition + public contract | TASK-007 | Host 연결은 composition |
| `src/kernel/canonical-digest.mjs` | Shared | TASK-002 | canonical serialization 의미 고정 |
| `src/kernel/capability-guidance.mjs` | Work/Trust policy + contracts | TASK-003 | task plan/scope와 proof policy 함수별 분리 |
| `src/kernel/capability-resolver.mjs` | Work/Trust policy + contracts | TASK-003 | task plan/scope와 proof policy 함수별 분리 |
| `src/kernel/change-contract.mjs` | Work/Trust policy + contracts | TASK-003 | task plan/scope와 proof policy 함수별 분리 |
| `src/kernel/codebase/build-index.mjs` | Host Codebase + Knowledge read port | TASK-005 | index는 파생물 |
| `src/kernel/codebase/candidate-extract.mjs` | Host Codebase + Knowledge read port | TASK-005 | index는 파생물 |
| `src/kernel/codebase/incremental-refresh.mjs` | Host Codebase + Knowledge read port | TASK-005 | index는 파생물 |
| `src/kernel/codebase/manifest.mjs` | Host Codebase + Knowledge read port | TASK-005 | index는 파생물 |
| `src/kernel/codebase/query.mjs` | Host Codebase + Knowledge read port | TASK-005 | index는 파생물 |
| `src/kernel/context-build.mjs` | Knowledge context + Trust receipt | TASK-005 | context 내용과 evidence provenance 구분 |
| `src/kernel/context-receipt.mjs` | Knowledge context + Trust receipt | TASK-005 | context 내용과 evidence provenance 구분 |
| `src/kernel/context-segments.mjs` | Host Prompt + context contract | TASK-006 | prompt/cache 소유권 |
| `src/kernel/control-plane.mjs` | Kernel Coordinator | TASK-007 | 직접 I/O와 domain policy 추출 |
| `src/kernel/durable-write.mjs` | Persistence/Host primitive | TASK-007 | 기술 I/O와 semantic policy 분리 |
| `src/kernel/eval/model-routing-eval.mjs` | Host tooling / validation | TASK-009 | 실행과 평가 contract 구분 |
| `src/kernel/eval/sentinel-eval.mjs` | Host tooling / validation | TASK-009 | 실행과 평가 contract 구분 |
| `src/kernel/evidence-pack.mjs` | Trust | TASK-004 | risk와 proof 요구 계약 |
| `src/kernel/git/closeout.mjs` | Host Git + Work/Trust admission | TASK-006 | 실행과 허용 판단 분리 |
| `src/kernel/git/commit-message.mjs` | Host Git + Work/Trust admission | TASK-006 | 실행과 허용 판단 분리 |
| `src/kernel/git/remote-parity.mjs` | Host Git + Work/Trust admission | TASK-006 | 실행과 허용 판단 분리 |
| `src/kernel/git/staging-policy.mjs` | Host Git + Work/Trust admission | TASK-006 | 실행과 허용 판단 분리 |
| `src/kernel/installer.mjs` | Host Install / Runtime | TASK-008 | runtime path·profile·지원 자산 보존 |
| `src/kernel/knowledge-ingestion/candidate-extract.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/knowledge-ingestion/conflict.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/knowledge-ingestion/deduplicate.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/knowledge-ingestion/import.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/knowledge-ingestion/normalize.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/knowledge-ingestion/redact.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/knowledge-ingestion/transaction.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/knowledge-ingestion/verify.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/knowledge/architecture-resolve.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/knowledge/candidate-extract.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/knowledge/candidate-review.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/knowledge/canonical-record-mapper.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/knowledge/capture.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/knowledge/change-diff.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/knowledge/commit.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/knowledge/context-load.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/knowledge/context-render.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/knowledge/evidence-binder.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/knowledge/freshness.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/knowledge/knowledge-authority.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/knowledge/ontology-evaluate.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/knowledge/ontology-gate.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/knowledge/path-scope.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/knowledge/projection.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/knowledge/receipt.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/knowledge/records.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/knowledge/revision.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/knowledge/store.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/knowledge/supersession.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/knowledge/tacit-resolve.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/knowledge/topology-projection.mjs` | Knowledge | TASK-005 | 외부 file/Git 수집은 Host port로 추출 |
| `src/kernel/legacy-hydration-cleanup.mjs` | Host Install / Runtime | TASK-008 | runtime path·profile·지원 자산 보존 |
| `src/kernel/optimization-cycle.mjs` | Host optimization + optional contract | TASK-006 | 새 Authority를 만들지 않음 |
| `src/kernel/package-build.mjs` | Host Install / Runtime | TASK-008 | runtime path·profile·지원 자산 보존 |
| `src/kernel/persistence/durable-state.mjs` | Persistence + Authority write contracts | TASK-007 | 각 slice에서 선행 분리; 한 DB/transaction 유지 |
| `src/kernel/persistence/run-journal.mjs` | Persistence + Authority write contracts | TASK-007 | 각 slice에서 선행 분리; 한 DB/transaction 유지 |
| `src/kernel/persistent-sanitizer.mjs` | Persistence/Host primitive | TASK-007 | 기술 I/O와 semantic policy 분리 |
| `src/kernel/policy.mjs` | Work/Trust policy + contracts | TASK-003 | task plan/scope와 proof policy 함수별 분리 |
| `src/kernel/profile-build.mjs` | Host Install / Runtime | TASK-008 | runtime path·profile·지원 자산 보존 |
| `src/kernel/profile-doctor.mjs` | Host Install / Runtime | TASK-008 | runtime path·profile·지원 자산 보존 |
| `src/kernel/profile-install.mjs` | Host Install / Runtime | TASK-008 | runtime path·profile·지원 자산 보존 |
| `src/kernel/profile-projection.mjs` | Host Install / Runtime | TASK-008 | runtime path·profile·지원 자산 보존 |
| `src/kernel/project-hydrate.mjs` | Host Install / Runtime | TASK-008 | runtime path·profile·지원 자산 보존 |
| `src/kernel/project-identity-preflight.mjs` | Work identity + Host observation | TASK-003 | canonical identity와 Git 관찰 분리 |
| `src/kernel/project-identity.mjs` | Work identity + Host observation | TASK-003 | canonical identity와 Git 관찰 분리 |
| `src/kernel/proof-route.mjs` | Trust | TASK-004 | risk와 proof 요구 계약 |
| `src/kernel/proof/baseline-proof.mjs` | Trust | TASK-004 | evidence·review 의미 보존 |
| `src/kernel/proof/command-catalog.mjs` | Host Execution + Trust policy | TASK-004 | 실제 실행만 이동; proof 수락은 Trust |
| `src/kernel/proof/domain-policy.mjs` | Trust | TASK-004 | evidence·review 의미 보존 |
| `src/kernel/proof/evidence-reuse.mjs` | Trust | TASK-004 | evidence·review 의미 보존 |
| `src/kernel/proof/failure-classify.mjs` | Trust | TASK-004 | evidence·review 의미 보존 |
| `src/kernel/proof/network-policy.mjs` | Host Execution + Trust policy | TASK-004 | 실제 실행만 이동; proof 수락은 Trust |
| `src/kernel/proof/process-tree.mjs` | Host Execution + Trust policy | TASK-004 | 실제 실행만 이동; proof 수락은 Trust |
| `src/kernel/proof/proof-executor.mjs` | Host Execution + Trust policy | TASK-004 | 실제 실행만 이동; proof 수락은 Trust |
| `src/kernel/proof/protected-obligations.mjs` | Trust | TASK-004 | evidence·review 의미 보존 |
| `src/kernel/proof/review-pipeline.mjs` | Trust | TASK-004 | evidence·review 의미 보존 |
| `src/kernel/proof/review-receipt.mjs` | Trust | TASK-004 | evidence·review 의미 보존 |
| `src/kernel/proof/static-analysis.mjs` | Host Execution + Trust policy | TASK-004 | 실제 실행만 이동; proof 수락은 Trust |
| `src/kernel/proof/trust-authority.mjs` | Trust | TASK-004 | evidence·review 의미 보존 |
| `src/kernel/risk-surfaces.mjs` | Trust | TASK-004 | risk와 proof 요구 계약 |
| `src/kernel/route.mjs` | Work/Trust policy + contracts | TASK-003 | task plan/scope와 proof policy 함수별 분리 |
| `src/kernel/routing/route-admission.mjs` | Trust admission + Host routing contract | TASK-004 | provider 선택과 수락 조건 분리 |
| `src/kernel/run/attempt-provenance.mjs` | Work | TASK-003 | Host physical effect는 injected port |
| `src/kernel/run/binding-preflight.mjs` | Work | TASK-003 | Host physical effect는 injected port |
| `src/kernel/run/capsule-selection.mjs` | Work | TASK-003 | Host physical effect는 injected port |
| `src/kernel/run/completion-outcomes.mjs` | Trust | TASK-004 | completion 조건과 evidence 필요량 |
| `src/kernel/run/completion-view.mjs` | Trust | TASK-004 | completion 조건과 evidence 필요량 |
| `src/kernel/run/contract-preflight.mjs` | Work | TASK-003 | Host physical effect는 injected port |
| `src/kernel/run/execution-capsule.mjs` | Work | TASK-003 | Host physical effect는 injected port |
| `src/kernel/run/execution-class.mts` | Contracts + owner policy | TASK-002 | 최소 Work slice 계약부터 TS |
| `src/kernel/run/finalization.mjs` | Coordinator + Work/Trust/Knowledge APIs | TASK-007 | 원자성 유지; 단일 acceptance |
| `src/kernel/run/host-execution-contract.mjs` | Contracts + owner policy | TASK-002 | 최소 Work slice 계약부터 TS |
| `src/kernel/run/host-session.mjs` | Host + Work binding contract | TASK-006 | provider/session 기술 정보와 논리 owner 분리 |
| `src/kernel/run/invocation-resolver.mjs` | Work | TASK-003 | Host physical effect는 injected port |
| `src/kernel/run/model-route-contract.mjs` | Host + Work binding contract | TASK-006 | provider/session 기술 정보와 논리 owner 분리 |
| `src/kernel/run/model-routing.mjs` | Host + Work binding contract | TASK-006 | provider/session 기술 정보와 논리 owner 분리 |
| `src/kernel/run/model-view.mjs` | Host + Work binding contract | TASK-006 | provider/session 기술 정보와 논리 owner 분리 |
| `src/kernel/run/mutation-guard.mjs` | Work | TASK-003 | Host physical effect는 injected port |
| `src/kernel/run/obligation-compiler.mjs` | Trust | TASK-004 | completion 조건과 evidence 필요량 |
| `src/kernel/run/optional-capabilities.mts` | Contracts + owner policy | TASK-002 | 최소 Work slice 계약부터 TS |
| `src/kernel/run/provider-mutation-adapter.mjs` | Host + Work binding contract | TASK-006 | provider/session 기술 정보와 논리 owner 분리 |
| `src/kernel/run/report-identity.mjs` | Work | TASK-003 | Host physical effect는 injected port |
| `src/kernel/run/required-host-capabilities.mjs` | Contracts + owner policy | TASK-002 | 최소 Work slice 계약부터 TS |
| `src/kernel/run/run-identity.mjs` | Work | TASK-003 | Host physical effect는 injected port |
| `src/kernel/run/run-locator.mjs` | Work | TASK-003 | Host physical effect는 injected port |
| `src/kernel/run/run-loop.mjs` | Work | TASK-003 | Host physical effect는 injected port |
| `src/kernel/run/run-step-ledger.mjs` | Work | TASK-003 | Host physical effect는 injected port |
| `src/kernel/run/session-binding.mjs` | Work | TASK-003 | Host physical effect는 injected port |
| `src/kernel/run/session-holder.mjs` | Host + Work binding contract | TASK-006 | provider/session 기술 정보와 논리 owner 분리 |
| `src/kernel/run/step-planner.mjs` | Work | TASK-003 | Host physical effect는 injected port |
| `src/kernel/run/successor-key.mjs` | Work | TASK-003 | Host physical effect는 injected port |
| `src/kernel/run/work-authority.mjs` | Work | TASK-003 | Host physical effect는 injected port |
| `src/kernel/run/work-cursor.mjs` | Work | TASK-003 | Host physical effect는 injected port |
| `src/kernel/run/work-unit-scope.mjs` | Work | TASK-003 | Host physical effect는 injected port |
| `src/kernel/run/workspace-identity.mjs` | Host observation + contracts | TASK-003 | identity 관찰과 Work validation 분리 |
| `src/kernel/run/workspace-registration.mjs` | Work | TASK-003 | Host physical effect는 injected port |
| `src/kernel/run/worktree-binding.mjs` | Work | TASK-003 | Host physical effect는 injected port |
| `src/kernel/runtime-boundary-audit.mjs` | Host Install / Runtime | TASK-008 | runtime path·profile·지원 자산 보존 |
| `src/kernel/runtime-home.mjs` | Host Install / Runtime | TASK-008 | runtime path·profile·지원 자산 보존 |
| `src/kernel/runtime-resolver.mjs` | Host Install / Runtime | TASK-008 | runtime path·profile·지원 자산 보존 |
| `src/kernel/sqlite-adapter.mjs` | Persistence + Authority write contracts | TASK-007 | 각 slice에서 선행 분리; 한 DB/transaction 유지 |
| `src/kernel/standalone/architecture-artifacts.mjs` | Application / CLI + owner API | TASK-008 | 도구 orchestration과 owner write 분리 |
| `src/kernel/standalone/artifact-utils.mjs` | Application / CLI + owner API | TASK-008 | 도구 orchestration과 owner write 분리 |
| `src/kernel/standalone/catalog.mjs` | Application / CLI + owner API | TASK-008 | 도구 orchestration과 owner write 분리 |
| `src/kernel/standalone/codebase-master-guide.mjs` | Application / CLI + owner API | TASK-008 | 도구 orchestration과 owner write 분리 |
| `src/kernel/standalone/codebase-understanding.mjs` | Application / CLI + owner API | TASK-008 | 도구 orchestration과 owner write 분리 |
| `src/kernel/standalone/common.mjs` | Application / CLI + owner API | TASK-008 | 도구 orchestration과 owner write 분리 |
| `src/kernel/standalone/explain-diff-html.mjs` | Application / CLI + owner API | TASK-008 | 도구 orchestration과 owner write 분리 |
| `src/kernel/standalone/kernel-commit.mjs` | Application / CLI + owner API | TASK-008 | 도구 orchestration과 owner write 분리 |
| `src/kernel/standalone/prework.mjs` | Application / CLI + owner API | TASK-008 | 도구 orchestration과 owner write 분리 |
| `src/kernel/standalone/product-definition.mjs` | Application / CLI + owner API | TASK-008 | 도구 orchestration과 owner write 분리 |
| `src/kernel/standalone/project-memory.mjs` | Application / CLI + owner API | TASK-008 | 도구 orchestration과 owner write 분리 |
| `src/kernel/standalone/session-providers/claude.mjs` | Host Knowledge Input | TASK-005 | 수집·redaction 뒤 Knowledge 전달 |
| `src/kernel/standalone/session-providers/codex.mjs` | Host Knowledge Input | TASK-005 | 수집·redaction 뒤 Knowledge 전달 |
| `src/kernel/standalone/session-providers/generic.mjs` | Host Knowledge Input | TASK-005 | 수집·redaction 뒤 Knowledge 전달 |
| `src/kernel/standalone/session-providers/index.mjs` | Host Knowledge Input | TASK-005 | 수집·redaction 뒤 Knowledge 전달 |
| `src/kernel/standalone/session-providers/normalize.mjs` | Host Knowledge Input | TASK-005 | 수집·redaction 뒤 Knowledge 전달 |
| `src/kernel/standalone/session-providers/resolver.mjs` | Host Knowledge Input | TASK-005 | 수집·redaction 뒤 Knowledge 전달 |
| `src/kernel/standalone/ui-audit.mjs` | Application / CLI + owner API | TASK-008 | 도구 orchestration과 owner write 분리 |
| `src/kernel/state-projector.mjs` | Work view + Host projection writer | TASK-003 | projection은 비권위 |
| `src/kernel/state-store.mjs` | Persistence + Authority write contracts | TASK-007 | 각 slice에서 선행 분리; 한 DB/transaction 유지 |
| `src/kernel/task/evidence-plan.mjs` | Work planning + Trust/Host evidence port | TASK-003 | scope 계약과 실제 관찰 분리 |
| `src/kernel/task/evidence-scan.mjs` | Work planning + Trust/Host evidence port | TASK-003 | scope 계약과 실제 관찰 분리 |
| `src/kernel/task/greenfield-bootstrap.mjs` | Work | TASK-003 | typed task contract와 실행 연결 |
| `src/kernel/task/migration-workflow.mjs` | Work | TASK-003 | typed task contract와 실행 연결 |
| `src/kernel/task/project-mode.mjs` | Work | TASK-003 | typed task contract와 실행 연결 |
| `src/kernel/task/task-contract.mjs` | Work | TASK-003 | typed task contract와 실행 연결 |
| `src/kernel/transition.mjs` | Work/Trust policy + contracts | TASK-003 | task plan/scope와 proof policy 함수별 분리 |
| `src/kernel/unification-audit.mjs` | Development architecture check | TASK-009 | 실제 source ownership 검사 |
| `src/kernel/upstream-registry.mjs` | Host capability registry | TASK-006 | 외부 실행 지원 범위 |
| `src/shared/candidate-identity.mjs` | Shared + Host observation | TASK-003 | digest와 Git 관찰 함수 분리 |
| `src/shared/git-safe.mjs` | Host Git | TASK-006 | 실제 Git 실행 |
| `src/shared/runtime-build.mjs` | Host Install / Build | TASK-008 | catalog/build 역방향 의존 제거 |
| `src/shared/skills-lock.mjs` | Host Install / Build | TASK-008 | catalog/build 역방향 의존 제거 |

Task는 주 종료 담당이다. 공통 계약·persistence/Host seam은 앞선 실제 소비 slice에서 먼저 만들 수 있다. 파일명 변경만으로 해당 task가 완료되지 않는다.
