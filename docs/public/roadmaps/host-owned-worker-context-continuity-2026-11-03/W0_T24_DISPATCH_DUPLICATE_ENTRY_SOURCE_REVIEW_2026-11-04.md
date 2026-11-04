# W0 T24 — Goals·Dispatcher 중복 진입 소스 조사 (2026-11-04)

## 판정

**SOURCE RISK IDENTIFIED / NATIVE DUPLICATE NOT REPRODUCED / G0 PARTIAL / W1 DEFER.** T31 완료 커밋 `b815fb7124310bd2a24ce948dccb7625e367be0f`를 읽기 기준선으로 사용했다. 이 문서는 새 제품 안전성의 PASS를 선언하지 않는다.

## 관측한 호출 경계

1. `src/host/kernel/turn-dispatcher.ts`는 명시적 `MOON_RELAY_KERNEL_PARALLEL_MODE=on`에서 `dispatchKernelRun()`으로 진입한다. 일반 `dispatchKernelTurn()`은 이 경로 외에 owner-direct 및 native-subagent 경로도 제공한다.
2. `src/host/kernel/parallel-dispatcher.ts`는 `getExecutableSteps()` → `getRun()` → `prepareExecutionWorkspaces()` → 각 `dispatchKernelStep()`의 `Promise.allSettled()` 순으로 진행한다. Worker 실행은 Owner Delivery Fence보다 앞선다.
3. `dispatchKernelStep()`은 `bindStepAttempt()` 후 provider dispatch를 수행한다. `src/kernel/run/work-cursor.ts`의 `bindStepAttempt()`는 Step을 running으로 갱신하고 `recordStepAttempt()`를 호출한다. 읽은 함수 자체에는 중복 호출을 동일 Attempt로 합치는 분기가 없다. 실제 State Store의 중복 방어와 교차 프로세스 동작은 별도 검증 대상이다.
4. `acquireOwnerWorkspaceMutationFence()`는 결과 통합 후 `materializeDelivery()`에서 호출된다. 따라서 Owner CAS가 성공적으로 보호하는 것은 **Owner 반영**이며 **Worker 중복 시작 자체**가 아니다.
5. `src/host/kernel/lifecycle-bridge.ts`의 `inFlightReviews` Map은 리뷰에 한정된 동일 프로세스 내 합류다. 일반 implement/parallel의 다른 프로세스 중복 실행 보호를 증명하지 않는다.
6. `src/host/kernel/workspace/physical-worktree.ts`는 Run/Step 경로를 재사용할 수 있다. 반면 T25~T31의 Host 외부 단발성 Writer 예약 및 Attempt별 물리 Worktree는 선택형 Native 경로다. 기본 Parallel Dispatcher에 자동 적용됐다고 볼 수 없다.

## 확인하지 못한 사항

- Codex App의 실제 Goals가 Moonshot Relay의 Dispatcher를 자동 호출하는지. 현 저장소의 `src/host`·`src/cli` 검색에서는 자동 Goals 소비자를 발견하지 못했다. 앱 외부 기능이 없다는 뜻은 아니다.
- 같은 Canonical Run/Step에 독립 Host 2개가 동시에 들어왔을 때 실제 native launcher가 2회 호출되는지.
- State Store가 같은 Step의 경쟁 `bindStepAttempt()`를 원자적으로 막는지, 거부된 진입이 기존 Attempt와 예약을 변경하지 않는지.
- 다른 Main/MCP 진입에서 Run을 공유할 때 하나의 논리 작업만 실제 Worker를 시작하는지.

## 다음 재현 실험 — 제품 수정 전에

1. 임시 Repository·Runtime Home에 실제 Control Plane Run과 병렬 Step 2개를 생성하고, **각기 다른 Host 프로세스**가 같은 Run으로 동시 진입하도록 barrier를 둔다. 기존 사용자 세션/Runtime은 건드리지 않는다.
2. Provider 호출은 계수 가능한 stub으로 먼저 대체하고 `bindStepAttempt()` 및 OS 실행 시작 횟수, Canonical Attempt/Workspace/Reservation을 관측한다. 이어 실제 Mac Native에서 제한된 동일 경쟁을 시험한다.
3. 통합 Proof 실패·Owner CAS 경쟁·Host `SIGKILL`을 분리한다. 부정 사례는 Owner Mutation Revision 불변, 후속 Writer 중복 생성 0, 실행 중 A Workspace 보존을 확인한다.
4. 재현될 경우 **기존 Canonical Attempt와 Host 외부 예약을 통해 pre-spawn admission을 한 곳으로 모으는 최소 수정**만 고려한다. 단순 in-memory Map, 새 DB/Queue/Scheduler, 임의 자동 재시작, Provider별 폴백은 도입하지 않는다.
5. 회귀 실험의 실제 PASS가 확보되기 전에는 G0를 PASS로 승격하거나 W1 기본 Dispatcher 전환을 허용하지 않는다.

## 이번 변경 범위

읽기 전용 코드 추적과 본 조사 문서만 작성했다. 제품 코드·테스트·Runtime·DB 스키마는 변경하지 않았다. 따라서 이번 결과는 **원인 후보와 재현 조건 확정**이며 **결함 수정·Native 검증 완료**가 아니다.
