# 현재 Typed Authority 원본 폐쇄집합

확인 기준: 2026-10-11 작업 원본. 기존 SOURCE_INVENTORY.md의 197개 경로는 계획 기준선이다. 이 문서는 현재 경로를 추가하며 과거 근거를 덮어쓰지 않는다. Schema에서 생성한 타입과 runtime 정의는 src/contracts/generated 및 schema-definitions.generated.ts에 있다. 이 파생 원본도 strict 검사와 drift 검사를 통과해야 한다.

## 활성 Kernel 원본

package/source-layout.json의 9개 모듈은 289개 TypeScript 원본과 768개 정적 모듈 참조를 갖는다. src 안의 유지보수 JavaScript 원본은 없다. externalImports에는 schema-codec의 Ajv SDK import 세 개만 선언한다. 표준 Node API, SQLite SDK, 등록한 schema validator SDK 외의 runtime package import는 빌드가 거부한다.

공개 bin/moon-relay-kernel.mjs, bin/moon-relay-standalone.mjs, bin/moonshot-relay.mjs의 Kernel 설치 분기는 생성된 TypeScript 코드다. 공개 설치 CLI의 install/setup은 공식 Kernel installer, runtime bootstrap, profile installer를 호출한다. Host profile-target은 물리 target identity를 검사한다.

| 원본 그룹 | 수 | 출력 소유자 |
| --- | ---: | --- |
| src/contracts | 57 | scripts/contracts |
| src/kernel | 129 | scripts/kernel |
| src/host/kernel | 64 | scripts/host/kernel |
| src/host-tooling/kernel-eval | 3 | scripts/kernel/eval |
| src/host-tooling/kernel-public | 3 | scripts/kernel |
| src/application/kernel-standalone | 8 | scripts/kernel/standalone |
| src/application/kernel-cli | 3 | scripts/application/kernel-cli |
| src/shared | 15 | scripts/lib |
| src/cli | 7 | bin |

## 테스트와 개발 도구

현재 테스트 원본은 267개다. 이 중 Kernel 명명 테스트는 260개다. source-runtime, 네 가지 owner 변경 시험, 공개 설치 JSON, package layout/materialization/installed release 비교를 별도 유지한다. 테스트 helper는 tests/helpers/*.ts이며 public MJS는 생성 진입점이다. 타입 부정 fixture는 tests/types에서 별도로 검사한다.

빌드 도구 원본 7개는 tools/build/*.ts다. compiler가 bootstrap을 먼저 emit한다. 실행 산출물은 source와 같은 디렉터리의 생성 MJS이며 원본을 직접 실행하지 않는다.

Capability의 과거 788개 경로 기록은 보존한다. catalog/kernel-capability-surface-migrations.json은 이전 경로 180개를 현재 원본과 생성 파일에 명시적으로 연결한다. 현재 추가 경로 567개도 기존 capability에 분류한다. 이 중 564개는 원본과 runtime 경로이며, 3개는 신규 schema다. 감사 도구는 연결된 원본과 생성 파일이 compiler manifest에 등록되었는지 확인하고, 줄바꿈을 정규화한 SHA-256을 대조한다. 이전 경로 이름으로 runtime 파일을 다시 만들지 않는다.

코드량 감사는 compiler manifest와 명시적 계약 catalog로 생성 파일을 구분한다. 생성 runtime, 테스트 진입점, 계약 projection은 별도 inventory에 남기고 canonical input 예산에서 제외한다. 테스트 inventory는 TypeScript 원본을 포함하며, 실제 생성 진입점으로 등록된 npm 시험과 연결한다. type-contract fixture는 strict compiler가 검사한다. 기존 immutable 예산 baseline은 유지하고, 이번 원본 전환과 문서 추가의 실제 측정값에 맞춰 허용 delta와 근거를 명시했다. 전체 checkout을 커밋한 뒤에도 같은 집계 기준을 사용한다.

테스트 산출물은 실행 위치에서 canonical fixture의 상대 URL을 계산한다. 빌드한 PC의 절대 경로를 기록하지 않는다. Linux 생성 뒤 Windows drift 검사와 디렉터리 이동 실행 시험으로 이 경계를 검증한다. runtime freshness에는 package.json과 package-lock.json도 포함한다.

기존 호환 패키지는 source-layout에 등록한 schema SDK의 실행 의존성만 공통 dependency resolver로 수집한다. SDK를 사용하는 공개 CLI의 import graph를 닫고, 개발 의존성과 기존 native SQLite 제외 정책을 보존한다. 현재 Kernel installer는 별도 runtime payload에 전체 실행 의존성을 배치한다.

## 기존 Relay 호환 자산

scripts/install-account-root-harness.mjs는 src/host-tooling/kernel-public/runtime-boundary-audit.ts의 MIGRATION_ONLY_RUNTIME_FILES에 지정된 과거 Relay installer다. 현재 Kernel 설치·부트스트랩 경로는 이 파일을 호출하지 않는다. 과거 Relay package 테스트는 임시 home에서 그 의미를 검사한다.

package/build-package.mjs는 과거 Relay의 profile 조립 경로다. 현재 Kernel 설치 payload는 src/kernel/package-build.ts가 조립한다. 두 경로의 회귀를 유지한다. 과거 Relay tests, tools/evals, tools/retro와 scripts/switcher는 기존 서비스 호환 자산이며 현재 Kernel owner 구현에 포함하지 않는다. 공개 account CLI의 명시적 retro/delivery 분기는 이 호환 자산을 계속 참조한다. 이 분기를 Kernel 원본 전환 완료의 근거로 사용하지 않는다.

정적 원본 graph에는 이러한 호환 모듈로 향하는 import가 없다. kernel-compatibility 테스트에서 필요한 동적 export는 tests/helpers/legacy-module-boundary.ts가 unknown 입력과 실제 반환 구조 검사로 봉합한다. wildcard ambient 선언으로 legacy 모듈을 typed 구현으로 취급하지 않는다.

## 원본 목록

- src/application/kernel-cli/account-install.ts
- src/application/kernel-cli/main.ts
- src/application/kernel-cli/standalone.ts
- src/application/kernel-standalone/architecture-artifacts.ts
- src/application/kernel-standalone/codebase-master-guide.ts
- src/application/kernel-standalone/codebase-understanding.ts
- src/application/kernel-standalone/explain-diff-html.ts
- src/application/kernel-standalone/kernel-commit.ts
- src/application/kernel-standalone/product-definition.ts
- src/application/kernel-standalone/project-memory.ts
- src/application/kernel-standalone/ui-audit.ts
- src/cli/codebase-master-guide.ts
- src/cli/codebase-understanding.ts
- src/cli/kernel-commit.ts
- src/cli/moon-relay-kernel.ts
- src/cli/moon-relay-standalone.ts
- src/cli/moonshot-relay.ts
- src/cli/project-memory.ts
- src/contracts/command-catalog.ts
- src/contracts/completion-outcomes.ts
- src/contracts/context-receipt.ts
- src/contracts/execution-class.ts
- src/contracts/generated/kernel.applicable-knowledge-slice.ts
- src/contracts/generated/kernel.attempt-provenance.ts
- src/contracts/generated/kernel.codebase-index-manifest.ts
- src/contracts/generated/kernel.context-receipt.ts
- src/contracts/generated/kernel.durable-state.ts
- src/contracts/generated/kernel.eval-case.ts
- src/contracts/generated/kernel.execution-capsule.ts
- src/contracts/generated/kernel.git-closeout-receipt.ts
- src/contracts/generated/kernel.git-closeout-request.ts
- src/contracts/generated/kernel.knowledge-candidate.ts
- src/contracts/generated/kernel.knowledge-commit-receipt.ts
- src/contracts/generated/kernel.knowledge-contract.ts
- src/contracts/generated/kernel.knowledge-import-receipt.ts
- src/contracts/generated/kernel.knowledge-import.ts
- src/contracts/generated/kernel.knowledge-record.ts
- src/contracts/generated/kernel.knowledge-review-result.ts
- src/contracts/generated/kernel.measurement.ts
- src/contracts/generated/kernel.model-route.ts
- src/contracts/generated/kernel.model-usage.ts
- src/contracts/generated/kernel.qa-report.ts
- src/contracts/generated/kernel.release-evidence.ts
- src/contracts/generated/kernel.review-capsule.ts
- src/contracts/generated/kernel.review-receipt.ts
- src/contracts/generated/kernel.route-admission.ts
- src/contracts/generated/kernel.run-summary.ts
- src/contracts/generated/kernel.runtime-manifest.ts
- src/contracts/generated/kernel.runtime-state.ts
- src/contracts/generated/kernel.session-source.ts
- src/contracts/generated/kernel.state-projection.ts
- src/contracts/generated/kernel.task-contract.ts
- src/contracts/generated/kernel.task-snapshot.ts
- src/contracts/generated/kernel.track.ts
- src/contracts/generated/kernel.work-authority.ts
- src/contracts/generated/kernel.workflow-state.ts
- src/contracts/git-closeout.ts
- src/contracts/host-execution-contract.ts
- src/contracts/host-session.ts
- src/contracts/knowledge-input.ts
- src/contracts/model-execution.ts
- src/contracts/model-route.ts
- src/contracts/optional-capabilities.ts
- src/contracts/project-command.ts
- src/contracts/proof-environment.ts
- src/contracts/proof-execution.ts
- src/contracts/repository-observation.ts
- src/contracts/review.ts
- src/contracts/schema-codec.ts
- src/contracts/schema-definitions.generated.ts
- src/contracts/task-contract-seed.ts
- src/contracts/verification-settlement.ts
- src/contracts/work-unit-scope.ts
- src/contracts/workspace-observation.ts
- src/contracts/worktree-authority.ts
- src/host-tooling/kernel-eval/model-routing-eval.ts
- src/host-tooling/kernel-eval/sentinel-eval.ts
- src/host-tooling/kernel-eval/static-analysis.ts
- src/host-tooling/kernel-public/optimization-cycle.ts
- src/host-tooling/kernel-public/runtime-boundary-audit.ts
- src/host-tooling/kernel-public/unification-audit.ts
- src/host/kernel/adapter-dispatch.ts
- src/host/kernel/adapters/ade.ts
- src/host/kernel/adapters/claude.ts
- src/host/kernel/adapters/codex.ts
- src/host/kernel/adapters/fable.ts
- src/host/kernel/adapters/gemini-cli.ts
- src/host/kernel/adapters/gemini.ts
- src/host/kernel/ade-context-policy.ts
- src/host/kernel/admission-revalidator.ts
- src/host/kernel/cache-replay.ts
- src/host/kernel/claude-effort-policy.ts
- src/host/kernel/codebase/codebase-index.ts
- src/host/kernel/codex-actor-router.ts
- src/host/kernel/codex-agents-policy.ts
- src/host/kernel/codex-model-policy.ts
- src/host/kernel/codex-session-observer.ts
- src/host/kernel/common-model-policy.ts
- src/host/kernel/context-segments.ts
- src/host/kernel/control-plane-runtime.ts
- src/host/kernel/git/closeout-operations.ts
- src/host/kernel/git/remote-parity.ts
- src/host/kernel/git/staging.ts
- src/host/kernel/host-boundary.ts
- src/host/kernel/host-routing.ts
- src/host/kernel/host-session.ts
- src/host/kernel/host-turn.ts
- src/host/kernel/independent-subagent-review.ts
- src/host/kernel/knowledge-input/session-provider.ts
- src/host/kernel/lifecycle-bridge.ts
- src/host/kernel/mcp-composition.ts
- src/host/kernel/model-capsule-view.ts
- src/host/kernel/model-registry.ts
- src/host/kernel/model-route-policy.ts
- src/host/kernel/model-routing.ts
- src/host/kernel/parallel-dispatcher.ts
- src/host/kernel/process-observation.ts
- src/host/kernel/profile-target.ts
- src/host/kernel/prompt-envelope.ts
- src/host/kernel/prompts/claude-opus-5.ts
- src/host/kernel/prompts/codex-gpt-5p6.ts
- src/host/kernel/prompts/common-execution.ts
- src/host/kernel/proof/environment-observation.ts
- src/host/kernel/proof/network-policy.ts
- src/host/kernel/proof/process-tree.ts
- src/host/kernel/proof/project-command-observation.ts
- src/host/kernel/proof/proof-executor.ts
- src/host/kernel/provider-mutation-adapter.ts
- src/host/kernel/provider-prompt-policy.ts
- src/host/kernel/review-readiness.ts
- src/host/kernel/review-transport-resolver.ts
- src/host/kernel/route-admission.ts
- src/host/kernel/session-affinity.ts
- src/host/kernel/session-holder.ts
- src/host/kernel/tool-manifest.ts
- src/host/kernel/turn-dispatcher.ts
- src/host/kernel/upstream-registry.ts
- src/host/kernel/usage-receipt.ts
- src/host/kernel/workspace/contract-path-access.ts
- src/host/kernel/workspace/mutation-observation.ts
- src/host/kernel/workspace/physical-worktree.ts
- src/host/kernel/workspace/repository-observation.ts
- src/host/kernel/workspace/stable-workspace.ts
- src/host/kernel/workspace/workspace-identity.ts
- src/host/kernel/workspace/worktree-resolution.ts
- src/kernel/artifact-paths.ts
- src/kernel/bridge/coordinator-surface.ts
- src/kernel/bridge/mcp.ts
- src/kernel/capability-guidance.ts
- src/kernel/capability-resolver.ts
- src/kernel/change-contract.ts
- src/kernel/context-build.ts
- src/kernel/control-plane.ts
- src/kernel/durable-write.ts
- src/kernel/evidence-pack.ts
- src/kernel/git/closeout.ts
- src/kernel/git/commit-message.ts
- src/kernel/git/staging-policy.ts
- src/kernel/host-services.ts
- src/kernel/installer.ts
- src/kernel/knowledge-ingestion/candidate-extract.ts
- src/kernel/knowledge-ingestion/conflict.ts
- src/kernel/knowledge-ingestion/deduplicate.ts
- src/kernel/knowledge-ingestion/import.ts
- src/kernel/knowledge-ingestion/normalize.ts
- src/kernel/knowledge-ingestion/redact.ts
- src/kernel/knowledge-ingestion/transaction.ts
- src/kernel/knowledge-ingestion/verify.ts
- src/kernel/knowledge/architecture-resolve.ts
- src/kernel/knowledge/candidate-extract.ts
- src/kernel/knowledge/candidate-review.ts
- src/kernel/knowledge/canonical-record-mapper.ts
- src/kernel/knowledge/capture.ts
- src/kernel/knowledge/change-diff.ts
- src/kernel/knowledge/commit.ts
- src/kernel/knowledge/context-load.ts
- src/kernel/knowledge/context-render.ts
- src/kernel/knowledge/freshness.ts
- src/kernel/knowledge/knowledge-authority.ts
- src/kernel/knowledge/ontology-evaluate.ts
- src/kernel/knowledge/ontology-gate.ts
- src/kernel/knowledge/path-scope.ts
- src/kernel/knowledge/projection.ts
- src/kernel/knowledge/receipt.ts
- src/kernel/knowledge/records.ts
- src/kernel/knowledge/store.ts
- src/kernel/knowledge/supersession.ts
- src/kernel/knowledge/tacit-resolve.ts
- src/kernel/knowledge/topology-projection.ts
- src/kernel/legacy-hydration-cleanup.ts
- src/kernel/package-build.ts
- src/kernel/persistence/durable-state.ts
- src/kernel/persistence/finalization-store.ts
- src/kernel/persistence/host-execution-store.ts
- src/kernel/persistence/knowledge-lifecycle-store.ts
- src/kernel/persistence/knowledge-migration-recovery.ts
- src/kernel/persistence/project-identity-store.ts
- src/kernel/persistence/run-journal.ts
- src/kernel/persistence/schema-migrations.ts
- src/kernel/persistence/schema.ts
- src/kernel/persistence/state-store-contracts.ts
- src/kernel/persistence/trust-store.ts
- src/kernel/persistence/work-attempt-store.ts
- src/kernel/persistence/work-lifecycle-store.ts
- src/kernel/persistence/work-store.ts
- src/kernel/policy.ts
- src/kernel/profile-build.ts
- src/kernel/profile-doctor.ts
- src/kernel/profile-install.ts
- src/kernel/profile-projection.ts
- src/kernel/project-hydrate.ts
- src/kernel/project-identity-preflight.ts
- src/kernel/project-identity.ts
- src/kernel/proof-route.ts
- src/kernel/proof/baseline-proof.ts
- src/kernel/proof/completion-provenance.ts
- src/kernel/proof/completion-view.ts
- src/kernel/proof/domain-policy.ts
- src/kernel/proof/evidence-reuse.ts
- src/kernel/proof/failure-classify.ts
- src/kernel/proof/protected-obligations.ts
- src/kernel/proof/review-pipeline.ts
- src/kernel/proof/review-receipt.ts
- src/kernel/proof/trust-authority.ts
- src/kernel/risk-surfaces.ts
- src/kernel/route.ts
- src/kernel/routing/route-admission.ts
- src/kernel/run/attempt-provenance.ts
- src/kernel/run/binding-preflight.ts
- src/kernel/run/capsule-selection.ts
- src/kernel/run/contract-preflight.ts
- src/kernel/run/control-plane-helpers.ts
- src/kernel/run/execution-capsule.ts
- src/kernel/run/finalization.ts
- src/kernel/run/invocation-resolver.ts
- src/kernel/run/lease-policy.ts
- src/kernel/run/measurement.ts
- src/kernel/run/model-route-contract.ts
- src/kernel/run/model-route-metrics.ts
- src/kernel/run/model-routing.ts
- src/kernel/run/model-view.ts
- src/kernel/run/mutation-guard.ts
- src/kernel/run/obligation-compiler.ts
- src/kernel/run/optional-capabilities.ts
- src/kernel/run/receipt-fields.ts
- src/kernel/run/report-identity.ts
- src/kernel/run/required-host-capabilities.ts
- src/kernel/run/run-identity.ts
- src/kernel/run/run-locator.ts
- src/kernel/run/run-loop.ts
- src/kernel/run/run-step-ledger.ts
- src/kernel/run/session-binding.ts
- src/kernel/run/step-planner.ts
- src/kernel/run/successor-key.ts
- src/kernel/run/work-authority.ts
- src/kernel/run/work-cursor.ts
- src/kernel/run/workspace-change-set.ts
- src/kernel/run/workspace-registration.ts
- src/kernel/runtime-home.ts
- src/kernel/runtime-resolver.ts
- src/kernel/sqlite-adapter.ts
- src/kernel/standalone/artifact-utils.ts
- src/kernel/standalone/catalog.ts
- src/kernel/standalone/common.ts
- src/kernel/standalone/prework.ts
- src/kernel/standalone/skills-lock.ts
- src/kernel/state-projector.ts
- src/kernel/state-store.ts
- src/kernel/task/evidence-plan.ts
- src/kernel/task/greenfield-bootstrap.ts
- src/kernel/task/migration-workflow.ts
- src/kernel/task/project-mode.ts
- src/kernel/task/task-contract.ts
- src/kernel/transition.ts
- src/shared/atomic-json.ts
- src/shared/candidate-identity.ts
- src/shared/canonical-digest.ts
- src/shared/context-sanitization.ts
- src/shared/git-safe.ts
- src/shared/match-capture.ts
- src/shared/path-identity.ts
- src/shared/path-scope.ts
- src/shared/payload-path.ts
- src/shared/persistent-sanitizer.ts
- src/shared/redaction.ts
- src/shared/required-index.ts
- src/shared/runtime-assets.ts
- src/shared/runtime-build.ts
- src/shared/runtime-dependencies.ts
