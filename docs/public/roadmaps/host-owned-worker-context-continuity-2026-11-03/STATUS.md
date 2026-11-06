# Host-owned Worker / Context Continuity 진행 현황

- **구현 기준:** [PLAN.md](PLAN.md)의 최신 사용자 변경 범위. 검증과 미지원 경계는 [VERIFICATION.md](VERIFICATION.md)를 따른다. 이전 W0~W6 및 G0~G6 전체 수용 기록은 이력으로 보존한다.
- **최신 개발 종료 범위:** 로컬 제품 기능 연결 1~5의 코드 개발 완료. 사용자의 완료·커밋·푸시 요청에 따라 같은 Run의 Contract Revision 4으로 범위를 변경했다. 아래 전체 Native 제품 판정과 구분한다.
- **현재 제품 판정 (2026-11-06): PARTIAL.** W0 ContextReceipt 수정은 SOURCE PASS, W1·W2 Host Worker 제어는 CODE/WIRED PARTIAL, W3·W4·W6 제품 수용은 미완료. 테스트 통과를 사용자 기능 완료로 간주하지 않는다.
- **소스 기준:** `main`의 현재 HEAD와 `origin/main`은 Git에서 확인한다. 보안 수정·Fixture PASS를 Native 제품 전체 수용 PASS로 취급하지 않는다.
- **Native 안전 계약:** OS Writer의 물리적 종료·쓰기 배제가 입증되지 않아 기본 Native Writable Worker 자동 시작, 불명확한 Attempt 재실행, 자동 Owner 결과 합류, 충돌하는 Fresh Resume은 계속 **HOLD_SAFE**. 이 차단을 독립적인 조회·기존 Kernel 실행 루프 개발 전체로 전파하지 않는다.

## 최초 계획의 전체 Native 수용 상태와 초기 구현 이력

| Wave / Gate | CODE / WIRED | TESTED / ACCEPTED | 다음 실제 구현 또는 제한 |
| --- | --- | --- | --- |
| W0 / G0 | ContextReceipt 무음 절단 방지 **구현됨** | 필수 계약 집중 테스트 SOURCE PASS, Native Capability **PARTIAL** | [W0_RESULT](W0_RESULT.md)에서 증거 재사용. OS 격리 추가 반례 연구는 진행 조건이 바뀌지 않는 한 반복하지 않음 |
| W1 / G1 | Host-owned App Server/Attempt, Worktree 예약, 비동기 Turn·중단, 기존 MCP의 명시적 start **부분 연결** | 격리 Fixture PASS, 일반 제품 Native start **HOLD_SAFE**, 실제 Main 종료 후 Native Worker 생존 미수용 | 안전한 실행 수명 경계를 실제 제품 Dispatcher와 연결하고 Writer 격리 필요 기능만 차단 |
| W2 / G2 | `kernel_status` Canonical Attempt 조회, `kernel_attach`의 **기존 Run/Step/Attempt 읽기 전용 재연결**, 동일 Host live Turn 조회, 시작 전 취소 요청 큐잉 **부분 연결** | 다른 Main/독립 Host 조회, 동일 Attempt 유지, 조기 취소→정확한 Turn 신호, 중복 실행 방지 Fixture PASS. 실제 Main 교체·승인 전체 경계·Native 제품 수용 미확인 | 승인/취소 경쟁의 실제 제품 수용 및 안전한 Fresh Resume 연결 |
| W3 / G3 | **CODE/WIRED PARTIAL:** Host-owned Worker의 실제 Git 변경을 기존 임시 Git 인덱스로 **추가·수정·삭제·바이너리 패치 + 분리된 Commit 객체**로 캡처(HEAD·Worker 인덱스 불변). Owner `git apply --check`로 비변경 적용 가능성 확인. 패치 원문은 Host에만 보존하고 경로·Digest·Commit SHA·Step 범위 위반만 `kernel_status`에 노출. 동일 기존 통합 검증기에서 단일 Worker의 별도 통합 Worktree `cherry-pick --no-commit`·Manifest 바인딩 Proof를 검증 전용으로 호출하고 preflight 상태 재조회. 실제 Worker 보고서·Git 후보는 원본 Attempt에 귀속. Owner Delivery·Report는 미실행. 미정착 Attempt의 거짓 Report, 중복 Step 지시·Contract 변경은 차단. Worker 결과→검증된 Owner CAS→Report→다음 Step 연동은 **미완료** | 실제 격리 Worktree 파일 변경→다른 Main 조회 Fixture PASS. Owner-direct 3-Step·Report 회귀 PASS. Native Writer 종료 증명·Host-owned 3-Step 제품 수용은 **미완료** | 기존 `integrateParallelResults`의 검증 전용 경로에 단일 Host Worker Commit 후보 연결 및 Host 자동 검증 명령 선택 CODE/WIRED. 미정착 Writer의 Owner CAS 적용·Report·다음 Step은 HOLD_SAFE; 실제 3-Step 수용은 별도 필요 |
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

## 2026-11-06 실행계획 범위 조정 — OS 보안 플랫폼 제외

- [원본 PLAN.md의 Host/Kernel 중심 잔여 실행 기준](PLAN.md#2026-11-06-잔여-개발-실행-기준--hostkernel-중심-os-관리-기능-제외-개정)으로 이전의 **“OS 격리 확보를 전체 개발의 필수 선행 조건으로 둔 순서”**를 교체했다. A(Host 실행 수명·Worker 후보·기존 Owner CAS/Report/3~5-Step CODE/격리 통합), B(Main 교체·취소·지원 시 승인·E Fresh Resume), C(영향 범위 Native 수용·실측 채택)를 기존 범위에서 진행한다.
- **새로 개발 가능한 범위:** 독립 Host 실행 경계 연결, 후보 검증→기존 정착 엔진의 **격리 fixture 관통 연결**, `report.next` 단일 소비, Main 연결 수명/Worker 실행 수명 차이의 실제 MCP 검증. 현재 지원되지 않는 Native 자동 정착·Fresh Writable Thread는 I03 Writer 배제 증거가 확보되기 전까지 **HOLD_SAFE/DEFER**다. 원래 T49/T50 반례와 G0~G6 판정을 변경하거나 OS 사용자·ACL/DACL·Job Object·권한 상승 서비스 등 새로운 OS 관리 계층을 추가하지 않는다.
- **이번 변경은 계획 문서 수정만 수행.** Source/Fixture/Native 제품 Gate는 이전 증거 수준 그대로이며, 이후 개발은 작은 수정 단위가 아닌 A/B/C 실제 기능 묶음으로 구현·검증·한글 상세 커밋·푸시한다.

## 2026-11-06 A1 구현 — 동일 Host의 MCP Main 교체와 실행 핸들 재사용

- **실제 코드:** `createMcpBridgeHandler`와 `startMcpBridgeServer`에 **기존 `HostWorkerSessions` 객체를 주입하는 Host 소유 결합 경계**를 추가했다. 기존 기본 서버는 자체 Sessions를 유지한다. 장기 생존 Host가 새 MCP Main 스트림마다 새 Handler를 만들더라도 동일 Worker의 실행 핸들·취소를 공유한다. 새 Daemon/DB/Queue/Scheduler/Completion Authority는 없다.
- **상태 격리:** Sessions의 조회·취소 키는 `[canonical projectRoot, canonical runtimeHome, runId]`가 되며 서로 다른 Kernel Runtime Home의 동일 Run ID가 같은 Worker를 조회하거나 중단할 수 없다. 기존 Canonical Attempt가 재실행/중복 완료 권위인 것처럼 변환하지 않는다.
- **검증:** 두 개의 **실제 MCP 스트림**을 순차 연결해 첫 Main 스트림을 종료한 후 다른 Main의 `kernel_attach`와 `interrupt`가 동일 Host Worker/Attempt를 제어하는 것을 검증했다. Cross-runtime `status/interrupt`는 연결 거부. TypeScript, Production Build, Tests Build PASS, 집중 1/1 PASS 및 기존 MCP/App Server·Host loop·Report replay·Step resume 관련 **66/66 PASS**, Boundary 검사 PASS.
- **제품 판정:** **A1 CODE/MCP fixture PASS, Native 실제 사용자 Host 재연결 PARTIAL.** MCP/Host 프로세스 자체가 종료된 뒤 실행 핸들 복구까지 보장하지 않으며, 다른 Host의 live Worker를 원격 제어한다고 주장하지 않는다. A2의 검증된 후보→Owner CAS/Report 자동 정착과 A3의 Host-owned 3~5 Step 연속 제품 실행은 여전히 미연결/미수용. 기존 Proof-only 후보·Owner-direct 3-Step·Report replay는 재사용하며, Native 쓰기 배제(I03) 미증명으로 자동 Owner 적용은 HOLD_SAFE. 지원 안 되는 사용자 승인 왕복·Fresh Writable Thread와 W6 B/E/C/D는 DEFER/NOT_RUN 유지.
- **복잡도:** 최소한의 Host 결합 주입과 Runtime 키 보강만 추가. 새 OS 격리, 보안 사용자/ACL, 임시 true 플래그, 임의 폴백, 새로운 영속 상태 없음.

## 2026-11-06 A2/A3 잔여 실행계획 구체화 — 문서 작업만 수행

- [기존 PLAN.md의 묶음 A](PLAN.md#묶음-a--a1-재사용-a2a3-실제-연결-구현-w1w3-g1g3)에 A2-1 Worker 후보·원본 Canonical Attempt/`workerReport` 인계, A2-2 기존 `integrateParallelResults`와 Owner CAS·`settleParallelResult` 접합, A2-3 CAS/Report 중단 복구, A3-1 `report.next` 단일 소비, A3-2 Host-owned 3~5-Step 수용을 **기존 하나의 기능 묶음**으로 정리했다. 실제 API/Receipt 필수 필드, 실패 시 Owner 변경 0/Report 0, 정확히 한 번 정착/재실행 0의 완료 조건을 명시했다.
- **현재 코드 판정은 불변:** A1 CODE/MCP PASS, Host-owned Proof-only 경로 기존 구현, A2/A3 **제품·코드 관통 미수용**, Native 자동 Delivery와 새 Writable Thread는 I03 미증명으로 HOLD_SAFE/DEFER. B의 승인 왕복·E Fresh Resume은 기존 Host 채널/Writer 배제 조건에 종속, C의 B/E/C/D 실측 NOT_RUN. 이번 작업은 제품 코드/테스트/Native 실행을 변경하지 않았다.
- **다음 개발 원칙:** 테스트 성공을 위해 `verifiedNativeWriterIsolation`·`writerExitVerified`를 가짜로 올리거나 별도 완료 엔진/OS 보안 관리 시스템을 추가하지 않는다. 기존 같은 생산 코드 경로에 연결하고, 실제 Writer 종료·쓰기 권한 증거가 있는 환경에서만 Owner 자동 적용을 수용한다. 안전한 Fixture 구성이 불가능하면 해당 기능은 PASS 대신 미수용으로 남기고 독립 기능을 진행한다.

## 2026-11-06 A2 결과 인계 구현 및 기존 정착 경계 검증

- **A2-1 CODE / 격리 통합 PASS:** App Server의 실제 `item/completed` 최종 응답을 원래 Thread/Turn에 결합하고 기존 `CODEX_WORKER_OUTPUT_SCHEMA`로 검사한다. 다른 Turn·중간 응답은 제외한다. 서로 다른 최종 응답, 누락·잘못된 JSON·위조 소유자 필드·누락 경로·Manifest에 묶이지 않은 Proof 요청·blocked 결과는 거부한다. 모델이 요청한 검증은 증거가 아니며 Kernel의 기존 검증 명령만 사용할 수 있다.
- **Canonical 인계:** 실제 Git Commit·패치 Digest·경로·Workspace Identity와 모델 보고서를 기존 `recordStepResult`로 원본 Attempt에 함께 저장한다. 기존 SQLite 트랜잭션에서 Contract/Plan/Mutation Revision·실행 Workspace·현재 Step/Attempt를 검사한다. 동일 결과 재요청은 그대로 재사용하며 다른 결과로 덮어쓰지 않는다. 이 기록은 **관측된 후보**다. Attempt 완료, Owner Mutation Provenance, Proof PASS, Delivery Receipt, Report를 생성하지 않는다.
- **기존 검증·복구 재사용:** `verifyHostOwnedWorkerCandidate`가 메모리 후보와 영속 `workerReport`의 일치를 검사하고 기존 `integrateParallelResults(verifyOnly)`에 연결한다. 검증 전후 Revision·결과·Workspace를 재확인한다. 기존 `recoverPendingDeliveryMaterialization`도 Host-owned 후보를 인식한다. Owner 변경 후 CAS 기록이 없는 불명확한 중단은 기존 차단 상태로 전환하며 파일 재적용·새 Worker·Report를 만들지 않는다.
- **B의 독립 경계 PASS:** 같은 Host의 Main 교체 후 원래 Attempt/후보를 조회하고 중복 start가 같은 Attempt를 재사용한다. 조기 Report는 `worker-reconciliation-required`로 거부한다. 인증된 사용자 승인 채널은 없으므로 승인 왕복은 DEFER다. 이전 Writer 미확정 상태의 Fresh Writable Resume도 DEFER다.

### A2/A3 미수용 근거와 다음 연결 조건

| 항목 | 이번 판정 | 코드에서 확인한 제한 |
| --- | --- | --- |
| A2-1 실제 결과→Canonical Attempt | CODE / 격리 PASS | 기존 결과 스키마와 상태 저장소를 재사용. Native 완료 권한은 추가하지 않음 |
| A2-2 Proof→Owner CAS→Report | 미연결 / Native HOLD_SAFE | `codex-app-server-transport.close()`는 App Server 종료만 관측하며 `writerExitVerified=false`를 반환. 완료 Turn 뒤 실제 분리 Writer가 계속 쓰는 기존 T27 반례도 재현됨. 제품 Host의 Writer 퇴장 증거 생성자가 없음 |
| A2-3 CAS/Report 중단 복구 | 후보 인식·모호한 중단 차단 구현. Host-owned 관통 수용 미완료 | 기존 병렬 CAS 직후 중단·Report replay·복구 경쟁 회귀를 재사용. 이를 Host-owned 자동 정착 성공으로 바꾸지 않음 |
| A3-1 `report.next` 단일 후속 실행 | Host-owned 미연결 | A2-2의 실제 정착 Report가 없으므로 소비할 Host-owned `next`가 없음. 별도 `next` 호출이나 가짜 완료로 진행하지 않음 |
| A3-2 Host-owned 3~5-Step | 미수용 | 기존 Owner-direct 3-Step 성공과 구분. Writer 배제 확인 없이 두 번째 Worker를 시작하지 않음 |
| C I01~I12 / A·B·E 비교 | 영향 범위 회귀 PASS / 전체 Native PARTIAL / B·E·C·D NOT_RUN | 미지원 Arm의 성능·비용 수치를 만들지 않음 |

현재 유한 동기 Writer Fixture는 실제 파일 변경·원본 결과 인계·Proof-only 검사까지 검증한다. 제품 API에는 이 Fixture와 Native의 **후손 Writer 배제**를 증명하는 공통 실행 수명 경계가 없다. App Server 종료를 Writer 퇴장으로 바꾸거나 테스트 전용 승인 bool/가짜 Delivery Receipt/별도 적용 루틴을 추가하면 PLAN의 금지 조건을 위반한다. 따라서 A2-2 이후를 PASS로 처리하지 않으며 호출자 없는 정착 어댑터도 추가하지 않았다. 이는 OS 플랫폼 추가를 전체 개발의 선행 과제로 새로 요구하는 결정이 아니다. 기존 제품 경계에서 확인한 미지원 조건이다.

- **검증:** TypeScript·Production Build·Tests Build·Boundary·`git diff --check` PASS. 관련 MCP/App Server·Host loop·Report replay·Step resume·병렬 정착/복구 회귀 **108 PASS / 0 FAIL / 2 POSIX 전용 SKIP**. 실제 분리 Writer 생존, Proof 실패, CAS 직후 Host 종료, 두 Host 복구 경쟁, stale Proof, Report 재실행 차단을 포함한다. 기존 병렬·Owner-direct 성공은 Host-owned A3-2 수용을 대신하지 않는다.
- **Windows 검사 복구:** 최초 확장 회귀의 실패 8건을 변경 전 `a9576033`에서도 재현했다. 원인은 Fixture의 CRLF 변환, 긴 임시 Git 경로, Windows 절대 경로의 ESM import였다. 해당 테스트에만 LF 설정·짧은 임시 경로·`pathToFileURL`을 적용했다. 제품 코드의 OS 우회나 전역 Git 설정은 추가하지 않았다.
- **복잡도:** 기존 Worker 스키마·Attempt/Step 테이블·트랜잭션·통합 검증기·Owner 복구 권위를 재사용했다. 새 DB·Queue·Scheduler·상태 머신·OS 관리 계층·프로젝트 전용 정책·Native true 플래그 없음.
- **커밋 경계 복구:** 관리형 `kernel-commit`이 Windows에서 `INVALID_GIT_PATH`로 중단됐다. 실제 원인은 `admitKernelMutation`이 대소문자 비교용 키를 스테이징 경로로 반환해 추적된 `STATUS.md`를 `status.md`로 바꾼 기존 결함이다. 원래 Git 경로를 스테이징에 보존하고 비교에만 정규화 키를 사용하도록 수정했다. 외부 변경·기준선 제외·경로 검증 정책은 유지하며, 기존 admission 회귀를 대소문자가 섞인 실제 추적 파일로 보강했다. 일반 Git 커밋 우회나 런타임 상태 수정은 하지 않는다.
- **추가 Git 검사:** admission·경로 검증·사전 스테이징 보호·중복 커밋 방지·재푸시·authority audit **14/14 PASS**. 타입·Production/Tests Build·Boundary도 PASS다. 별도 스테이징 정적 검사에서는 스냅샷 함수의 직접 `git add` 호출을 금지하는 기존 검사 1건이 실패했으며, 변경 전 `a9576033`에서도 동일하게 재현됐다. 이번 Worker 인계·커밋 경로 수정이 만든 실패가 아니다. 관리형 실행 파일의 standalone lock은 기존 생성기로 재생성했다. 위 108건 PASS 집계와 이 추가 Git 정적 검사의 기존 실패를 구분한다.
- **승인 계보의 커밋 누락 복구:** 첫 관리형 커밋은 복구 코드·문서 4개만 포함했고, 승인된 이전 Run의 Worker 소스를 기준선 보존 대상으로 제외했다. 이전 Run의 실제 승인 경로는 보존 대상에서 제외하고 미승인 사용자 기준선만 유지하도록 기존 admission을 수정했다. 실제 격리 Worktree의 새 Kernel 작업 단위에서 원본 패치를 재인계해 검증·커밋한다. 완료 후의 HEAD 변경 때문에 발생한 successor continuity 불일치를 사용자 승인으로 위장하거나 DB/Receipt를 수정하지 않는다.

## 2026-11-06 완료 조건 정정 — 원래 A2/A3 요청은 미완료

- **다음 실행 기준:** [PLAN.md의 완료 조건 정정](PLAN.md#완료-조건-정정--다음-개발에-적용할-필수-기준-2026-11-06). A2-1~A3-2는 모두 묶음 A의 필수 조건이다. “안전한 관통 실행이 불가능하면 근거를 남긴다”는 문장을 성공 Acceptance의 대체 조건으로 사용하지 않는다.
- **과거 `done`의 범위:** 앞선 Run은 A2-1 결과 인계·미수용 기록·관리형 커밋 복구를 수락했다. A2-2~A3-2 구현·관통 수용을 완료한 증거가 아니다. 원래 요청은 계속 **미완료**다. 과거 Receipt/DB는 수정하지 않고 이 범위 차이를 보존한다.
- **완료 보고 제한:** 기존 108건 회귀·14건 Git 회귀·빌드·푸시 성공을 전체 A2/A3 완료로 사용하지 않는다. 각 AC에는 실제 검증한 증거만 연결한다. 필수 구현/통제 관통 실행이 막히면 미충족 AC와 blocker를 남기며 모든 AC를 충족으로 제출하지 않는다.
- **분리 판정:** A의 코드·통합 완료, B의 각 세션 기능, Native 제품 수용, C의 비교·채택을 각각 기록한다. Native HOLD_SAFE·승인/Fresh Resume DEFER·비교 NOT_RUN은 A2-2 이후 코드 개발을 자동 제외하지 않는다. 안전한 통제 검증도 불가능하면 A는 미완료로 남는다.
- **이번 정정은 문서 작업이다.** PLAN/STATUS의 완료 기준만 수정하며 새 제품 구현·Native 수용·전체 Kernel 완료를 주장하지 않는다.

## 2026-11-06 정착·후속 실행 연결 — 통합 수용 진행 중

`codex/host-worker-integration`에서 기존 A2-1 구현을 이어서 개발했다. 아래는 이 작업 트리의 관측이다. 위의 최초 인계 판정은 당시 결과로 보존한다.

| 항목 | 현재 관측 | 남은 수용 |
| --- | --- | --- |
| A2-1 | 실제 후보 인계와 Main 교체 회귀 통과. Owner의 기존 staged 변경과 untracked 파일을 보존하고 Worker 변경만 후보에 포함한다. Owner Index만 바뀐 경우도 Proof 전에 차단한다. | 전체 Run의 통합 증거와 연결 |
| A2-2 | 기존 통합 Proof와 Owner Fence/CAS, Canonical Report 호출을 연결했다. 실제 Writer 배제 경계가 없거나 Proof runner를 바꾸면 자동 정착을 허용하지 않는다. | 보호된 동일 제품 경로에서 실제 파일 적용·Revision 증가·Report 각 1회 확인 |
| A2-3 | 공유 정착에서 Report 저장 뒤 응답 유실을 재현하고 재연결 시 같은 Report를 반환했다. Owner Fence가 유효한 적용 중에는 재연결을 대기 상태로 표시한다. Fence 종료 뒤 CAS 기록 없는 파일 변경은 차단한다. | Host-owned CAS 후 Report 전 재개와 각 중단 지점의 제품 경로 관통 수용 |
| A3-1 | Kernel은 성공한 단일 Host-owned Report에 `next`를 함께 저장한다. 같은 Host만 저장된 Report와 현재 Revision을 확인해 후속 구현을 시작하도록 연결했다. Main 상태 조회에는 내부 `next`와 Proof 원본을 포함하지 않는다. | 실제 정착을 거친 후속 실행, 중복 경쟁, Proof 실패 뒤 같은 Step의 수정 Attempt 수용 |
| A3-2 | 미수용 | 동일 Run의 보호된 Host-owned 3~5-Step, 실패 수정, stale Evidence 재검증, 원래 계약의 최종 `done` |
| B | 통제된 MCP에서 Main 교체, 같은 Attempt 조회, 동시 start 1회, 정확한 Turn 취소를 검증했다. 인증된 채널이 없는 승인 요청은 기존 경로에서 거부했다. | 승인 왕복 및 Fresh Writable Resume은 실제 채널과 Writer 보호가 필요하다. |
| C | 타입·Production Build·Tests Build·Boundary·Git diff 검사 통과. 관련 회귀 90 PASS, 실패 0, POSIX 전용 2 SKIP. | I01~I12의 Host-owned 관통 증거와 Native 수용, 지원 Arm 실측 비교. B/E/C/D는 NOT_RUN. |

macOS 원격 연결에서 Native Host 실행기의 상태를 확인할 수 없었다. Windows에서는 제품이 신뢰하는 Writer 배제와 보호된 Proof 경로가 확인되지 않았다. Native 자동 정착은 HOLD_SAFE다. 위 회귀는 공통 복구와 MCP 제어의 증거다. A2-2나 A3의 관통 Acceptance는 미충족이며, 이 상태에서 전체 Run 완료를 보고하지 않는다.

### 로컬 기준과 CAS 후 Report 복구

- 현재 로컬 Git 작업 트리와 그 Kernel Run을 판정 기준으로 삼는다. 로컬 Host는 `startLocal`에서 바인딩된 Kernel 지시를 가져온다. MCP는 같은 Host 세션에 받은 지시를 전달한다. 실제 Writer 보호가 없는 로컬 Host의 Native 시작은 차단한다.
- CAS가 이미 기록됐으면 Kernel은 원래 Attempt의 Revision, Workspace Identity, 패치 Digest와 경로가 기록과 일치할 때만 `report-pending`으로 판정한다. 보호된 Host는 Owner 내용을 새 Proof 작업 트리에 재구성하고 같은 Attempt의 Report를 재개한다. 이 분기에는 Owner 재적용이나 새 Worker 시작이 없다.
- 로컬 격리 시험에서 실제 Git 패치와 Kernel CAS를 사용해 Report 전 중단 상태를 만들었다. 새 Control Plane 연결에서 같은 Attempt와 CAS를 찾았고, Revision은 1회, Attempt는 1개로 유지됐다. Owner 파일을 바꾸면 복구를 차단했다. 이 시험의 직접 CAS 준비는 분류 경계 검증이다. 보호된 Host의 Report 재개와 전체 A2-3 관통 수용은 남아 있다.

## 재개 지점

[PLAN.md의 정정된 완료 조건](PLAN.md#완료-조건-정정--다음-개발에-적용할-필수-기준-2026-11-06)으로 이어간다. A1과 A2-1 구현·증거를 재사용하고 **A2-2→A2-3→A3-1→A3-2를 하나의 기능 묶음으로 구현·검증**한다. 기존 제품의 검증·정착·후속 실행 경로를 공유하고 안전한 통제 환경의 관통 수용을 수행한다. 실제 Writer 배제 근거 없이 Owner 적용·새 Writer를 허용하지 않는다. 이 조건을 충족하지 못하면 해당 수용은 BLOCKED이며 묶음 A는 미완료다. Native HOLD_SAFE를 코드 개발 전체의 종료 조건으로 사용하지 않는다. B의 독립 Main 연속성·취소 검증은 계속하며 승인 왕복·Fresh Writable Thread와 C의 비교는 실제 지원 조건에 따라 별도 판정한다. 기존 Owner-direct 3-Step·Report replay 증거는 보존하되 Host-owned 관통 증거로 대체하지 않는다.

### 로컬 후보 Proof 실패와 같은 Step 수정

- 로컬 fixture에서 실제 Manifest 명령을 종료 코드 19로 실패시켰다. 원래 Attempt에 실패 증거가 남고, Kernel이 같은 Step의 다음 Attempt를 지정했다. 수정 후보는 같은 명령을 통과했다. 실패 경로에서 Owner 파일·Mutation Revision·완료용 Evidence는 보존됐고 Canonical Report는 생성되지 않았다.
- Production Build, Tests Build, 로컬 집중 검증 1/1, MCP 전송 검증 2/2 PASS. MCP에서 Main 교체·원래 Attempt 재조회·취소 및 결과 인계를 확인했다. 실제 Writer 보호 아래의 Owner 정착과 3~5 Step 연속 실행은 아직 입증하지 못했다.

### 로컬 3-Step 수용 진입점

- 같은 Host에서 CAS 뒤 Report를 복구하면 기존 Attempt의 Canonical `next`를 이어서 소비한다. 새 Host에는 기존 Owner 예약을 넘기지 않는다.
- 마지막 Guarded Worker Report는 이미 통과한 Step의 stale Proof를 최종 통합 작업 트리에서 다시 실행한다. Canonical Report는 기존 검증과 최종화 경로로 저장한다.
- `npm run test:host-worker-acceptance`는 로컬 Host 진입점에 연결한다. 유한 App Server의 실제 종료, 실제 Manifest 실패와 같은 Step 재시도, 정착 3회, 중복 Report 0, 최종 Revision의 Evidence와 Kernel `done`을 확인한다.
- 현재 Windows에서는 제품 Proof 쓰기 경계가 없어 관통 검증이 시작되지 않는다. Docker 엔진이 실행 중이지만 제품 Proof 경계에는 연결되어 있지 않다. 관련 회귀 62 PASS / 2 POSIX 전용 SKIP은 별도 증거다.

### A2-3 로컬 중단 복구

- CAS 전 재연결은 기존 Worker의 Canonical Attempt·Git 후보를 다시 사용한다. 최초 검증과 복구에서 같은 Manifest 선택을 사용한다. 실제 Writer 배제와 기존 Owner Fence를 다시 요구한다.
- CAS 응답 유실은 저장된 변경과 동일한 패치 Digest·결과 작업 트리일 때만 이어서 정착한다. Git 적용 후 CAS 기록이 없으면 모호한 상태로 차단한다. Report 저장 후 응답 유실은 기존 Report를 재사용한다.
- `npm run test:host-worker-recovery`에 같은 로컬 Host 경로의 중단 시나리오 두 건을 연결했다. 보호된 Proof가 있는 Host에서 실제 Git·CAS·Report를 사용하도록 구성했다. Windows 결과는 보호 경계 미지원으로 구분한다.

### B 취소와 C 불변식 근거

- 로컬 App Server에서 같은 Turn의 완료 이벤트가 ACK보다 먼저 오면 큐에 있던 취소를 보내지 않는다. 이미 보낸 취소의 ACK가 유실되면 그 신호만 unknown으로 남고, 다음 Turn은 완료할 수 있다.
- MCP와 로컬 시작은 같은 Host의 Native 시작 조건을 확인한다. MCP의 수동 격리 불리언을 제거했다. B fixture는 로컬에서 시작한 동일 Host 세션에 MCP가 붙어 재연결과 취소를 검사한다.
- 기존 승인 요청 거부 경계는 유지한다. 인증된 사용자 승인 왕복과 이전 Writer 배제를 전제로 하는 Fresh Resume은 DEFER다.

| 불변식 | 로컬 관측과 수용 범위 |
| --- | --- |
| I01 | Host Worker가 미정착 상태이면 Kernel이 다음 Step과 Report를 차단한다. 상태 조회는 Run을 만들거나 진행시키지 않는다. |
| I02 | 실제 Git Worker 패치, Owner Index 및 untracked 파일 보존, 작업 트리 바인딩과 레거시 충돌을 검증했다. Native 교체 후 바인딩은 미관측이다. |
| I03 | 실제 detached Writer가 Turn과 App Server보다 오래 살아도 기존 Attempt와 예약을 보존했다. Native Writer 배제와 보호된 정착은 미수용이다. |
| I04 | 동시 시작은 같은 Attempt 한 건을 반환했다. disconnect로 상태가 unknown인 Worker는 재실행하지 않았다. 실제 정착 Report의 3-Step 연속 실행은 미수용이다. |
| I05 | Worker 결과나 연결 상태는 Kernel 완료 권한을 부여하지 않는다. stale Evidence와 누락된 Coverage는 완료를 차단한다. |
| I06 | Worker가 실행 중인 동안 Contract 교체를 거부했다. 후보의 원본 Attempt, 경로, Proof 바인딩을 검증했다. |
| I07 | App Server 이벤트는 원래 Turn에 귀속했다. 실제 Native 원본 transcript를 Main 교체 뒤 조회하는 경로는 미관측이다. |
| I08 | fixture가 시작 요청의 model/effort와 sandbox·approval 정책을 검사했다. 실제 Native 유효 구성은 미관측이다. |
| I09 | 두 MCP 스트림이 같은 Host Attempt를 조회했다. 다른 Host는 영속 Attempt만 조회했다. 연결 종료로 Kernel 완료 상태가 바뀌지 않았다. |
| I10 | 시작 전 큐잉, 동일 Turn 취소, 완료 선착, ACK 유실, 승인 우회 차단을 검증했다. 실제 사용자 승인 왕복은 DEFER다. |
| I11 | 상태에서 원본 패치와 명령 출력을 제외했다. Proof와 Context의 비밀정보 삭제 회귀를 검증했다. |
| I12 | 수명이나 원본을 확인할 수 없는 실행은 unknown으로 유지했다. Native transcript 완전성은 미관측이다. |

Native Writer 보호와 비교 Arm 수용은 미완료다. A/B/E/C/D 비교는 기존 지원 및 예산 조건에 따라 판정하며, 미지원 B/E/C/D는 NOT_RUN이다.

검증 결과는 B MCP/App Server 44 PASS / 2 POSIX 전용 SKIP, C 관련 Worktree·Trust·Redaction·Context 28 PASS다. 레거시 Worktree fixture는 기준 커밋에서도 같은 오류가 났다. 테스트 DB의 버전을 0으로 표시해 실제 마이그레이션을 실행하고, 단일 Run의 Lease 복구와 중복 Run의 차단을 확인했다. TypeScript, Production Build, Tests Build, Boundary도 통과했다.

### A2-2 복수 Manifest Proof

- 후보 검증이 Kernel Report와 같은 계획기를 사용한다. 해당 Step의 필수 Manifest 명령과 마지막 Step에서 필요한 이전 검증을 Owner CAS 전에 검사한다. 각 명령 뒤 staged blob과 작업 트리 내용을 다시 확인한다.
- 로컬 테스트에서 첫 명령은 통과하고 두 번째 명령은 실제 종료 코드 19로 실패했다. Owner 파일과 Revision은 그대로였고 Report는 생성되지 않았다. Kernel이 같은 Step의 수정 Attempt를 지정했다.
- TypeScript, Production Build, Tests Build, Boundary 및 집중 회귀 4건이 통과했다. 보호된 3-Step 테스트에도 복수 명령을 연결했다. Windows에서는 여전히 제품 Proof 경계가 없어 관통 테스트가 실행되지 않는다.

### A3-1 재요청과 Owner 적용 직전 검증

- 같은 로컬 Host의 재요청은 기존 실행이나 시작 중인 Promise를 반환한다. 중단된 정착만 Kernel에 재조회를 요청한다. 성공한 Step의 후속 지시는 저장된 Canonical Report에서 소비한다.
- Owner 적용 직전에 Run의 Contract·Plan·Mutation Revision과 Canonical Attempt를 재확인한다. Proof 도중 해당 기준이 바뀌면 적용을 차단한다.
- 보호된 A3 수용 테스트는 첫 Report를 저장한 직후 같은 Host와 다른 Host가 각각 재요청하도록 구성했다. 같은 Host는 기존 Attempt를 반환하고 다른 Host는 후속 Worker를 시작할 수 없어야 한다.
- TypeScript·Production Build·Tests Build·Boundary와 집중 회귀 5건 통과. Windows의 A3 관통 명령은 `PROOF_WRITE_CONTAINMENT_UNAVAILABLE`로 중단됐다. Mac 보조 확인도 Native 실행기 부재로 실행되지 않았다. 원래 로컬 Kernel Run은 `step-2-1`에서 active이며 Finalization은 pending이다.

### A2-3 Step 통과 뒤 Report 복구

- 로컬 Kernel이 보호된 Proof 체크포인트를 원래 Worker Attempt와 이미 적용한 Owner Mutation에 대조한다. 일치할 때만 Report 결과 저장을 재개한다. 기존 Step의 완료 시각을 유지하고 Proof와 Owner 패치 적용을 반복하지 않는다.
- 실제 프로세스 종료 후 복구하는 공통 Report 회귀에서 완료 시각, Proof 기록 수, Attempt 수가 유지됐다. Host-owned 관통 테스트에도 Step 통과 후 Report 저장 직전 중단과 로컬 재접속을 추가했다.
- TypeScript, Production Build, Tests Build, Boundary, Git diff 검사와 관련 회귀 46건이 통과했다. POSIX 전용 2건은 건너뛰었다. 로컬 Windows의 보호된 A2-3 테스트는 `PROOF_WRITE_CONTAINMENT_UNAVAILABLE`로 시험 전 단계에서 중단됐다. A2-3 관통 수용은 미완료다.

### C 로컬 제품 검증 명령과 I11

- `npm run test:host-worker-product-acceptance`를 실제 로컬 검증에 연결했다. 타입 검사, 제품 빌드, 테스트 빌드, 경계 검사, 관련 통합 테스트를 실행한다. [VERIFICATION.md](VERIFICATION.md#묶음-c-로컬-실행)에 I01~I12별 로컬 시험과 별도 제품 증거를 대응했다.
- 로컬 Windows, Node 24.18.0, 기준 HEAD e419fa09와 현재 작업 트리에서 기본 검사 4종이 통과했다. 전체 시험은 110건 중 104건 통과, POSIX 전용 2건 건너뜀, 실패 4건이었다. 보호된 Host 시험 3건은 `PROOF_WRITE_CONTAINMENT_UNAVAILABLE`로 중단됐다. 나머지 1건은 비밀 마스킹 문자열 형식을 고정한 테스트 오류였다.
- I11 테스트가 비밀값 삭제를 직접 검사하도록 수정했다. 테스트를 다시 빌드한 뒤 해당 시험 1건이 통과했다. 저장된 Worker 요약은 비밀값을 마스킹했고, 새 Main의 상태와 재접속 응답은 비밀값과 원본 패치 내용을 노출하지 않았다. 수정 후 전체 명령의 통과는 기록하지 않았다.
- C는 PARTIAL이다. Native 원본 transcript와 실제 적용 설정, 보호된 A2/A3 및 B/E/C/D 비교 증거가 남았다. 비교 상태는 NOT_RUN이다.

### B Main 재접속과 명령 이벤트 조회

- 같은 로컬 Host의 현재 Attempt에서 관측한 App Server 명령 이벤트 식별자를 상태와 재접속 응답에 제공한다. 최근 32건과 전체 관측 건수, 응답에서 생략한 건수를 표시한다. 원본 명령 출력은 제공하지 않고 식별자에서 비밀값을 마스킹한다.
- 실제 MCP 스트림 두 개에서 같은 이벤트와 Attempt를 확인했다. 다른 Turn의 이벤트는 제외됐고 교체된 Main이 같은 Turn만 취소했다. TypeScript, 제품·테스트 빌드, 경계 검사, 집중 3건, B 통합 44건이 통과했다. POSIX 전용 2건은 건너뛰었다.
- 이 조회 범위는 현재 Host 프로세스와 현재 Attempt다. Native 원본 transcript, Host 종료 후 이벤트 재조회, 실제 사용자 승인 왕복과 Fresh Resume은 미수용 범위다. 원래 로컬 Run은 active, Finalization은 pending이다.

### A3-1 기존 Run의 MCP 시작 재요청

- 새 계약 없이 Worker 시작을 요청하면 MCP는 기존 Kernel Run과 Worktree 바인딩을 확인한다. 로컬 Host가 기존 Attempt를 반환하거나 새 실행이 필요한 경우에만 Kernel 지시를 조회한다. 재요청 응답에는 별도 실행 지시가 없다. 기존 Attempt 조회는 가능하며 새 Writer에는 기존 보호 조건을 적용한다.
- Main 교체 시험에서 같은 Attempt를 반환했고 Run Revision, Mutation Revision 및 Attempt 수가 유지됐다. 다른 Run에 바인딩된 Main의 재요청은 거부됐다. TypeScript, 제품·테스트 빌드, 경계 검사, MCP 집중 회귀 4건이 통과했다.
- 보호된 관통 테스트에는 실제 Report 직후 MCP 시작 재요청도 추가했다. 로컬 Windows에서는 `PROOF_WRITE_CONTAINMENT_UNAVAILABLE`로 해당 구간까지 실행하지 못했다. 원래 로컬 Run은 active이며 Finalization은 pending이다.

### A3-1 계약을 포함한 Worker 요청

- 계약 등록과 Kernel 지시 조회를 분리했다. MCP에서 Worker 시작과 계약을 함께 요청하면 Kernel이 기존 규칙으로 Run을 등록하거나 재사용한다. 그 다음 로컬 Host가 기존 Attempt를 조회하거나 필요한 실행 지시를 받는다. 계약 등록 응답에는 실행 지시를 넣지 않는다.
- 최초 계약 등록과 동일 계약 재요청에서 같은 Run ID를 반환했다. 실행 중 계약 범위 변경을 거부했고 Run·Contract·Mutation Revision과 Attempt 수를 유지했다. 타입·제품 빌드·테스트 빌드·경계 검사와 관련 회귀 9건이 통과했다.
- 보호된 시험은 실제 Report 직후 동일 계약을 포함한 MCP 재요청을 검사한다. 로컬 Windows의 `PROOF_WRITE_CONTAINMENT_UNAVAILABLE`로 그 구간은 미관측이다. 원래 로컬 Kernel Run은 active이며 전체 수용은 미완료다.

### A3-1 로컬 Step 선점과 Revision 검사

- Host-owned Attempt 등록은 기존 SQLite Step 선점 트랜잭션을 사용한다. Run 상태와 Contract·Plan·Mutation Revision이 맞지 않으면 Step과 Attempt를 변경하지 않는다. 다른 Kernel 연결의 두 번째 선점도 거부한다. 별도 실행 상태 저장소는 추가하지 않았다.
- 같은 로컬 Host의 동시 요청, 오래된 실행 지시, 다른 연결의 선점 경쟁, MCP 재접속을 포함한 실제 회귀에서 상태 보존과 Attempt 1개를 확인했다. Worktree 바인딩·Fence·중단 복구·Report replay를 함께 실행한 결과는 53건 중 50 PASS, 3 FAIL이다. 실패 3건은 보호된 Host 관통 시험이며 모두 `PROOF_WRITE_CONTAINMENT_UNAVAILABLE`로 실행 전 차단됐다. 이를 통과나 건너뜀으로 바꾸지 않았다.
- 로컬 우선 완료 기준을 PLAN에 명시했다. MCP 없이 로컬 Host에서 필수 기능을 수용하고, MCP는 같은 제품 경로의 전송 회귀로 별도 판정한다. 원래 Run은 active, Finalization은 pending이며 A2-2·A2-3·A3-2의 관통 수용은 미완료다.
- 별도 집중 회귀 7건도 종료 코드 0으로 통과했다. 실제 후보 Proof 실패 후 같은 Step 수정 지시, Canonical Attempt 인계 및 Provider 실패 경계를 포함한다.

### 잔여 수용 차단과 재개 조건

- A2-1과 A3-1의 확인된 회귀는 보존한다. A2-2의 보호된 Owner 정착, A2-3의 Host-owned 관통 복구, A3-2의 3~5-Step 최종 완료는 현재 로컬 환경에서 입증되지 않았다. B의 인증된 승인 왕복·Fresh Resume과 C의 미지원 비교 Arm도 미수용 상태를 유지한다.
- 동일 로컬 Proof 보호 기능 부재는 앞선 여러 실행과 이번 53건 회귀에서 반복됐다. 현재 구현의 `confineTrustedProofWrites`는 macOS Seatbelt만 제공한다. Windows에서 이를 일반 spawn으로 바꾸거나 성공 불리언을 주입하지 않는다. 새 OS 보안 플랫폼은 원래 개발 범위에 포함하지 않는다.
- 대화 목표의 실행 상태는 외부 능력 차단으로 BLOCKED다. 이는 제품 완료가 아니다. 원래 로컬 Kernel Run은 active/Finalization pending 상태를 유지하며 성공 Report를 제출하지 않는다. 재개에는 현재 로컬 Host에 제품이 신뢰할 수 있는 Proof 쓰기 보호와 실제 Writer 배제 근거가 필요하다. 원격·MCP 성공은 이 로컬 수용을 대신하지 않는다.

### 후속 요청 — 로컬 제품 기능 연결

사용자가 이전 목표를 해제하고 로컬 기능 1~5의 개발을 새 목표로 지정했다. 성능 비교·반복 검증은 새 기능 개발 범위에서 제외한다. 위의 전체 A2/A3 Run과 그 미수용 증거는 보존한다.

- 로컬 `worker-host` 제품 진입점과 Native Host용 `createLocalWorkerControl`을 추가했다. MCP 없이 시작·조회·재접속·중단 처리 재개·정확한 Turn 취소를 기존 Host 세션으로 처리한다. 다른 Main도 동일한 Host 세션을 공유하며, 다른 Run 바인딩은 거부한다.
- 결과 반영과 후속 Step은 기존 `HostWorkerSessions.startLocal` 경로를 사용한다. Report 저장 후 Host 응답만 유실되면 Canonical Report의 `next`를 복구한다. 후속 시작 실패도 같은 지시로 재시도하며 별도 `next`를 요청하지 않는다. 새로운 정착 엔진·작업 저장소·데몬은 만들지 않았다.
- 기본 제품 구성의 실제 Writer 배제 구현은 여전히 없다. 이 구성은 미지원 사유를 반환하며 자동 Owner 적용을 활성화하지 않는다. Windows Proof 보호도 미지원이다. 로컬 전경 CLI의 표준 입출력은 한 연결이며, Main 교체는 Native Host에서 같은 세션을 공유하는 새 연결에 적용한다. Host 종료 후 실행 핸들 복원과 소켓 서비스는 추가하지 않았다.
- 사용 방법과 기능별 경계는 [LOCAL_WORKER_CONTROL.md](LOCAL_WORKER_CONTROL.md)에 기록했다. 로컬 제어와 CLI 도움말 집중 시험 4건이 통과했다. 보호된 Owner 반영과 후속 Step의 관통 수용으로 확대하지 않는다.
- 최종 변경의 TypeScript·제품 빌드·테스트 빌드·경계 검사·diff 검사와 로컬/MCP 집중 회귀 6건이 통과했다. 실제 `worker-host` CLI도 실행해 현재 Host의 `unsupported / host_worker_native_isolation_unverified` 응답을 확인했다. 보호된 관통 시험은 같은 환경 차단을 재확인하기 위해 반복 실행하지 않았다. 이번 결과는 새 요청의 로컬 제어 연결 개발과 현재 미지원 경계에 한정한다. 이전 전체 Kernel 수용을 완료로 바꾸지 않는다.

### 사용자 승인 범위 변경과 Kernel·Git 종료

사용자의 후속 로컬 기능 개발 요청과 완료·커밋·푸시 요청을 반영해 원래 Run의 Contract Revision 4, step-4-1로 종료 범위를 변경했다. 이전 전체 A2/A3 미수용 기록은 보존한다. 같은 Run의 최초 objective는 이력이며 최신 acceptance·constraints·nonGoals가 변경 범위를 정의한다.

로컬 제어·후보 인계·공통 정착/복구·Step 선점·Main 교체/취소·MCP 전송·Evidence/Scope/Redaction 회귀를 test:host-worker-code-closeout으로 묶었다. 제품 관통 명령의 실패를 성공으로 바꾸지 않는다. Kernel이 현재 소스의 명령을 실행하고 모든 변경 범위 acceptance를 충족한 Canonical Report.next만 완료 권위로 사용한다. Git 결과는 같은 Run의 governed kernel-commit receipt와 해당 브랜치의 실제 커밋·원격 이력에서 확인한다.

계약 축소 뒤 Manifest 명령이 바뀌면 폐기된 검증 항목까지 required로 되살아나는 공통 결함을 발견했다. 바인딩 갱신 대상을 현재 계약의 비폐기 항목으로 제한했다. 계약 축소→카탈로그 변경→next→report 회귀를 종료 검증에 포함한다. Revision 3의 최초 Report는 AC-7의 이전 항목 때문에 실행 전 거부됐으며 통과 기록이 아니다. 수정 후 Revision 4로 같은 Run을 재개한다.
