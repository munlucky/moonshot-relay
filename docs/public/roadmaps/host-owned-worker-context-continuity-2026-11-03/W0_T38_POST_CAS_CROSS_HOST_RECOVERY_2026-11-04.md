# W0 T38 — CAS 직후 Host 중단과 Canonical Report 복구 경계 검증

- 날짜: 2026-11-04
- 기준 소스: `main / 45334b32f072ea3bfa2b51aa37811cb2a54b959c`
- 새 회귀: `tests/kernel-parallel-post-cas-host-restart.test.ts`
- 범위: 실제 별도 OS Host 프로세스, 실제 Canonical SQLite Run·Step·Attempt, 실제 Git integration·Trusted Proof·Owner CAS·Worker Report. **제품 Dispatcher/Kernel 기본 경로 변경 없음.**
- 판정: 정상 경로와 CAS 후 Host 종료 경로를 구분. **중단 복구는 자동 정착하지 않고 차단하는 것이 현재 올바른 결과이다.** G0 `PARTIAL`, W1 `DEFER`.

## 현행 경계와 목표

T30은 정상 Canonical Report/Proof 정착을 검증했고, T34는 통합 Proof의 종료 불명 후손이 Owner Fence 만료 이후에도 파일을 쓸 수 있음을 실증했다. T35의 macOS `writeScope`, T36의 복구별 물리 Worktree, T37의 최초 cherry-pick~Owner CAS~Report 정착 시도까지 Fence 수명을 각각 검증했다. T38은 두 가지 서로 다른 결과를 분리한다.

1. **정상 완료**: 별도 실행 Host가 두 Worker 결과 Commit을 통합하고 실제 명령으로 검증한 뒤 Owner CAS를 정확히 한 번 기록하고 Canonical Report 둘을 승인해야 한다. 이후 별도 Host는 이미 정착된 Step을 다시 실행·변경하지 않아야 한다.
2. **CAS 후 실행 Host 비정상 종료**: 실제 Host 프로세스를 Owner CAS `0 → 1` 직후, 첫 Canonical `settleParallelResult()` 진입 시 의도적으로 종료한다. 기존 Control Plane은 이미 원자적으로 Owner 변경을 기록했지만 두 Worker Attempt/Step은 여전히 정착 전 상태다. 새 Host는 동일 Canonical Run·Attempt·Provenance를 읽고 `recoverPendingDeliveryMaterialization()`에서 **blocked / delivery_materialization_recovery_required**로 처리해야 한다. 이는 중복 실행이나 임의 자동 정착을 금지하는 안전한 거부이다.

## 시험 방법

- Host A는 `node --input-type=module -e`로 실제 별도 OS 프로세스에서 기존 `dispatchKernelParallel()`을 실행한다. 두 **테스트 전용 동기식 가짜 Worker**는 실제 격리 Git Step Worktree에 서로 다른 소스 파일을 쓰고 완료한다. 각 호출은 시험 소유 디렉터리에 시작 마커를 1회만 기록한다. 이것은 Codex/Native Writer가 아니며 Native Writer의 물리 종료 증거로 사용하지 않는다.
- Host A의 정상 분기는 실제 `executeTrustedProof('test:ok')`를 사용한다. macOS에서는 `writeScope=integrationWorkspace`를 명시해 T35의 OS 강제 경계를 사용하고, Linux는 OS 격리를 주장하지 않고 Trusted Proof와 Kernel 호출 순서만 검증한다.
- CAS 후 중단 분기는 시험에서만 `settleParallelResult()` 경계에 `process.exit(73)`을 삽입한다. 먼저 실제 Run의 Mutation Revision `1`을 관측한 뒤 종료하므로 **CAS 이후·첫 Worker Report 이전** 중단이 보장된다. 실제 제품 코드에 crash 후킹이나 폴백을 넣지 않는다.
- Host B는 **새 Node 프로세스/새 Control Plane**으로 동일 Run, Step, 두 Attempt, `mutation_provenance` 및 다음 실행 가능 Step을 재조회한다. `recoverPendingDeliveryMaterialization()`의 결과를 검증한다. Host C도 **세 번째 새 프로세스**로 동일 상태를 다시 읽어 중복 실행이 없음을 확인한다.
- 두 경로 모두 Owner Revision은 정확히 `1`, Canonical Attempt는 Step당 1개, 실제 Owner 파일은 한 번만 변경돼야 한다. 중단 경로의 두 Attempt는 `started`이며 Run은 blocked이다. 정상 경로의 두 Attempt는 `passed`이며 Report가 2건 정착한다. 각 테스트의 Worker 시작 마커 개수는 각각 정확히 1개여야 한다.
- 세 Host가 종료되고 시험 Worker가 처음부터 동기 호출로만 종료되었음을 아는 시험 전용 환경에서만 Worktree를 정리한다. 운영 Host/Codex Worker의 미확인 후손이나 예약을 건드리지 않는다.

## 검증 기록

| 구분 | 결과 |
| --- | --- |
| Linux TypeScript·제품·테스트 빌드 | PASS |
| Linux 실제 독립 Host A/B/C 정상·CAS 중단 집중 | **2 PASS / 0 FAIL / 0 SKIP** (`operationId=169c294c-94bc-4e9b-9b15-6bb4645cdece`) |
| Linux 확대 Dispatcher/Recovery/Fence/Proof 회귀·경계 검사 | **38 PASS / 2 OS SKIP / 0 FAIL**, 경계 검사 **9 modules / 312 files / 850 edges PASS** (`operationId=145d63b1-2016-4a3c-b86f-7cadb2d6cce0`) |
| macOS 실제 Seatbelt Scoped Proof + Cross-Host | 추후 결과 반영 |
| 실제 Native Writer 물리 종료 증명·자동 Canonical 회수 | 미검증 — **DEFER** |

## 설계 판단과 후속 작업

현재 `recoverPendingDeliveryMaterialization()`은 실제 Owner mutation provenance와 재조합 가능한 Worker Attempt를 확보했더라도, 해당 Step이 정착 전이면 Run을 block한다. 이는 CAS 이후 불확실한 실행을 **새 Writer 실행이나 두 번째 Owner CAS로 복구하지 않는** 기존 안전 경계다. 이 차단을 삭제하거나 탐지 조건을 우회하여 보고서 승인으로 직행하는 변경은 하지 않는다.

자동 Canonical 회수로 발전시키려면 실제 Native Attempt의 물리 종료(`writerExitVerified`) 및 모든 후손 수명이 증명되고, 선택형 OS Scoped Proof/복구별 신규 Worktree/첫 쓰기 전부터 Report 정착까지 동일 Owner Fence의 제품 경로가 검증돼야 한다. 정착 중 Host 종료, CAS 후 다른 Host의 합류, Proof 만료 및 두 Host 동시 경쟁 반례가 모두 충족되기 전까지 기존 `blocked` 응답을 정상 결과로 유지한다. 별도 DB·Queue·Scheduler·Provider별 폴백·Delivery 전용 마커를 추가하지 않는다.

**전체 판정: G0 PARTIAL / W1 DEFER.**
