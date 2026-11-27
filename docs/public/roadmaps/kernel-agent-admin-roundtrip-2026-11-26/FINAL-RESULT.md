# Moon Relay Kernel 후속 행동 결정 단일화 — 최종 결과 (`FINAL-RESULT.md`)

- **기준 SHA (`before_sha`)**: `main@8ac626d3` (`8ac626d3730c0c4cfa15f0de2e4576127d531ee7`)
- **작업 범위**: `PLAN.md` S0 ~ S3 + 1차 리뷰 보완(P1 3건, P2 1건) + 2차 리뷰 경계 보완(P1 3건, 결과표 정정)
- **최종 판정**:
  - **구조**: `STRUCTURE_PASS`
  - **기능**: `FUNCTION_PASS`
  - **생산성**: `PRODUCTIVITY_NOT_RUN`
  - **채택 판정**: **`PARTIAL / PRODUCTIVITY_NOT_RUN`** (구조·기능 인수 기준 및 1·2차 리뷰 P1/P2 보완 전수 통과; 라이브 모델 비교는 로컬 샌드박스·구독 제약으로 실행 불가 사실을 §4에 원시 오류와 함께 기록)

---

## 1. S0 — 구현 전 기준선 (`main@8ac626d3`) 관측

격리된 Git 프로젝트와 독립된 `runtimeHome`에서 `main@8ac626d3` 기준으로 세 경로를 관측하고, S3 호환성 재검증용 골든 스냅샷(`run-s0-8ac626d3-settle-pending`, 소유자 세션 `codex:owner-s0-baseline`, `security_boundary` + hard proof + 독립 리뷰 Receipt/Proof 기록 완료, `status=active`, `state=PROVE`, `finalizationStatus=pending`)을 고정했다.

1. **이미 모델 왕복이 0인 경로 (비열화 기준)**:
   - `tests/kernel-bridge-mcp.test.mjs`의 `mcp report dispatches pending Host review and returns the refreshed continuation without a second next call` 및 `mcp next automatically dispatches an independent Host review and returns the Kernel receipt`가 `8ac626d3`에서 통과함을 확인.
2. **기존 Run 재개 (`8ac626d3` 골든 상태 독립 사본 대조)**:
   - 직접 `cp.next(runId)`: `action.type = "report"` 반환(Kernel 자체는 정산하지 않음).
   - CLI `next <runId>` (권한 있는 소유자): CLI 독자 블록이 `cp.finalizeRun()`을 호출해 DB를 `completed`로 바꾼 직후 다시 `cp.next()`를 호출했으나, 완료 전환으로 소유자 바인딩이 닫혀 **`action.type = null` (`host_binding_missing`)** 오류를 반환하는 결함을 관측함.
   - MCP `kernel_next` (권한 있는 소유자): `isReadyReportDirective()`가 `finalizeRun()` 후 `action.type = "done"` 반환(`requireHostBinding: false`였기 때문에 바인딩 검증을 우회).
   - 조회 전용 `cli status`, `mcp kernel_attach`: DB 미변경(`status=active`, `state=PROVE`, `finalizationStatus=pending`, `completionDecision=null`).
   - 타 소유자 `cli next` (`codex:foreign-s0`): `exitCode=1`, `errorCode=host_binding_missing`, DB 미변경.
3. **생산성 기준선 과제**:
   - 동일 초기 Git tree(`77935448a5c0e21824d81868385ea21a7517f448`, `rate-limiter-fixture`, `security_boundary` + `src/limiter.mjs` + `tests/limiter.test.mjs`), 동일 프롬프트·세션 바인딩·CLI 진입점으로 Before(`8ac626d3` detached worktree) vs After(후보) 라이브 비교를 시도했으나, 실행 환경의 두 Provider CLI 모두 도구 실행 단계에서 차단됨(§4 참조).

---

## 2. S1 · S2 · 리뷰 보완 — 구현 변경 요약 (`STRUCTURE_PASS`)

### S1. Kernel Control Plane 단일 정산·복구 귀속
- **`src/kernel/control-plane.ts`**:
  - **정산 입력 단일화 및 엄격한 체크포인트 바인딩 (`buildStructuredSignalsFromCheckpoint` / `resolveBoundReportCheckpoint` / `buildFinalizationInputFromCheckpoint`)**:
    - Report 즉시 정산(`settleVerifiedReport`), 리뷰 후 정산(`completeAcceptedReviewReceipt` → `settleAuthorizedRun`), 권한 있는 재개(`prepareNext` → `settleAuthorizedRun`), 미완료 Finalization 재진입(`reportUnderLease`)이 모두 동일한 `finalizeRun()` 입력 생성 함수를 사용한다.
    - `preferredReportKey`·`preferredAttemptId`가 명시된 경우 정확히 일치하는 Attempt·체크포인트만 사용하며, 둘 다 전달된 경우 같은 Attempt를 가리키는지 검증한다(`report_checkpoint_binding_mismatch`). 지정된 체크포인트가 손상되었거나 누락되면 같은 revision의 다른 Attempt로 폴백하지 않고 fail-closed(`report_checkpoint_unreadable` / `report_checkpoint_missing`)로 차단하며, Git 작업이나 `done`을 수행하지 않는다.
    - 승인된 Git closeout 요청이 있는데 체크포인트·`reportKey`·Workspace가 달라졌고 승인된 closeout 재시도 상태가 아니라면 closeout을 건너뛰어 `done`을 반환하지 않고 fail-closed(`git_closeout_checkpoint_mismatch` / `git_closeout_workspace_mismatch`)로 차단한다.
    - 커밋 생성(`commit_created`) 직후 `finalization_receipt` 저장 전 중단된 Run도 `prepareNext` / `settleAuthorizedRun` 재개 시 기존 `commitSha`에서 이어받아 중복 커밋 없이 완료한다.
  - **Receipt 수락 이후 오류 경계 단일화 (`completeAcceptedReviewReceipt`)**:
    - `ingestReviewerOutcome()`과 `settleReviewReceipt()`가 동일한 후속 처리 함수 `completeAcceptedReviewReceipt()`를 사용한다.
    - `persistReviewReceipt()` 성공 이후 `recordProof()`, `settleAuthorizedRun()`, `prepareNext()` 중 어느 단계에서 오류가 발생하더라도 예외가 Host의 pre-receipt `incomplete_review_chain` 경로로 빠져나가지 않으며, 확정된 `reviewReceiptId`, 실제 `blockedReason`, `errorSummary`, 이미 완료된 단계(`reviewReceiptAccepted`, `proofSettled`, `settlementStatus`, `finalization`, `next: null`)를 그대로 반환한다.
  - **독립 리뷰 의무의 Capsule 고정 Acceptance 판정 (`trust-authority.ts` · `execution-capsule.ts` · `control-plane.ts` · `finalization.ts` · `work-cursor.ts` · `turn-dispatcher.ts` · `review-receipt.ts`)**:
    - `buildReviewCapsule()`이 활성 `obligations`를 받아 `capsule.acceptance` 각 항목에 `id`·`statement`·`obligationIds`를 고정한다.
    - `trust-authority.ts`의 `resolveReviewReceiptVerifiedAcceptanceIds()`가 독립 리뷰 의무 충족 여부를 **해당 Receipt가 실제로 검토한 ID·문구·의무 바인딩**만으로 판정하며, Run 전체의 실행 검증·면제(`coveredAcceptance`)가 독립 리뷰를 대신 충족하는 우회 조건을 완전히 제거했다. 레거시 호환(`8ac626d3`)도 타 검증 대체가 아니라 과거 저장된 해당 Receipt의 `run_capsules` 기록에서 동일 ID·문구·`reviewScope`·`planRevision`이 확인되는 범위로만 한정했다.
    - `evaluateTrustCompletion()` 호출부 3곳(`control-plane.ts`, `finalization.ts`, `work-cursor.ts`) 모두 `resolveReviewCapsulesByReceiptId()`를 전달하고, `isReviewReceiptAcceptanceScopeCurrent()`도 동일 함수를 공용해 판정 기준을 단일화했다.
    - `turn-dispatcher.ts`의 `reviewClaimKey`와 `review-receipt.ts`의 `reviewSubjectKey`에 리뷰 대상 Acceptance 범위를 반영해, 계약 문구 강화 후 새 Reviewer가 이전 리뷰의 Claim/Subject에 막히지 않고 정상 재검토·완료되도록 보완했다.
  - **중단 복구 및 권한·Lease 가드**:
    - `reconcilePendingReviewReceipts()` / `areStepsReadyForSettlement()` / `settleAuthorizedRun()` / `next()` / `prepareNext()` / `resume()`이 단일 Kernel 정산 규칙(Trust Authority, Step Ledger, `preflight(runId, 'finalize')`, Run Lease)을 적용하며, 무상태 `next` 순수성(`kernel-next-purity`)과 Usage Receipt 단독 승격 금지를 유지한다.
    - `ensureRun()` + `src/kernel/run/control-plane-helpers.ts`(`stepImplementationScopeChanged`): 이미 통과한 Step의 구현 범위가 동일하고 Acceptance만 보강된 계약 개정 시 기존 Step ID·`planRevision`을 유지하며, 미입증 Acceptance에 추가 증거를 요구하고 실제 범위 변경 시 정당하게 Replan한다.
- **`src/host/kernel/turn-dispatcher.ts` & `src/host/kernel/lifecycle-bridge.ts`**:
  - `ingestReviewerOutcome()` 결과의 `finalization`, `next`, `blocker`와 `summarizeReviewDispatch()`의 `reviewReceiptAccepted`, `proofSettled`, `settlementStatus`, `blockedReason`, `errorSummary`를 `reviewReceiptId` 유실 없이 전달한다.
  - 중복 리뷰 감지 시 `controlPlane.settleReviewReceipt()`를 호출해 Crash Window 1·2에서 Reviewer 추가 실행 0회로 정착을 이어간다.

### S2. CLI · MCP 어댑터 독자 정산 판단 삭제 및 후속 조회 제거
- **`src/application/kernel-cli/main.ts`**: `next` 명령 말미의 자동 정산 블록(`action.type === 'report' && pending.length === 0 && failed.length === 0` → `cp.finalizeRun()`) **1곳 완전 삭제**. 명시적 `finalize` 명령과 `baseline-required` 자동 캡처 계약은 보존.
- **`src/kernel/bridge/mcp.ts`**:
  - `isReadyReportDirective()` 헬퍼 및 `processHostLifecycleOutput()` 내 자동 정산 호출 블록 **2곳 완전 삭제** (공용 헬퍼로 이동 없음).
  - `processHostLifecycleOutput()`에서 Kernel/Host가 `next: null`과 차단 사유(`reviewReceiptId`, `proofSettled`, `blockedReason`, `blocker`)를 반환한 경우 `controlPlane.next()`를 추가 호출하지 않고, 공개 `kernel_report` / `kernel_next` 응답에 수락된 `reviewReceiptId`, `reviewReceiptAccepted`, `proofSettled`, 원래 `blockedReason`, `next: null`을 그대로 전달한다(추가 조회 0회).
  - `kernel_report` 재전송(`res.idempotentReplay === true`) 시 저장된 Report 결과를 그대로 재생하고 과거 `review` 지시로 Reviewer를 재실행하지 않도록 가드 추가.
  - 선언된 세션(`MOON_RELAY_KERNEL_SESSION_ID`) 존재 시 `requireHostBinding: true` 적용 및 `kernel_status` 명시 `runId`의 읽기 권한 정합성 확보.
  - 응답의 `status`, `workUnitStatus`, `goalStatus`, `continuation`, `finalization`, `next`, `hostReview`를 Kernel 정산 상태와 일치시킴(`finalizationStatus !== 'completed'`일 때 `done` 반환 금지).

---

## 3. S3 — 실행 검증 및 인수 기준 결과 (`FUNCTION_PASS`)

### 3.1 빌드·경계·정적 분석
- `npm run build` — PASS (`files: 324`, `edges: 921`)
- `npm run build:tests` — PASS (`tests: 308`, `helpers: 9`)
- `npm run check:boundaries` — PASS (`modules: 9`, `files: 324`, `edges: 921`)
- `npm run lint:kernel` (`build:check` + `typecheck` + `static-analysis.js`) — PASS (`checked: 1085`)

### 3.2 `8ac626d3` 기존 Run 골든 스냅샷 호환성 검증 (`parityPassed: true`)
`main@8ac626d3`에서 생성해 정산 대기(`status=active`, `state=PROVE`, `finalizationStatus=pending`)로 남긴 골든 스냅샷의 독립 사본을 후보 버전에서 열어 재검증했다.

| 경로 | 권한 | 응답 결과 | 최종 DB 상태 | 빈 Report / 추가 커밋 |
| --- | --- | --- | --- | --- |
| CLI `next <runId>` | 원 소유자 (`codex:owner-s0-baseline`) | `action.type = "done"`, `finalization.finalizationStatus = "completed"` (`8ac626d3`의 `host_binding_missing` 결함 해소) | `completed` / `CLOSE` / `accepted` | 0회 / 0건 |
| MCP `kernel_next` | 원 소유자 (`codex:owner-s0-baseline`) | `action.type = "done"`, `finalization.finalizationStatus = "completed"` (CLI와 완전 일치) | `completed` / `CLOSE` / `accepted` | 0회 / 0건 |
| CLI `next <runId>` | 타 소유자 (`codex:foreign-s0`) | `exitCode = 1`, `errorCode = "host_binding_missing"` | `active` / `PROVE` / `completionDecision = null` | 0회 / 0건 |
| MCP `kernel_next` | 타 소유자 (`codex:foreign-s0`) | `isError = true`, `code = "host_binding_missing"` | `active` / `PROVE` / `completionDecision = null` | 0회 / 0건 |
| CLI `status` | 조회 전용 | `run.status = "active"` | `active` / `PROVE` / `completionDecision = null` | 0회 / 0건 |
| MCP `kernel_attach` | 조회 전용 | `status = "attached"`, `runStatus = "active"` | `active` / `PROVE` / `completionDecision = null` | 0회 / 0건 |

### 3.3 신규 S3 및 1·2차 리뷰 P1/P2 보완 테스트 (17 / 17 PASS)
`node --test --test-name-pattern="S3" dist/tests/kernel-review-host-bridge.test.mjs dist/tests/kernel-cli-main-contract.test.mjs dist/tests/kernel-bridge-mcp.test.mjs` — **17 / 17 PASS**:
- MCP (`5 / 5`): Report 재전송 시 과거 review 미재실행; 동시 권한 재개 1회 정착 + 타 세션/읽기 전용 무변이; `commit_and_push` 부분 정산(로컬 커밋 SHA 생성·`HEAD` 일치·`push_failed`·`action.type = "finalize"`·재개 시 중복 커밋 0건); 승인된 Git 커밋 요청 Report → 독립 리뷰 → 완료(`HEAD` 정확히 1회 전진·Receipt SHA 일치·재전송/재접속 시 `HEAD` 불변); **[P1-A] 공개 `kernel_report`에서 Proof 저장 후 `prepareNext` 지속 실패 시 저장된 `reviewReceiptId`·`proofSettled: true`·원래 `blockedReason`·`next: null` 보존 및 추가 `next()` 호출 0회**.
- CLI (`2 / 2`): CLI 권한 있는 재개 vs 타 소유자/조회 전용 격리; Moonremote CLI 계약 개정(동일 범위 Step ID 유지 + 미입증 AC 추가 증거 요구 + 실제 범위 변경 Replan).
- Review / Host Bridge (`10 / 10`): Receipt 저장 직후 Proof 실패(`reviewReceiptId` 보존); Proof 기록 성공 직후 `prepareNext()` 실패(`reviewReceiptId`·실제 `blockedReason` 보존 + 새 프로세스 재개 시 Reviewer 1회·Judgment Proof 1건 유지); 서브프로세스 Crash Window 1(`after-receipt`) 및 2(`after-proof`) 재개; Workspace 드리프트 차단 + Usage Receipt 단독 거부; Lease 충돌 가드; 다중 Judgment 의무 순차 정착; Capsule 고정 Acceptance 범위(리뷰 중 추가된 AC·문구 강화된 AC 오충족 차단 + 관련 없는 `constraints` 개정의 Receipt 재사용 보존); 커밋 생성 직후 중단 시 `existingCommitSha` 재개(중복 커밋 0건) + 드리프트된 closeout Workspace fail-closed 차단; **[P1-B] 실행 검증과 독립 리뷰가 함께 걸린 공유 AC에서 실행 검증만 통과 시 리뷰 대기 유지 → 현재 문구를 검토한 새 Receipt 유입 시 완료**; **[P1-C] 동일 revision에 두 Report가 존재할 때 지정된 체크포인트 손상·키/Attempt 불일치 시 형제 Report 미채택 및 Git 커밋/`done` 없이 fail-closed 차단**.

### 3.4 집중 회귀 결과 (14개 파일, 총 158건: 154건 통과 · 4건 기존 샌드박스 타임아웃)

| 테스트 파일 | 결과 | 비고 |
| --- | --- | --- |
| `tests/kernel-cli-main-contract.test.mjs` | **6 / 6 PASS** | S3 신규 2건 포함 |
| `tests/kernel-review-host-bridge.test.mjs` | **46 / 46 PASS** | S3 및 1·2차 P1 신규 10건 포함 |
| `tests/kernel-report-replay.test.mjs` | **13 / 13 PASS** | Report 체크포인트·재전송 회귀 전수 통과 |
| `tests/kernel-session-run-lifecycle.test.mjs` | **12 / 12 PASS** | 세션 바인딩·후속 Run·미완료 Finalization 복구 전수 통과 |
| `tests/kernel-structural-bottleneck-remediation.test.mjs` | **4 / 4 PASS** | RCA-1 ~ RCA-4 전수 통과 |
| `tests/kernel-next-purity.test.mjs` | **1 / 1 PASS** | 무상태 `next` 순수성 보존 |
| `tests/kernel-finalization-report-resume.test.mjs` | **1 / 1 PASS** | AC 미커버 시 `action.type = "report"` 보존 |
| `tests/kernel-finalization-lifecycle.test.mjs` | **4 / 4 PASS** | 최종화 수명주기 전수 통과 |
| `tests/kernel-control-plane-lifecycle.test.mjs` | **10 / 10 PASS** | 제어면 수명주기·Resume 뷰 전수 통과 |
| `tests/kernel-review-receipt-completion.test.mjs` | **4 / 4 PASS** | K0 보호 의무·Receipt 무결성 전수 통과 |
| `tests/kernel-independent-subagent-review.test.mjs` | **13 / 13 PASS** | 독립 서브에이전트 리뷰 전수 통과 |
| `tests/kernel-review-cross-process.test.mjs` | **2 / 2 PASS** | 크로스 프로세스 리뷰 경합 전수 통과 |
| `tests/kernel-decomplexification-characterization.test.mjs` | **17 / 17 PASS** | 구조 특성화 전수 통과 |
| `tests/kernel-bridge-mcp.test.mjs` | **21 / 25 PASS** (실패 4건은 기존 기준선 동일) | S3·P1·P2 5건 포함 21건 통과. 실패 4건(`W1/W2`, `W2`, `W3`, `A2-1`)은 `main@8ac626d3` 기준선에서도 동일하게 재현되는 로컬 macOS 샌드박스 `mock-app-server.cjs` child spawn 타임아웃이며, 본 변경에 의한 회귀 없음. |
| **합계 (14개 파일)** | **154 / 158 PASS (4 FAIL)** | 파일별 합계와 총계 완전 일치 (`6+46+13+12+4+1+1+4+10+4+13+2+17+25 = 158`) |

---

## 4. 라이브 생산성 비교 (`PRODUCTIVITY_NOT_RUN`)

동일한 실제 개발 과제(`rate-limiter-fixture`, 초기 tree `77935448a5c0e21824d81868385ea21a7517f448`)에 대해 Before(`main@8ac626d3` detached worktree) vs After(후보) 라이브 실행을 시도했으나, 두 설치된 Provider CLI 모두 현재 샌드박스/계정 조건에서 도구 실행이 불가함을 확인했다.

1. **Claude Code CLI (`2.1.112`)**: `claude auth status`에서 `subscriptionType: null`이며 `claude -p --output-format stream-json` 호출 시 즉시 `exitCode=1` (`undefined is not an object (evaluating '_.input_tokens')`, 도구 호출 0회)로 실패.
2. **Codex CLI (`0.166.0`)**: `Logged in using ChatGPT`로 텍스트 응답은 가능하나, 실제 셸 명령 실행 시 본 샌드박스 내부에서 `ERROR codex_core::tools::router: error=timed out negotiating with the code-mode host`가 발생(`--disable code_mode --dangerously-bypass-approvals-and-sandbox` 포함)하여 모든 명령 호출이 실행 전 타임아웃됨.

가짜 모델 실행이나 수동 시뮬레이션으로 생산성 수치를 대체하지 않고, `PLAN.md` §2·§5 규정에 따라 라이브 비교는 `PRODUCTIVITY_NOT_RUN`으로 기록하며 최종 채택 판정은 **`PARTIAL / PRODUCTIVITY_NOT_RUN`**으로 확정한다.
