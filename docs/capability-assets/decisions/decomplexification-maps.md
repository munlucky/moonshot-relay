# Decomplexification Transition Maps v2 (Subcapability-Based)

이 문서는 Phase A (Capability Assetization) Baseline v2를 기준으로 Phase B (Kernel Decomplexification)를 실행하기 위한 **Subcapability 단위 5대 인계 맵**을 정의한다.

기존 15개 Capability Family의 거친 분류를 넘어, 각 Family 내부의 47개 세부 Subcapability별 disposition을 기준으로 분할 및 단순화를 수행한다.

---

## 1. CORE MAP (21 Subcapabilities)

현재 Kernel의 본질 경로인 **AI Agent Workflow**와 **Project Knowledge Lifecycle**을 성립시키는 최소 권위 집합이다. Decomplexification 시 반드시 Kernel 내부에 유지되어야 한다.

| Subcapability ID | Parent Family | Role | Product Relevance |
| :--- | :--- | :--- | :--- |
| `task-contract-binding` | task-contract-and-bounded-work | 사용자 목적, 인수조건, 비목표를 불변 계약으로 바인딩 | Workflow: O, Knowledge: X |
| `work-unit-scope` | task-contract-and-bounded-work | 허용/금지 경로 및 제한된 work-unit admission 경계 소유 | Workflow: O, Knowledge: X |
| `run-step-ledger` | step-ledger-resume | 단계별 순차 실행 상태 및 영속 원장 권위 유지 | Workflow: O, Knowledge: O |
| `work-cursor-resume` | step-ledger-resume | 실행 커서 및 안전한 세션 재개 단일 권위 | Workflow: O, Knowledge: O |
| `evidence-binding` | evidence-completion-and-review-authority | 실증 증거 수집 및 인수조건 의무 바인딩 | Workflow: O, Knowledge: X |
| `verification-authority` | evidence-completion-and-review-authority | 검증 실행 결과 평가 및 통과 여부 단일 권위 | Workflow: O, Knowledge: X |
| `completion-decision` | evidence-completion-and-review-authority | 최종 완료 판정 및 릴리즈 승인 게이트 | Workflow: O, Knowledge: O |
| `protected-obligation` | evidence-completion-and-review-authority | 고위험 변경에 대한 필수 검증 의무 강제 | Workflow: O, Knowledge: X |
| `mutation-scope-safety` | mutation-fencing-and-git-closeout | 선언된 경로 외의 임의 파일 변조 차단 | Workflow: O, Knowledge: X |
| `workspace-fencing` | mutation-fencing-and-git-closeout | 작업 공간 분리 및 외부 파일 유출 차단 | Workflow: O, Knowledge: X |
| `project-identity-binding` | project-identity-and-knowledge-lifecycle | 프로젝트 고유 식별자 확정 및 네임스페이스 격리 | Workflow: O, Knowledge: O |
| `knowledge-lifecycle-authority` | project-identity-and-knowledge-lifecycle | 지식 레코드 개정, 대체, 저장 권위 | Workflow: O, Knowledge: O |
| `knowledge-ingestion-normalization` | knowledge-ingestion-and-evidence-graph | 지식 수집, 정규화, 중복 제거 및 충돌 검사 | Workflow: O, Knowledge: O |
| `ontology-gate-promotion` | knowledge-ingestion-and-evidence-graph | 온톨로지 제약 평가 및 프로젝트 지식 승격 | Workflow: O, Knowledge: O |
| `state-transition-authority` | control-plane-state-authority | 런타임 라이프사이클 상태 전이 단일 권위 | Workflow: O, Knowledge: O |
| `minimal-durable-state` | control-plane-state-authority | SQLite 어댑터 기반 실행 상태 영속화 및 투영 | Workflow: O, Knowledge: O |
| `required-capability-contract` | model-routing-and-route-admission | 작업별 필수 역량 조건 선언 및 검증 계약 | Workflow: O, Knowledge: X |
| `route-admission` | model-routing-and-route-admission | 실행 전 라우트 안전성 승인 및 드리프트 방지 | Workflow: O, Knowledge: X |
| `context-build` | context-prompt-cache-and-optimization | 제한된 문맥 빌드 및 민감 정보 마스킹 | Workflow: O, Knowledge: O |
| `knowledge-context-selection` | context-prompt-cache-and-optimization | 프로젝트 지식 선별 및 주입 | Workflow: O, Knowledge: O |
| `context-receipt-freshness` | context-prompt-cache-and-optimization | 문맥 바이트 영수증 및 신선도 검증 | Workflow: O, Knowledge: O |

---

## 2. HOST MAP (13 Subcapabilities)

Kernel authority의 본질은 아니지만 실행 환경 및 제공자(Provider) 적응을 위해 필요한 기능이다. Host Layer, CLI 어댑터, 또는 Provider Bridge로 분리 이관할 대상이다.

| Subcapability ID | Parent Family | Recommended Host Layer | 이관 사유 및 가드레일 |
| :--- | :--- | :--- | :--- |
| `review-transport` | evidence-completion-and-review-authority | Provider Bridge / Review Adapter | 외부 리뷰어 세션 통신은 Host 전송 책임 |
| `git-staging-safety` | mutation-fencing-and-git-closeout | Host Git Closeout Adapter | Git 스테이징 정책 필터링은 배포 환경 책임 |
| `git-commit` | mutation-fencing-and-git-closeout | Host Git Closeout Adapter | Git 커밋 생성은 로컬 형상관리 도구 책임 |
| `host-session-binding` | provider-session-and-execution-boundary | Host Session Manager | Provider 세션 연결 및 인증 관리는 Host 소유 |
| `execution-capsule-transport` | provider-session-and-execution-boundary | Provider Runtime Bridge | 외부 프로세스/컨테이너 실행 및 입출력 전송 |
| `step-worktree-isolation` | provider-session-and-execution-boundary | Host Worktree Manager | 워크트리 생성/정리는 파일시스템 어댑터 책임 |
| `model-selection` | model-routing-and-route-admission | Host Model Policy | 논리 모델 클래스 매핑은 Host의 재량 |
| `provider-selection` | model-routing-and-route-admission | Host Dispatcher | Provider 계정/키 및 런처 호출은 Host 소유 |
| `effort-cost-routing` | model-routing-and-route-admission | Host Cost Policy | 추론 노력(Effort) 및 비용 조율은 Host 소유 |
| `prompt-envelope` | context-prompt-cache-and-optimization | Provider Prompt Adapter | Provider별 시스템 프롬프트 와이어 포맷 맞춤 |
| `prompt-cache` | context-prompt-cache-and-optimization | Provider Cache Client | 캐시 브레이크포인트 생성 및 Provider 캐시 활용 |
| `package-materialization` | account-root-package-and-profile-adoption | Package / Installer Tool | 릴리즈 패키지 빌드 및 매니페스트 번들링 |
| `account-profile-projection` | account-root-package-and-profile-adoption | Profile Installer | 계정 루트 프로필 파일 복사 및 설치 |

---

## 3. OPTIONAL MAP (9 Subcapabilities)

기본 실행 경로에서는 제외되며, 명시적인 사용자 요청이나 고위험 작업 조건에서만 선택적으로 활성화하는 자산이다.

| Subcapability ID | Parent Family | Trigger Condition | 주의사항 |
| :--- | :--- | :--- | :--- |
| `independent-reviewer-execution` | evidence-completion-and-review-authority | 고위험 변경(보안, 마이그레이션, 비가역 변경) | 일상적 버그픽스/구현에는 실행 차단 |
| `remote-parity` | mutation-fencing-and-git-closeout | 명시적 푸시 및 릴리즈 closeout 요청 | 원격 네트워크 실패 시 로컬 커밋 차단 방지 |
| `stagnation-escalation` | model-routing-and-route-admission | 다중 턴 진행 정체(Stagnation) 감지 | 모델 비용 급증 방지 가드레일 필요 |
| `optimization-cycle` | context-prompt-cache-and-optimization | 명시적 토큰 절감 지표 측정 요청 | 런타임 레이턴시 증가 요인이 되어서는 안 됨 |
| `architecture-artifacts` | standalone-architecture-and-research-tools | 설계 선행 작업 및 계약 시드 도출 | 런타임 완료 권위와 결합 금지 |
| `codebase-understanding` | standalone-architecture-and-research-tools | 대규모 리팩토링 전 코드베이스 색인 | 일회성 분석 도구로 격리 |
| `standalone-diff-and-audit` | standalone-architecture-and-research-tools | 사용자 대면 검토용 HTML 리포트 생성 | 별도 CLI로만 구동 |
| `daily-retro-collection` | retrospective-and-regression-learning | 일일 작업 완료 후 회고 트리거 | 런타임 상태에 영향 주지 않음 (Advisory) |
| `improvement-proposals` | retrospective-and-regression-learning | 회고 후 개선 제안 작성 요청 | 자동 지식 승격 금지 |

---

## 4. REFERENCE MAP (2 Subcapabilities)

제품 코드의 기능이 아니라 저장소 품질, 테스트 등록 상태 및 표면 예산을 관측하기 위한 진단 참조 자산이다.

| Subcapability ID | Parent Family | Purpose |
| :--- | :--- | :--- |
| `harness-surface-budget` | harness-surface-and-regression-audit | 저장소 파일수/줄수/토큰 예산 기준선 측정 및 통제 |
| `regression-audit-reporting` | harness-surface-and-regression-audit | 미등록 테스트 탐지 및 회귀 테스트 상태 보고 |

---

## 5. DEPRECATED MAP (2 Subcapabilities)

과거 Relay 세대의 설계 결함과 스플릿 브레인 문제를 겪고 퇴역한 자산이다. 과거 역사와 교훈으로만 보존되며 현 제품에 직접 재도입해서는 안 된다.

| Subcapability ID | Parent Family | Deprecation Reason & Failure Lesson |
| :--- | :--- | :--- |
| `legacy-phase-runner` | legacy-phase-runner-and-harness-adapters | phase/attempt/lease 상태 이원화로 인한 분열 결함. 단일 Step Ledger로 대체됨. |
| `legacy-harness-adapters` | legacy-phase-runner-and-harness-adapters | 구 하네스 브릿지. 새 계약 및 격리 증거 없는 단순 복원 절대 금지. |

---

## 6. C9 Improvement/Eval Ownership Audit

C10 single-variable replay bridge가 추가된 뒤 실제 import graph와 package/CLI consumer를 다시 확인했다. 이 표는 새로운 capability 분류를 만들지 않고, 기존 자산이 **어디에 속하는지**만 명시한다.

| Asset / surface | Ownership classification | Current consumer / reason | C9 disposition |
| :--- | :--- | :--- | :--- |
| `src/host-tooling/kernel-eval/historical-improvement.ts` | active Host/offline eval tooling | current-generation HistoricalWorkCase 및 Knowledge finding 분석 | retain |
| `historical-actions.ts`, `historical-replans.ts` | active Host/offline eval tooling | 실행 hotspot/replan 진단; production mutation authority 없음 | retain |
| `historical-replay.ts` | active Host/offline eval tooling | current `CANDIDATE`를 기존 single-variable replay contract에 연결 | retain |
| `model-prompt-replay.ts` | active Host/eval tooling | ABBA, identity drift, quality → rework → efficiency 판정의 기존 replay contract | retain |
| follow-up / retrieval / model-routing / sentinel eval | active Host/eval tooling | focused regression/eval suite가 직접 소비 | retain |
| `src/host-tooling/kernel-public/optimization-cycle.ts` | active optional Host/public validation | unification audit가 optional optimization-cycle 완료 상태를 검사 | retain |
| `scripts/kernel/optimization-cycle.mjs` | compatibility projection | 위 typed source에서 build가 생성하는 package/runtime projection | retain; source로 취급 금지 |
| `scripts/kernel/eval/*.js` | compatibility projection | `src/host-tooling/kernel-eval/*.ts`의 generated runtime/package output | retain; source로 취급 금지 |
| `tools/retro/**` | active advisory production tooling | `moonshot-relay retro` CLI와 retro tests/package가 직접 소비 | retain |
| `scripts/knowledge-improvement-lifecycle.mjs` | active advisory compatibility validator | harness-memory-promoter skill과 package contract가 직접 사용 | retain until consumer migration |
| `scripts/awtl-memory-promotion.mjs` 및 `scripts/lib/awtl-*` | active explicit promotion/eval tooling | promotion audit, replay probe/scorecard, package contract가 직접 소비 | retain |
| `tools/awtl/trace-to-testcase.mjs` | active eval tooling | eval-regression contract와 package materialization이 직접 소비 | retain |
| `archive/scripts/legacy-phase-adapters/**`의 구 AWTL/phase 구현 | historical/dead asset | 현재 runtime consumer 없음; 비교·교훈 자산으로만 보존 | archive only; 재도입 금지 |

### Authority boundary

위 자산 중 어느 것도 Kernel의 completion, Knowledge persistence, verification 또는 automatic promotion Authority를 새로 소유하지 않는다. 해당 Authority는 기존 CORE capability에 남는다. 특히 retro/historical/replay 결과는 advisory/evidence이며 명시적 review/commit 없이 runtime policy나 canonical Knowledge로 승격되지 않는다.

### 삭제 판정

C9 시점의 실제 local corpus는 `HistoricalWorkCase=74`, `CANDIDATE=0`, `DEFERRED=2`, `INSUFFICIENT=3`이었다. 따라서 C10 consolidated path는 fixture와 fail-closed dogfood는 통과했지만 **실제 candidate replay 성공 사례는 아직 0건**이다.

원 계획의 "새 경로가 실제로 사용된 뒤에만 dead/duplicate path를 제거한다" 조건을 적용하면 이번 C9에서 active/compatibility 자산을 삭제하는 것은 시기상조다. 첫 실제 current-generation `CANDIDATE`가 C10 replay를 통과한 뒤 consumer/import graph를 다시 측정하고, 그때 consumer가 0인 compatibility/advisory 경로만 삭제 후보로 재분류한다.

이 결정은 다음을 추가하지 않는다.

- public Kernel command
- workflow stage
- durable table
- provider fallback
- scheduler/cache/suppression layer
- automatic mutation/promotion authority
- project-specific production heuristic
