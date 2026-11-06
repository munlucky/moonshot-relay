# Host-owned Worker / Context Continuity 진행 현황

- **유일한 구현 기준:** [PLAN.md](PLAN.md). 필수 검증은 [VERIFICATION.md](VERIFICATION.md). 후속 실험·실행계획은 원래 W0~W6 및 G0~G6의 범위·선행 관계를 바꾸지 않는다.
- **현재 제품 판정 (2026-11-06): PARTIAL.** W0 ContextReceipt 수정은 SOURCE PASS, W1·W2 Host Worker 제어는 CODE/WIRED PARTIAL, W3·W4·W6 제품 수용은 미완료. 테스트 통과를 사용자 기능 완료로 간주하지 않는다.
- **소스 기준:** `main`의 현재 HEAD와 `origin/main`은 Git에서 확인한다. 보안 수정·Fixture PASS를 Native 제품 전체 수용 PASS로 취급하지 않는다.
- **Native 안전 계약:** OS Writer의 물리적 종료·쓰기 배제가 입증되지 않아 기본 Native Writable Worker 자동 시작, 불명확한 Attempt 재실행, 자동 Owner 결과 합류, 충돌하는 Fresh Resume은 계속 **HOLD_SAFE**. 이 차단을 독립적인 조회·기존 Kernel 실행 루프 개발 전체로 전파하지 않는다.

## 최초 계획 대비 실제 구현·검증 상태

| Wave / Gate | CODE / WIRED | TESTED / ACCEPTED | 다음 실제 구현 또는 제한 |
| --- | --- | --- | --- |
| W0 / G0 | ContextReceipt 무음 절단 방지 **구현됨** | 필수 계약 집중 테스트 SOURCE PASS, Native Capability **PARTIAL** | [W0_RESULT](W0_RESULT.md)에서 증거 재사용. OS 격리 추가 반례 연구는 진행 조건이 바뀌지 않는 한 반복하지 않음 |
| W1 / G1 | Host-owned App Server/Attempt, Worktree 예약, 비동기 Turn·중단, 기존 MCP의 명시적 start **부분 연결** | 격리 Fixture PASS, 일반 제품 Native start **HOLD_SAFE**, 실제 Main 종료 후 Native Worker 생존 미수용 | 안전한 실행 수명 경계를 실제 제품 Dispatcher와 연결하고 Writer 격리 필요 기능만 차단 |
| W2 / G2 | `kernel_status` Canonical Attempt 조회, `kernel_attach`의 **기존 Run/Step/Attempt 읽기 전용 재연결**, 동일 Host live Turn 조회, 시작 전 취소 요청 큐잉 **부분 연결** | 다른 Main/독립 Host 조회, 동일 Attempt 유지, 조기 취소→정확한 Turn 신호, 중복 실행 방지 Fixture PASS. 실제 Main 교체·승인 전체 경계·Native 제품 수용 미확인 | 승인/취소 경쟁의 실제 제품 수용 및 안전한 Fresh Resume 연결 |
| W3 / G3 | **CODE/WIRED PARTIAL:** Host-owned Worker의 실제 Git 변경을 기존 임시 Git 인덱스로 **추가·수정·삭제·바이너리 패치 + 분리된 Commit 객체**로 캡처(HEAD·Worker 인덱스 불변). Owner `git apply --check`로 비변경 적용 가능성 확인. 패치 원문은 Host에만 보존하고 경로·Digest·Commit SHA·Step 범위 위반만 `kernel_status`에 노출. 동일 기존 통합 검증기에서 단일 Worker의 별도 통합 Worktree `cherry-pick --no-commit`·Manifest 바인딩 Proof를 검증 전용으로 호출하고 preflight 상태 재조회. Owner 변경·Receipt·Report는 미실행. 미정착 Attempt의 거짓 Report, 중복 Step 지시·Contract 변경은 차단. Worker 결과→검증된 Owner CAS→Report→다음 Step 연동은 **미완료** | 실제 격리 Worktree 파일 변경→다른 Main 조회 Fixture PASS. Owner-direct 3-Step·Report 회귀 PASS. Native Writer 종료 증명·Host-owned 3-Step 제품 수용은 **미완료** | 기존 `integrateParallelResults`의 검증 전용 경로에 단일 Host Worker Commit 후보 연결 및 Host 자동 검증 명령 선택 CODE/WIRED. 미정착 Writer의 Owner CAS 적용·Report·다음 Step은 HOLD_SAFE; 실제 3-Step 수용은 별도 필요 |
| W4 / G4 | 같은 Run/Step Fresh Resume의 제품 통합 **미완료** | 이전 Writer 미확정 자동 재시작은 **HOLD_SAFE**. C/D는 효과 증명 전 미채택 | 안전한 실행 경계와 동일 Run 연속성 우선, 미지원 항목 DEFER |
| W5 / G5 | 안전 불변식 관련 수정·증거 존재 | 개별 반례·Fixture 다수 PASS, I01~I12의 전체 Native 제품 수용은 **PARTIAL** | 기존 증거를 재사용하고 새 구현 영향 범위만 검증 |
| W6 / G6 | 동일 조건 A/B/E/C/D 제품 실험 **미수행** | **NOT_RUN**, 제품 채택 PASS 아님 | 실행 가능한 Arm만 사전 고정된 조건에서 비교, 불가능한 Arm은 NOT_RUN |

## 보존해야 하는 기존 결과와 정리 경계

- **필수 수정 보존:** [W0_RESULT](W0_RESULT.md)의 T23 Contract/ContextReceipt 결함, 기존 Kernel Attempt 원자적 선점, `Run/Step/Attempt/Evidence` 완료 권위와 중복 Writer 차단.
- **Native 음성 증거 보존:** [T49 기술 결정](T49_DECISION.md), [T49 증거 매트릭스](T49_PARALLEL_EVIDENCE_MATRIX.md), [T49 수용 판정](T49_FINAL_ACCEPTANCE.md), [T50 격리 가능성](T50_NATIVE_OS_ISOLATION_FEASIBILITY_AND_FINAL_DECISION_2026-11-05.md) 및 기존 `W0_T*.md` 기록은 **역사적 검증 증거**이며 신규 실행 순서를 지시하지 않는다. 같은 SID 하드링크·분리 Writer 생존 반례는 아직 해소되지 않았다.
- **Windows 후속:** [LOCAL_NATIVE_VERIFICATION_RESULT](LOCAL_NATIVE_VERIFICATION_RESULT.md)과 [실행 결과](WINDOWS_NATIVE_HOST_EXECUTOR_FOLLOWUP_2026-11-05.md)는 L0/L1 PASS, L2~L4 PARTIAL, L5 DEFER를 기록. 시험용 Guarded Proof/CAS와 실제 제품 Native 채택을 구분한다.
- **미채택 실험 코드:** `guardedIntegration`/Canonical recovery/OS Proof 관련 분기는 원본 보안 증거를 파괴하지 않도록 실제 호출자와 소유권을 확인한 뒤 보존·통합·정리를 결정한다. 존재 자체는 W3~W6 진척이 아니다.
- **Git 정리 상태:** Windows Guarded Report/Proof 수정과 검증 결과는 `46b68ceb`로 분리 보존했다. 생성된 테스트 래퍼는 canonical TypeScript 빌드와 일치함을 검사하고 기존 저장소 규칙대로 추적한다. 다른 Windows Worktree가 이 환경에서 `prunable`로 표시되더라도 실제 Windows 원본을 확인하지 않고 강제 정리하지 않는다.

## 2026-11-06 실행 단위 1 부분 구현 — Host Turn 실패 관측

- `host-worker-sessions.ts`: Native Turn 실행 Promise가 거부될 때 `turnStatus=unknown`과 `preflight=blocked (host_worker_turn_unknown)`을 함께 기록한다. 비동기 검증 파이프라인 예외는 기존 `host_worker_preflight_unknown`으로 구분한다. 어느 경우에도 Canonical Attempt 종료·Writer 퇴장·Owner Delivery를 주장하지 않는다.
- `kernel-bridge-mcp.test.ts`: App Server가 Turn 시작 중 종료되는 격리 회귀에서 동일 Attempt 유지, blocked preflight, Owner 미정착, Writer 종료 미검증을 확인한다.
- 검증: `npm run typecheck` PASS, `npm run build` PASS, `npm run build:tests` PASS, 기존 MCP/App Server focused 28/28 PASS, 신규 장애 반례 focused 1/1 PASS, `git diff --check` PASS.
- **판정:** 오류 상태의 관측 가능성만 개선된 **W1/G1 PARTIAL**. 지원 Native Worker의 물리적 Writer 퇴장 증거와 G1 실제 수용, W3 Owner Delivery·Report·3-Step은 미완료. OS 계층 추가, 안전 Gate 완화, 추가 DB·Queue·Scheduler 없음.

## 2026-11-06 대형 실행 묶음 적용 및 MCP Host 연속성 구현

원본 [PLAN.md](PLAN.md)의 1~7번 수용 기준은 보존하고 **A(기존 1·2·3), B(4·5), C(6·7)** 세 개의 실제 제품 기능 묶음으로 개발·검증·커밋한다. 개별 오류 수정이나 테스트 PASS 때마다 종료하지 않는다.

- **A — 핵심 Host-owned 루프: PARTIAL / Native 자동 정착 HOLD_SAFE.** Worker 실행·상태·Git 후보·검증 전용 preflight는 기존대로 재사용한다. 실제 Writer 종료/쓰기 배제를 입증하지 못해 Owner CAS→Canonical Report→3-Step 자동 연계는 **미구현**이다. 비검증 상태를 권한 있는 결과로 변환하거나 허위 E2E PASS로 처리하지 않는다.
- **B — 세션 연속성: CODE/WIRED PARTIAL.** `kernel_attach`의 계약 없는 기존 Run 재접속은 `ensureRun`·`next`·리뷰 없이 Canonical Step/Attempt와 기존 Kernel `resume`(Run/Contract/Evidence의 권위 투영)를 재조회한다. 원래 Host는 live Worker를, 다른 Host는 영속 Attempt만 조회하며 새 Worker로 오인하지 않는다. Worker 생성 중의 Main 취소 신호를 **동일 Native Turn이 시작할 때까지 큐잉**해 그 Turn의 interrupt에만 전달한다. 동일 Runtime의 새 MCP Main에서 Owner-direct 3-Step을 `report.next`로 이어받고 실제 Proof 실패 수정 및 앞선 Proof 재검증을 통한 최종 완료를 확인했다. 이 증거는 **새 Native Worker Thread를 생성하는 G4-E 수용이 아니다**. 실제 Native Main 교체·승인 전체 수용 및 Writer 종료 불명확 상태의 Fresh Resume은 미완료/차단이다.
- **C — 영향 범위 회귀만 수행, 비교 채택 NOT_RUN.** TypeScript·Production Build·Test Build·Boundary PASS, MCP/App Server **29/29 PASS**, Host loop·Report replay·Recovery **32 PASS / 1 macOS 전용 Native SKIP**. Fixture/기존 Owner-direct 경로 증거이지 Host-owned Native G1/G3·Fresh Resume G4-E 제품 수용 증거는 아니다. 미지원 B/E Arm 비교는 수행하지 않는다.
- **복잡도 검토:** 새 DB·Queue·Scheduler·완료 권위·신규 공개 Kernel 명령 없음. 기존 App Server `runTurn`의 준비 콜백과 Host process-local 취소 상태만 추가. Native Writer 퇴장 플래그는 변경하지 않음.

## 2026-11-06 기존 실행 묶음 B — 권위 기반 Main 재조회·Owner-direct 3-Step 수용

- **제품 코드:** `src/kernel/bridge/mcp.ts`에서 `kernel_attach`의 기존 Run 조회 결과에 기존 `cp.status(runId).resume`를 그대로 노출한다. 이 투영은 Kernel의 Run/Contract/Step/Evidence·신선도 판정을 재사용한다. 새 `next`를 실행하거나 새 Worker/Attempt/Thread를 만들지 않는다. 기존 `kernel_status`의 정보 신뢰 범위를 확장하지 않는다.
- **실제 MCP 호출 검증:** 별도 Main Handler가 동일 Runtime Home/Run의 `kernel_attach`에서 `kernel_status.resume`와 동일한 영속 권위를 복원한다. 기존 Owner-direct 3-Step에서 첫 Report의 `report.next`를 이어받아 두 번째 Step을 수행하고 세 번째의 **실제 manifest 테스트 실패**를 수정한다. 최종 파일 수정으로 앞선 Proof가 stale인 상태에서는 완료하지 않고, 기존 두 Hard Proof를 최종 Workspace에 재검증한 후에만 Kernel `completed`를 반환한다. 총 3개 Step, 4개 Step Attempt(실패 1개), Proof 갱신 Report를 확인한다. 새 Handoff, 새로운 Completion Authority 없음.
- **검증:** TypeScript·Production Build·Test Build·Boundary 검사 PASS. MCP/App Server·Host loop·Report replay·Step resume를 결합한 영향 범위 회귀 **64/64 PASS**, 실제 새 Main의 3-Step·Proof 실패·stale 재검증까지 PASS. macOS Native 격리/퇴장 수용은 이번 결과에 포함되지 않는다.
- **수용 구분:** MCP/Kernel 통합 경로 CODE/WIRED 및 격리 실행 PASS. 새 Native Thread 생성, Host-owned Worker의 Owner Delivery, 물리적 Writer 격리, W4-E 자동 Fresh Resume, G6 B/E 성능 비교는 **미완료 / HOLD_SAFE / NOT_RUN**. Owner-direct 증거를 Host-owned Native PASS로 간주하지 않는다.
- **복잡도 검토:** 기존 `resume` 투영을 재사용하고 새로운 DB·Queue·Scheduler·별도 Handoff 구조·새 API 명령은 추가하지 않았다.

## 2026-11-06 지원 가능한 잔여 개발 — Main 독립 프로세스 재연결 및 비인가 Turn 차단

- **W2/G2 구현:** 계약 없는 `kernel_attach`가 `status.resume`와 함께 이미 존재하는 `workAuthority`·`trustAuthority`를 읽기 전용으로 제공한다. Main은 원래 Kernel의 Step·계약 범위·원본 Evidence 신선도·수용 권위를 참조할 수 있다. `next` 소비·Attempt 생성·Worker 시작·완료 권위 추가 없음. 서로 다른 두 실제 MCP 서버 프로세스가 동일 Runtime Home/Run을 조회해도 Run revision/Step/Attempt·Owner 파일은 변경되지 않는 통합 시험을 추가했다.
- **W1/W2/G2·W5 안전 구현:** 완료되지 않은 Native Turn(`failed`/`interrupted`/`unknown`)은 Git 스냅샷과 별개로 `host_worker_turn_not_completed` 차단 preflight를 기록하며 Delivery를 허가하지 않는다. App Server의 서버발 JSON-RPC 승인·입력 요청은 사용자 승인 채널이 없으므로 명시적으로 거부하고 실행 연결을 실패 처리한다. 서버발 요청 ID와 Host RPC 응답 ID가 우연히 같더라도 요청을 응답으로 착각하지 않도록 JSON-RPC `method`를 먼저 판별한다. 승인 가능 기능을 허위로 제공하지 않는다.
- **검증:** TypeScript·Production Build·Tests Build PASS, 실 실행 경로인 독립 MCP 서버 재접속·승인 요청 ID 충돌·조기 취소 집중 **5/5 PASS**, 관련 MCP/App Server·Host loop·Report replay·Step resume 통합 **66/66 PASS**, Boundary PASS, `git diff --check` PASS. 이 결과는 Source/격리 Fixture와 실제 MCP 프로세스 경계의 증거이며 Writer 격리 Native 제품 수용을 대신하지 않는다.
- **지원 범위:** Owner-direct 원래 경로는 유지. 기존 W1/W3의 Native Writable 자동 정착과 W4-E 새 Writer Fresh Resume은 I03 쓰기 배제 미증명으로 `HOLD_SAFE/DEFER`. 실제 사용자 승인 전달은 지원 Host 권위/인터페이스 부재로 `DEFER`. W6의 B/E/C/D 비교는 `NOT_RUN`. 새 OS 계층, DB, Queue, Scheduler, 완료 권위, 별도 Handoff는 추가하지 않았다.

## 2026-11-06 잔여 개발 실행 기준 보완 — 계획만 확정

- [원본 PLAN.md의 잔여 개발 완료 실행 기준](PLAN.md#2026-11-06-잔여-개발-완료-실행-기준--기존-abc-묶음의-재개-조건과-구현-경계)에 **A의 Writer 보호 선행 판단→기존 CAS/Report/3-Step 연결, B의 실제 승인·취소/새 Thread, C의 Native 수용·W0 Baseline 비교**에 대한 코드 경계·선행 증거·실패/DEFER 조건·커밋/수용 기준을 통합했다.
- 이번 변경은 **계획 현행화만 수행**한다. `main/1258ca08`까지 검증된 기존 제품 코드와 G0~G6 현재 판정은 변경하지 않는다. T49/T50 Native Writer 미증명, 승인 Host 채널 부재, B/E/C/D NOT_RUN을 개발 완료로 승격하지 않는다. OS 권한 격리 또는 지원 Host 승인 채널이 새로 확보되지 않는 한 원래 Native 목표는 HOLD_SAFE/DEFER이며, 추가 OS 격리 아키텍처는 사용자 범위 승인 전 도입하지 않는다.

## 재개 지점

[원본 PLAN.md의 A/B/C 실행 묶음](PLAN.md#개발-실행커밋-묶음-2026-11-06-운영-방식-변경) 기준, 현재 안전하게 지원 가능한 **Main 재연결/기존 Kernel 연속성, 취소·비인가 승인 차단, Owner-direct 실행 루프와 영향 범위 회귀**를 구현·검증했다. 해당 부분은 반복 구현하지 않는다. 다음 단계에서 **새로 실행 가능한 미완료 기능은 확인되지 않았다.** A의 Host-owned Native 자동 Owner Delivery, B의 새 Writer Fresh Resume/실제 사용자 승인, C의 B/E/C/D 비교는 필요한 Writer 배제·Host 승인 채널·비교군 지원 조건을 갖추기 전까지 `HOLD_SAFE/DEFER/NOT_RUN`으로 유지한다. 조건 변화가 있을 때만 원래 G1/G2/G3/G4-E/G5/G6의 수용을 재개하며, OS 보안 설계·별도 DB/Queue/Scheduler·대체 마스터플랜이나 과거 실패 반복 시험을 선행 과제로 추가하지 않는다.
