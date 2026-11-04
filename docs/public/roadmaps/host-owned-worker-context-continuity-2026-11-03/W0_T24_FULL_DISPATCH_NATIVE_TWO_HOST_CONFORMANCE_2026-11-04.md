# W0 T24 — 전체 병렬 Dispatcher의 독립 Host 경쟁 및 Mac Native 검증 (2026-11-04)

## 최종 판정

**T24의 동일 Run/Step 교차 Host 중복 시작 방지 — Linux 전체 Dispatcher PASS / Mac Native Codex `command/exec` PASS.**

**G0 `PARTIAL`, W1 `DEFER` 유지.** 이번 검증은 실제 Codex App Server의 유한한 OS 명령 실행까지 포함한다. 그러나 앱 Goals의 자동 실행 진입, 실제 모델 Turn의 중복, 연결 상실 RPC 핸들 재연결, 살아 있는 임의 OS 후손 종료, 모든 기본 Writer 진입점의 의무 격리를 증명하지 않는다.

이 보고서는 [T24 원자적 Step 선점 수정](W0_T24_CROSS_HOST_ATOMIC_STEP_ADMISSION_2026-11-04.md)에 대한 후속 검증이다. 이전 결과를 다시 구현하지 않았다. 새 제품 코드, DB 스키마, Queue, Scheduler, Provider별 폴백은 추가하지 않았다.

## 범위와 재현 조건

추가된 `tests/kernel-parallel-full-dispatch-two-hosts.test.ts`는 임시 Git 저장소·Kernel Runtime SQLite·물리 Step Worktree를 생성한다. 별도 OS Host 프로세스 A와 B가 **동일 Run의 같은 두 Step을 조회한 뒤** 파일 barrier에서 기다리도록 했다. 작업용 Worktree는 barrier 이전에 생성해 Git Worktree 추가 경쟁과 Step 선점 경쟁을 구별했다. barrier 해제 후 두 Host가 실제 `dispatchKernelParallel()` 전체 경로로 진입했다.

실행에 성공한 각 Provider는 테스트 소유 Step에서 대기한다. Provider를 해제하기 전에 부모 프로세스가 다음을 독립적으로 읽어 검증했다.

- Step별 Provider 진입 **1회**, Canonical Attempt **1건**, 상태 `started` 및 Step 상태 `running`.
- 경쟁에서 선점에 실패한 Host가 승자의 Attempt를 `failStepAttempt()`로 실패 처리하지 않음.
- 두 Host의 명시적 전체 병렬 Dispatcher 실행. Sequential fallback 없음.
- Owner Mutation Revision `0` 유지. 이후 의도적으로 실패 결과를 반환하며 통합 Proof 및 Owner Delivery는 실행하지 않음.

Mac 선택형 `T24_NATIVE_FULL_DISPATCH=1`에서는 **승자가 실제 Codex App Server `command/exec`를 수행**한다. 각 호출은 기존 `runNativeHostCommand()`와 외부 단발성 Writer 예약을 사용한다. Native 호출이 정상 종료하면 테스트 기록을 남긴다. 최종 검증은 Step별 Native 성공 기록 1건, 물리 Workspace별 외부 Writer 예약 1건, App Server PID 2건의 관측 및 종료를 확인한다. 종료 증명을 하지 못하면 해당 테스트의 Workspace·예약을 자동 삭제하지 않는다.

이 시험은 단발성 Node 명령을 사용하는 **실제 Native Host/OS 실행**이며, 모델 Turn 실행을 대신 증명하지는 않는다. OS PID를 모르는 장기 Writer나 운영 Codex 세션을 종료하지 않는다.

## 결과

| 검증 항목 | 관측 결과 |
| --- | --- |
| Linux 두 독립 Host / 전체 `dispatchKernelParallel()` | 1 PASS / 0 FAIL |
| Linux 관련 회귀 6개 suite | 31 PASS / 0 FAIL / 0 SKIP |
| 동일 경쟁 테스트의 별도 프로세스 5회 반복 | 5회 모두 PASS |
| Linux TypeScript, 제품·테스트 빌드 | PASS |
| `check:boundaries` | PASS — 9 modules / 311 files / 849 edges |
| Mac 실제 Native Codex App Server `command/exec` 경쟁 | **1 PASS / 0 FAIL / 0 SKIP** |
| Mac Native 성공 기록 / 외부 Writer 예약 | 각각 2건, Step·Workspace별 1건 |
| Mac Native App Server 프로세스 | 관측한 두 PID의 종료 확인 |
| Mac Owner Mutation Revision | `0` 유지, Owner Delivery 없음 |
| Mac 원본 checkout / 운영 세션 | 원본 Git clean, 원본 Codex 세션·Runtime 미수정 |
| Mac 임시 소스 복제본·테스트 CODEX_HOME | 검증 후 안전하게 삭제 |

Linux 재현과 회귀: Moonremote operation `6d23c3b0-b9a3-4e1f-acbc-514fa3cc7ab0`, `fbb3380e-c4b1-4785-945c-bc39b606d329`, `a3ebf099-aa13-4c5e-9c30-f8f6d7f21570`.

Mac: 소스/빌드 operation `0a64273d-5186-48d3-b99f-b4c94b0d4952`, 실제 Native 시험 `7a055cd1-11da-4116-a79b-08f0f1facb71`, 표준 출력 재확인 `5c650b7c-fd4b-43d6-857d-b6ba71b2d2c6`, 상태·원본 checkout 확인 `56d51f74-6d92-4294-914e-c7078ebd3c32`, 안전 정리 `68f69242-7b75-4a5b-821f-f608e46b200e`. Mac Node test reporter는 `pass 1 / fail 0`, Native 실행 1건 PASS였다.

## 시험용 Shell 판정 오류 분리

Mac Native 시험의 Node 테스트는 PASS였다. 다만 별도 검증 셸은 두 가지 **시험 운영상 오류**로 종료 코드 1을 보고했다.

1. Node 24의 기본 reporter가 `ℹ pass 1`을 출력했지만, 셸이 TAP 전용 `# pass 1`을 검사했다.
2. 임시 복제본에서 빌드가 생성한 산출물 8개를 `git status --porcelain` 검사가 소스 수정으로 판단했다. 실제 Mac 원본 checkout은 clean이었다.

따라서 제품 결함으로 분류하지 않았다. 별도 출력 조회와 시험의 자체 `PASS` 상태, Step별 Native 호출·PID/예약 assert, 원본 checkout clean을 확인했다. 재검증 셸에 Node 버전별 폴백을 추가하지 않았다. 향후에는 **테스트 프로세스 결과와 assertions**를 주된 판정 근거로 사용하고, 임시 빌드 산출물과 원본 저장소 상태를 구분한다.

## 남은 게이트

1. **Goals 실제 중복 진입:** 앱이 Host/Kernel과 같은 논리 작업을 동시에 개시하는지 실제 사용 경로로 증명해야 한다. 이 시험은 동일한 기존 Run을 두 Host가 호출하는 경우만 검증한다.
2. **연결 상실 후 재연결:** T31은 알 수 없는 Native 명령을 재실행하지 않는다는 증거다. 원래 RPC/Tool 핸들의 재획득과 결과 회수는 미증명이다.
3. **임의 OS Writer 안전 폐기:** 비정상 후손의 물리 종료 및 모든 Writable 진입점의 Host 외부 예약·sandbox 강제는 별도 검증이다. 단지 SQLite Step이 `failed`이거나 Lease가 만료된 것으로 기존 OS Writer 종료를 선언해서는 안 된다.
4. **정상 Owner Delivery 경쟁:** 이번 시험은 양쪽 부정 Worker 결과에서 Owner CAS를 0으로 유지했다. 기존 T30의 단일 Host Native 정상 Proof/CAS/Report PASS는 보존되지만, *서로 경쟁하는 두 Host가 모두 정상 Worker 결과를 반환하는 Owner 통합 경합*은 추가 시험이 필요하다.
5. Windows·Linux Native Sandbox 등 다른 OS의 실제 안전성은 이번 Mac 판정에 포함하지 않는다.

**따라서 T24 전체 Dispatcher + Mac Native의 '동일 Step 중복 시작 방지' 반례는 통과로 정착하되, G0 `PARTIAL`, W1 `DEFER`를 유지한다.**
