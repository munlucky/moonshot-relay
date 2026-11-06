# Host-owned Worker / Context Continuity 진행 현황

- **유일한 구현 기준:** [PLAN.md](PLAN.md). 필수 검증은 [VERIFICATION.md](VERIFICATION.md). 후속 실험·실행계획은 원래 W0~W6 및 G0~G6의 범위·선행 관계를 바꾸지 않는다.
- **현재 제품 판정 (2026-11-05): PARTIAL.** W0 ContextReceipt 수정은 SOURCE PASS, W1·W2 Host Worker 제어는 CODE/WIRED PARTIAL, W3·W4·W6 제품 수용은 미완료. 테스트 통과를 사용자 기능 완료로 간주하지 않는다.
- **소스 기준:** `main`의 현재 HEAD와 `origin/main`은 Git에서 확인한다. 보안 수정·Fixture PASS를 Native 제품 전체 수용 PASS로 취급하지 않는다.
- **Native 안전 계약:** OS Writer의 물리적 종료·쓰기 배제가 입증되지 않아 기본 Native Writable Worker 자동 시작, 불명확한 Attempt 재실행, 자동 Owner 결과 합류, 충돌하는 Fresh Resume은 계속 **HOLD_SAFE**. 이 차단을 독립적인 조회·기존 Kernel 실행 루프 개발 전체로 전파하지 않는다.

## 최초 계획 대비 실제 구현·검증 상태

| Wave / Gate | CODE / WIRED | TESTED / ACCEPTED | 다음 실제 구현 또는 제한 |
| --- | --- | --- | --- |
| W0 / G0 | ContextReceipt 무음 절단 방지 **구현됨** | 필수 계약 집중 테스트 SOURCE PASS, Native Capability **PARTIAL** | [W0_RESULT](W0_RESULT.md)에서 증거 재사용. OS 격리 추가 반례 연구는 진행 조건이 바뀌지 않는 한 반복하지 않음 |
| W1 / G1 | Host-owned App Server/Attempt, Worktree 예약, 비동기 Turn·중단, 기존 MCP의 명시적 start **부분 연결** | 격리 Fixture PASS, 일반 제품 Native start **HOLD_SAFE**, 실제 Main 종료 후 Native Worker 생존 미수용 | 안전한 실행 수명 경계를 실제 제품 Dispatcher와 연결하고 Writer 격리 필요 기능만 차단 |
| W2 / G2 | `kernel_status` Canonical Attempt 조회 및 같은 Host live Turn 조회, `kernel_attach` 중단 **부분 연결** | 다른 Main 호출·독립 Host 인스턴스 조회/거부 Fixture PASS. 실제 Main 교체, 승인·취소 전체 경계 미수용 | 기존 호출 경계에서 재연결·승인·취소의 적용 시점 구현 |
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

## 재개 지점

다음 작업은 [원본 PLAN.md의 2026-11-06 잔여 구현 우선순위](PLAN.md#2026-11-06-잔여-구현-우선순위--원본-w0w6g0g6-실행-구체화) 중 **실행 단위 1 → 2 → 3**이다. 지원되는 Host 실행 경계를 먼저 확정하고 W3의 기존 `kernel next → execute → report.next` 3-Step·실패 수정까지 실제 제품 경로로 완성한다. 이후 W2 Main 재연결 → W4-E → W5 → W6. Writer 미증명 Native 자동 정착만 HOLD_SAFE하고 별도 OS 격리 연구·중복 마스터플랜을 추가하지 않는다.
