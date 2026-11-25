# Codebase-First Harness 개선작업 최종 결과 (`FINAL-RESULT.md`)

- **브랜치**: `docs/codebase-first-final-20261124`
- **Before SHA (`clean_before_sha`)**: `86246b72b059699d1fd628d6ec26ed36194ab569`
- **After Code SHA (`after_sha`)**: `54558aada92dfcf6d8e78358eab3a521a63b7937` (제품·테스트 코드가 변경된 최종 커밋 SHA; 본 보고서 커밋은 문서 2개만 갱신하여 런타임 바이트와 100% 일치)
- **최종 판정 (`decision`)**: `PARTIAL` (구조적 개선 P0·P1·P2·P3 및 B2a·B2b 구현 완료, 실제 Provider 메시지 prefix 불변·반례 포함 결정론적 Hard Gate 전수 PASS; 라이브 원격 Provider 12회 에이전트 실행 및 외부 저장소 Track B 과제는 `NOT_RUN` 분리)

---

## 1. 단계별 실행 및 커밋 요약

| 단계 / 단위 | 상태 | 커밋 SHA | 핵심 내용 |
| --- | --- | --- | --- |
| **W0** | 완료 | `8889a4c7` | 활성 Host→Kernel→Prompt→Proof 호출 경로(`W0-active-path.md`), Golden-PR 6개 과제(`W0-golden-tasks.json`), 기준선 매니페스트(`W0-baseline-manifest.json`) 확정 |
| **B2a** | 완료 | `7ccd5661` | `prepareNext`, `buildNextForRun`, `status`의 중복 SQLite 조회(`getVerifications` 5→1회, `listReviewReceipts` 3→1회, `getCompletionDecision` 3→1회), `currentProjectCommands` 재스캔(3→1회), `trustAuthority`/`knowledgeAuthority`/`resume` 말미 이중 계산 제거 |
| **B2b** | 완료 | `9c7b5c58` | `observeWorkspaceIdentity`(깨끗한 워크스페이스 Git 서브프로세스 8→2회, 변경 워크스페이스 8→3회), `observeScopedWorkspaceIdentity`(3→1회), 무변이 Owner 기준선 `snapshotHostWorkerPatch` alt-index 생략, `reportUnderLease`→`executeProof` 동일 스코프 관찰 재사용 |
| **P0 (모델-facing 워크플로우 단순화)** | 완료 | `1fb88efe`, `54558aad` | MCP(`processHostLifecycleOutput`)와 CLI(`kernel next`) 경계에서 `baseline-required`를 Host가 자동 캡처해 모델의 관리 왕복 1턴 제거; MCP에서 독립 리뷰 통과(`verdict === 'pass'`) 후 모든 의무·Step 충족 시 즉시 `finalizeRun` 및 `done` 정산 (리뷰 `fail` 시 미종결 `fix` 반례 검증 포함) |
| **P1 (Prompt·Knowledge 전달 구조 및 Provider prefix 통합)** | 완료 | `6c3f00be`, `54558aad` | `MODEL_VISIBLE_PROMPT_FIELDS`를 변경 빈도순(`relevantProjectKnowledge → objective → acceptance → constraints → currentWork → requiredEvidence`)으로 정렬하여 `relevantProjectKnowledge`에는 `projectStable`(`quarantined`·경로 한정 제외)만, `currentWork.taskKnowledge`에는 단계·경로 변동 지식만 연결하고, `eligiblePrefixTokens`도 실제 `providerMessage` 안정 prefix 기준으로 일치시킴 |
| **P2 (Codebase Deletion-first 정리)** | 완료 | `49baba37`, `54558aad` | `prepareHostTurn`의 중복 `assertImplementationWorkUnitScope` 검사를 Kernel `prepareNext` 단일 권위로 통합; `projectKernelModelView(compact)`에서 중복 트리 제거; Claude 에이전트 템플릿에서 `CONTROL_ONLY_CAPSULE_FIELDS` 제거 및 바이트 상한 계약 전환 |
| **P3 (Verification 책임 정리)** | 완료 | `fbcc33db`, `54558aad` | `proofRequestsForReport`에서 `acceptanceCoverage` 생략 힌트에 선언된 `obligation.acceptanceIds` 자동 바인딩; `runHostOwnedWritableAttempt`에서 `verifications: []` 반환 시 Step 바인딩 검증 명령 결정론적 유도 및 미바인딩 fail-closed 반례 검증; 하드코딩 상한(`8`)을 제거하고 명시 바인딩은 전체 유지, `proof-policy` 광역 폴백만 `selectBoundCommandRef` 대표 명령으로 축약 |
| **D** | `NO_CHANGE` | - | 기존 `typecheck`, `check:boundaries`, `lint:kernel` (`static-analysis.js`)이 미탐지 결함 없이 전수 PASS하여 신규 분석기/상시 감사 미도입 |

---

## 2. 결정론적 Before / After 실측 비교

### 2.0 구조적 모델 부담 및 프롬프트·페이로드 감소 (`P0` ~ `P3`)

| 영역 | 측정 항목 | Before | After | 변화 |
| --- | --- | --- | --- | --- |
| **P0** | `baselineRequired` 활성화 런 시작 시 모델이 감당하는 관리 왕복 턴 | 1턴 (`baseline-required` 수신 후 재호출) | **0턴** (Host가 자동 캡처 후 즉시 `implement` 반환) | **-100%** |
| **P0** | MCP 독립 리뷰(`bridge.dispatchReview`) 통과 후 최종 완료까지 추가 모델 `report` 턴 | 1턴 (`action.type = 'report'` 추가 왕복) | **0턴** (Host/Kernel이 즉시 `finalizeRun` 후 `done` 반환, `fail` 시 미종결 보존) | **-100%** |
| **P1** | 실제 `providerMessage` 내 프로젝트·런 안정 prefix 구조 | `currentWork` 변동 필드가 앞에 위치하고 `[Stage: ...]` 단일 문자열이 혼재 | **`relevantProjectKnowledge → objective → acceptance → constraints` 선두 고정, `currentWork.taskKnowledge` 변동 tail 분리** | 실제 Provider 메시지 안정 prefix 바이트 100% 불변 |
| **P1** | `usageReceipt.eligiblePrefixTokens` 산출 기준 | Provider 미전송 내부 Envelope 세그먼트 합산 | **실제 `providerMessage` 안정 prefix(`resolveModelVisibleStablePrefix`) 바이트 기준** | 계측치와 실제 wire 입력 일치 |
| **P2** | 단일 Host Turn 준비(`prepareHostTurn`) 당 Work Unit Scope 검증 횟수 | 2회 (`prepareNext` + `prepareHostTurn`) | **1회** (`prepareNext` 단일 권위) | **-50%** |
| **P2** | Claude 에이전트 템플릿(`kernel-implementer.md`, `kernel-reviewer.md`) 내 Host 전용 제어 필드 노출 | 3개 (`capsuleId`, `workspaceIdentity`, `mutationRevision`) | **0개** (전수 제거, 3,166 → 3,056 bytes) | **-100% (-110 bytes)** |
| **P3** | `report` 검증 힌트에 `acceptanceCoverage` 생략 시 수용 기준 매핑 | 빈 배열(`[]`) 처리로 `incomplete_gates` 발생 | **선언된 `obligation.acceptanceIds` 자동 바인딩** | 수동 AC ID 역추적 부담 제거 |
| **P3** | Host-owned Writable Worker가 `verifications: []` 반환 시 처리 | `host_worker_report_verification_unbound` 즉시 실패 | **Step의 선언된 hard obligation/manifest에서 결정론적 유도 (미바인딩 시 fail-closed 유지)** | 불필요한 Worker 재시도 제거 |
| **P3** | Compact 모델 뷰의 `allowedCommandRefs` 명령 노출 기준 | 전체 스크립트 노출 (최대 108개) | **하드코딩 상한 없이 명시 바인딩은 100% 보존, `proof-policy` 폴백만 `selectBoundCommandRef` 대표 1개로 축약** | 임의 절단 위험 없이 노이즈 제거 |

### 2.1 관리 호출 및 상태 조회 감소 (`B2a`)

| 단일 호출 경로 | 항목 | Before | After | 변화 |
| --- | --- | --- | --- | --- |
| `controlPlane.next(runId)` (`prepareNext`) | `store.getVerifications(runId)` | 5회 | **1회** | **-80%** |
| `controlPlane.next(runId)` (`prepareNext`) | `store.listReviewReceipts(runId)` | 3회 | **1회** | **-67%** |
| `controlPlane.next(runId)` (`prepareNext`) | `store.getCompletionDecision(runId)` | 3회 | **1회** | **-67%** |
| `controlPlane.next(runId)` (`prepareNext`) | `currentProjectCommands()` 매니페스트 스캔 | 3회 | **1회** | **-67%** |
| `controlPlane.next(runId)` (`prepareNext`) | `trustAuthority` / `knowledgeAuthority` / `resume` 빌드 | 각 2회 | **각 1회** | **-50%** |
| `controlPlane.status(runId)` | `getVerifications` / `listReviewReceipts` / `getCompletionDecision` | 각 3~4회 | **각 1회** | **-67~75%** |

### 2.2 검증·스냅샷 경로 Git 서브프로세스 감소 (`B2b`)

| 관찰/검증 함수 | 조건 | Before | After | 변화 |
| --- | --- | --- | --- | --- |
| `observeWorkspaceIdentity` | 깨끗한 Git 워크스페이스 | 8회 | **2회** | **-75%** |
| `observeWorkspaceIdentity` | 변경된 Git 워크스페이스 | 8회 | **3회** | **-62.5%** |
| `observeScopedWorkspaceIdentity` | 스코프 검증 신원 계산 | 3회 | **1회** | **-67%** |
| `snapshotHostWorkerPatch` | 무변이 Owner 기준선 스냅샷 내 alt-index Git 호출 | 2회 (`read-tree`, `diff --cached`) | **0회** | **-100%** |
| `reportUnderLease` → `executeProof` | 단일 obligation 검증 직전 스코프 관찰 | 2회 | **1회** | **-50%** |

### 2.3 Track A Held-Out Oracle 루프 실행 시간 비교

| Golden Task / Oracle | 서브테스트 | Before (`86246b72`) | After (`9c7b5c58`) | 단축률 |
| --- | --- | --- | --- | --- |
| **A-F1** (`tests/kernel-codex-app-server-transport.test.ts`) | `pricing loop through loop-e2e` | 23,250 ms | **11,964 ms** | **-48.5%** |
| **A-F1** (`tests/kernel-codex-app-server-transport.test.ts`) | `pricing loop through loop-guard` | 21,470 ms | **10,707 ms** | **-50.1%** |
| **A-F1** (`tests/kernel-codex-app-server-transport.test.ts`) | `pricing loop through loop-in-turn` | 20,671 ms | **10,390 ms** | **-49.7%** |
| **A-F1** (`tests/kernel-codex-app-server-transport.test.ts`) | `pricing loop through loop-handoff-io-error` | 16,952 ms | **7,597 ms** | **-55.2%** |
| **A-R1** (`tests/kernel-independent-subagent-review.test.ts`) | 13개 독립 서브에이전트 리뷰 테스트 | 13/13 PASS | **13/13 PASS** | 비열화 없음 |
| **A-S1** (`tests/kernel-cli-main-contract.test.ts`) | 4개 CLI 세션 복구·권위 계약 테스트 | 4/4 PASS | **4/4 PASS** | 비열화 없음 |
| **A-D1** (`tests/kernel-codex-agents-md-policy.test.ts`) | 8개 AGENTS.md 표면 계약 테스트 | 8/8 PASS | **8/8 PASS** | 비열화 없음 |

---

## 3. 미검증 항목 (`NOT_RUN` / `unverified`) 및 보호 조건 분리

1. **원격 LLM 에이전트 12회 라이브 실행 (`live_remote_provider_12_run_agent_execution`)**:
   - `PLAN.md` §5~6 규칙("`null` 또는 `NOT_RUN`을 성공·0으로 계산하지 않는다", "미지원 provider/미확인 cache telemetry는 지원 조합만 `PARTIAL/NOT_RUN`; 성공으로 위장하지 않음")에 따라 `final-before-after.json`의 12개 런 레코드에서 라이브 모델 실행 필드를 모두 `outcome: "NOT_RUN"`, 토큰·비용 필드를 `null`로 정직하게 기록했다.
2. **외부 격리 프로젝트 Track B (`B-B1`, `B-F1`)**:
   - 승인된 외부 저장소 fixture가 마운트되어 있지 않으므로 가짜 외부 프로젝트를 생성하지 않고 `NOT_RUN`으로 유지했다.
3. **기존 Worktree 타임아웃 민감 테스트 관찰**:
   - `tests/kernel-codex-app-server-transport.test.ts` 내 222자 깊이 임시 worktree에서 `requestTimeoutMs: 1200~1500`을 사용하는 일부 writable worker 서브테스트는 로컬 macOS 샌드박스의 `git worktree add` 직후 첫 child spawn 지연(~1.6초)에 민감함을 확인했으며, 기존 테스트의 타임아웃 상수를 임의로 완화해 통과를 가장하지 않았다.
