# Codebase-First Harness 개선작업 최종 결과 (`FINAL-RESULT.md`)

- **브랜치**: `docs/codebase-first-final-20261124`
- **Before SHA (`clean_before_sha`)**: `86246b72b059699d1fd628d6ec26ed36194ab569`
- **After SHA (`after_sha`)**: `9c7b5c5860c903c96f6acf524af328e1a7d63385`
- **최종 판정 (`decision`)**: `PARTIAL` (결정론적 Hard Gate 전수 PASS 및 관리 호출·Git 관찰·루프 소요 시간 50% 단축 실측 완료; 라이브 원격 Provider 12회 에이전트 실행 및 외부 저장소 Track B 과제는 `NOT_RUN` 분리)

---

## 1. 단계별 실행 및 커밋 요약

| 단계 / 단위 | 상태 | 커밋 SHA | 핵심 내용 |
| --- | --- | --- | --- |
| **W0** | 완료 | `8889a4c7` | 활성 Host→Kernel→Prompt→Proof 호출 경로(`W0-active-path.md`), Golden-PR 6개 과제(`W0-golden-tasks.json`), 기준선 매니페스트(`W0-baseline-manifest.json`) 확정 |
| **B1a** | `NO_CHANGE` | - | 9개 프롬프트 표면 파일의 바이트 잠금 계약(`artifacts/kernel-prompt-audit/prompt-inventory.json`, `prompt-size-after.json`)과 C01 `keep-baseline` 결정 보존 |
| **B2a** | 완료 | `7ccd5661` | `prepareNext`, `buildNextForRun`, `status`의 중복 SQLite 조회(`getVerifications` 5→1회, `listReviewReceipts` 3→1회, `getCompletionDecision` 3→1회), `currentProjectCommands` 재스캔(3→1회), `trustAuthority`/`knowledgeAuthority`/`resume` 말미 이중 계산 제거 및 회귀 테스트 추가 |
| **C** | `NO_CHANGE` | - | `check:boundaries`(9개 모듈, 324개 파일, 912개 엣지) 및 `test:kernel-unification`(G1~G15)으로 단일 canonical source(`src/`) 경계가 이미 강제되어 있으며 활성 소비자 없는 잉여 wrapper 없음 |
| **B1b** | `NO_CHANGE` | - | C가 `NO_CHANGE`이므로 C 의존 잔여 프롬프트 삭제 없음 |
| **B2b** | 완료 | `9c7b5c58` | `observeWorkspaceIdentity`(깨끗한 워크스페이스 Git 서브프로세스 8→2회, 변경 워크스페이스 8→3회), `observeScopedWorkspaceIdentity`(3→1회), 무변이 Owner 기준선 `snapshotHostWorkerPatch` alt-index 생략, `reportUnderLease`→`executeProof` 동일 스코프 관찰 재사용 |
| **D** | `NO_CHANGE` | - | 기존 `typecheck`, `check:boundaries`, `lint:kernel` (`static-analysis.js`)이 미탐지 결함 없이 전수 PASS하여 신규 분석기/상시 감사 미도입 |
| **S6** | 검증 완료 (`NO_CHANGE`) | - | `buildTurnPromptEnvelope`, `context-segments.ts`, `usage-receipt.ts`가 6-세그먼트 prefix 분리 및 raw provider usage telemetry(`input_tokens`, `cached_input_tokens`/`cache_read_input_tokens`, `cache_creation_input_tokens`)를 이미 충족하고 `kernel-cache-replay`/`kernel-cache-usage-receipt` 21/21 PASS |

---

## 2. 결정론적 Before / After 실측 비교

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
