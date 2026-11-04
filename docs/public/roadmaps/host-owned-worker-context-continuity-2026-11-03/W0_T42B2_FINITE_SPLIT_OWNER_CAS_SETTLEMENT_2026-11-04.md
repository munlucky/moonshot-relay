# W0 T42-B2-A — 종료가 확인된 두 Host 결과의 Owner CAS·Report 정착 실증

- 작성일: 2026-11-04
- 기준선: main / 8dc4204eac8bce0e7e8ba9ba260b2708be821ece
- 범위: 제품 코드 변경 없음. 기존 tests/kernel-parallel-positive-two-hosts.test.ts에 기존 Kernel Control Plane API의 검증만 추가한다.
- 총괄: **B2-A는 종료를 확인할 수 있는 동기식 Worker의 증거만 사용**. 이전 Native Writer 후손 전체 종료와 자동 Owner Delivery 권한은 미확인. **G0 PARTIAL / W1 DEFER**.

## 왜 별도 제품 실행 API를 추가하지 않는가

T42-A는 다른 Host의 Canonical Attempt·Git Commit·Patch Digest·Workspace Identity와 실제 Git 상태를 대조한다. T42-B1은 macOS 기존 Owner Fence와 새로운 Integration Worktree에 OS 제한 Proof를 적용하지만 Owner CAS·Canonical Report 정착은 금지한다.

두 선행 단계만으로는 **과거 Native Writer와 모든 후손이 앞으로 원본 Result Worktree를 변경할 수 없다는 물리 증거**가 없다. 임의의 ready 또는 verified 결과를 Delivery 승인으로 승격하는 옵션을 만들면 이 신뢰 경계를 우회한다. 따라서 제품 자동 합류 이전에 **실제 종료된 동기식 시험 Worker**를 사용해 기존 Kernel의 CAS·Report 계약을 확인한다.

## 검증 계약

1. T24의 독립 Host A/B가 같은 Run의 Step 하나씩을 claim하고 각각 동기식 파일 쓰기 Worker를 완료한 뒤 **호스트 프로세스가 종료**된다. 시험은 두 Host의 실제 종료를 확인한다. 분리된 Native App Server/후손은 이 Fixture에서 시작하지 않는다.
2. 새 Control Plane에서 Canonical Result 2건을 재조회한다. readback 자체의 writerExitVerified:false / deliveryAuthorized:false는 유지한다.
3. Run Revision·Identity·Owner HEAD로 기존 Owner Fence를 **첫 cherry-pick 이전**에 획득하고 Canonical Result의 전후 값이 같음을 검증한다. T36의 새 물리 Integration Worktree에서 두 Result Commit을 cherry-pick --no-commit으로 조합한다.
4. 전체 staged path와 Patch를 검증하고 Trusted Proof 후에도 Patch 바이트가 변하지 않아야 한다. macOS에서는 실제 Seatbelt OS 쓰기 범위가 새 Integration Worktree로 제한돼야 한다.
5. 이 시험의 **종료된 동기식 Writer에 한해서만** 기존 git apply --check, Fence 갱신, assertOwnerWorkspaceMutationReady, git apply, recordOwnerWorkspaceMutation을 시험 내부에서 직접 호출한다. Owner Mutation Revision은 0 → 1 한 번만 증가해야 한다.
6. 같은 Fence Token을 post-commit 단계에서 갱신해 기존 settleParallelResult에 과거 Canonical Report를 각각 전달한다. 두 Step이 passed이고 Run completed여야 한다.
7. 완료된 Run의 이전 결과 재소비를 거부하고, **이미 정착한 Attempt의 settleParallelResult를 재호출해 두 번째 passed 정착을 거부**한다. Step Attempt 2개 유지, 최종 Owner 파일과 Mutation Provenance 경로 일치, Owner Lock 해제를 확인한다.

기존 T24 회귀는 두 복구 Host의 실제 OS 프로세스 Fence 경쟁(1 승리·1 거부), 더 큰 새 Epoch, stale Token 갱신 거부를 검증한다. 기존 T38은 CAS 직후 Host 종료와 blocked Recovery를 검증한다. **이번 단계에서 그 분리된 두 증거를 과거 Native 결과의 자동 정착 증명이라고 주장하지 않는다.**

## 검증 상태

| 범위 | 결과 |
| --- | --- |
| Linux strict TypeScript·제품·테스트 빌드 | **PASS** (operationId=a5d51e5c-b208-4337-b62a-0238936daed5) |
| Linux 실제 두 Host 집중 회귀 | **3 PASS / 0 FAIL** |
| Linux 확대 Dispatcher·Fence·CAS Crash·Report·Proof, 경계 검사 | **37 PASS / 5 OS SKIP / 0 FAIL**. 모듈 경계 **9 modules / 313 files / 855 edges PASS** (operationId=e8dbb6ac-146c-48f2-8609-871a83fc50a3, b84bbde8-a183-47b2-b65c-3d4e256357f1) |
| 실제 Mac 동기식 두 Host 기존 결과 정착·OS 제한 Proof | 검증 후 기록 |
| 임의 Native Writer/후손 OS 종료 및 과거 결과 자동 Delivery | **미검증·비활성화** |

## B2 후속 조건

- 기존 두 Host의 CAS 직후 실제 복구 Host 종료와 다시 시작한 Host의 차단, 중복 CAS·Report 금지.
- Fence TTL 만료 및 stale Epoch가 첫 Owner 쓰기/Report 전후에 발생하는 반례.
- 실제 Native Writer와 모든 후손의 물리적 쓰기 종료 또는 지속적인 권한 차단을 결과 소비 시점까지 증명할 수 있는 OS 경계.
- 위 경계가 확보되기 전에는 제품 Dispatcher 기본 동작과 Native 예약·Worktree 보존, writerExitVerified:false 및 deliveryAuthorized:false를 유지한다.

새 DB·Queue·Scheduler·Provider별 폴백이나 Writer 감시 서비스를 추가하지 않는다.
