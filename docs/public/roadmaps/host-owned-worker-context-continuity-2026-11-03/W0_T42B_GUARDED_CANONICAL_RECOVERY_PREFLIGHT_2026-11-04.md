# W0 T42-B1 — 독립 Host의 Canonical Result를 보호된 통합 Worktree에서 사전 검증

- 기준선: `main / cabc0eb95555cc1439ccccd524798ae7465cbce1`
- 구현: `src/host/kernel/parallel-dispatcher.ts`의 명시적 `verifyCanonicalParallelRecoveryCandidate()`와 기존 T24 두 Host 회귀 확장
- 구분: **B1은 `Proof`까지만 검증한다. B2의 실제 Owner CAS·Canonical Report 정확히 한 번 정착은 미구현.**
- 전체 판정: **G0 PARTIAL / W1 DEFER**. 기본 Dispatcher 동작, Native Writer 예약·Workspace 수명, Provider 자동 합류 정책 변경 없음.

## 판단 근거

T42-A의 `readCanonicalParallelWorkerReceipts()`는 Canonical Attempt·Commit·Patch Digest·Workspace Identity와 실제 물리 Git 상태를 일치시킨다. 그러나 Readback의 성공은 **이전 Native Writer가 앞으로 원래 Worktree를 다시 변경하지 않는다는 증명**이 아니다. T39는 App Server 또는 부모 PID 종료 뒤에도 독립 Grandchild가 계속 기록하는 반례를 확인했다. 따라서 `ready`는 자동 Owner CAS를 승인하지 않는다.

T41에서 macOS OS Scoped Proof와 기존 Owner Fence를 최초 `cherry-pick`부터 CAS·Report까지 묶었다. T42-B1은 이 실행 경로의 **쓰기·Proof 부분만** 재사용하고, 오래된 두 Host의 결과를 새로운 Worker 호출 없이 조합할 수 있는지 확인한다.

## 이번 구현

1. macOS가 아니면 `recovery_os_write_scope_unavailable`로 거부한다. Proof Command Ref나 Runtime Home이 없거나 Canonical Readback이 `blocked`인 경우에도 아무 Git/Owner 수정을 시작하지 않는다.
2. 현재 Owner Run Revision/Workspace Identity/Base Commit의 기존 Kernel Owner Fence를 **최초 Integration 쓰기 이전**에 획득한다. 획득 뒤 Readback을 다시 실행해 원래 수집한 Canonical Receipt가 달라지지 않았는지 확인한다. 다른 복구 Host는 기존 Owner Fence에서 거부된다.
3. T36의 `prepareRecoveryIntegrationWorktree()`로 **새로운 물리 Integration Worktree**를 만들고 기존 Kernel Workspace Registry에 등록한다. 이전 Step Worktree를 재실행·재사용하지 않는다.
4. 기존 `integrateParallelResults()`의 Step Path Scope, Commit cherry-pick, staged path와 patch 일치 검증을 재사용한다. 검증 전에 동일 Fence Epoch를 갱신한다. Trusted Proof는 `writeScope`를 **이 Integration Worktree에 제한**하고 실제 macOS Seatbelt가 적용되지 않으면 실패한다.
5. Proof 전후의 staged Git Patch를 일치시킨다. **`verifyOnly:true`**에서는 `materializeDelivery()`를 호출하지 않는다. 따라서 Owner Git Patch 적용, Owner CAS, Canonical Report 정착은 발생하지 않는다.
6. Proof 후 Fence를 다시 갱신하고 Canonical Readback을 재실행하여 원래 결과가 바뀌었으면 거부한다. 정상 시에도 반환값은 `status:'verified'`, `deliveryAuthorized:false`, `writerExitVerified:false`다.
7. 기존 Owner Fence는 결과가 성공하거나 실패해도 기존 토큰으로 해제한다. 검증 도중 Fence 만료·분실이나 해제 실패는 `blocked`로 판정한다. OS Proof의 알 수 없는 후손을 고려해 **검증용 새 Worktree를 자동 삭제하지 않는다**.

## 검증 및 보류

| 범위 | 결과 |
| --- | --- |
| Linux strict TypeScript·제품·테스트 빌드 | PASS (`operationId=06419d1c-6f7d-4b57-b1a2-68e109a5b9b5`) |
| Linux 집중 두 Host·T37·T38·T41 회귀 | 8 PASS / 2 OS SKIP / 0 FAIL |
| Linux 확대 Dispatcher·Recovery·Proof 및 경계 | **37 PASS / 5 OS SKIP / 0 FAIL**, 9 modules / 313 files / 855 edges PASS (`operationId=16efca69-811c-4fb4-bc16-2354f68a2e24`) |
| 실제 macOS Native 두 Host 과거 Result의 새로운 OS Scoped Proof | 검증 후 기입 |
| 실제 macOS Proof 도중 Owner CAS 없음·Worker 재시작 없음·Fence 해제 | 검증 후 기입 |
| B2 실제 Owner CAS·Report exactly once 및 Crash 재조회 | **미구현; 별도 권한 증명 필요** |

## 남은 장벽

B1에서 물리적으로 분리된 Integration Worktree와 OS 제한 Proof를 사용해도, 다른 종류의 Provider나 플랫폼에서 과거 Writer/후손의 OS 쓰기 범위가 항상 제한된다는 보장은 없다. `writerExitVerified:false`, 외부 Writer Reservation/원래 Worktree 보존, 이전 Attempt의 자동 재실행 거부를 유지한다. B2에서는 두 회수 Host의 단일 Fence 경쟁, 기존 결과의 소비 시점 무결성, CAS 전후 중단·TTL 만료, Report exactly once를 실제로 증명한 뒤에만 자동 Delivery 적용 여부를 검토한다.

새 DB·Queue·Scheduler·Provider별 폴백, 새로운 Process 감시자, 별도 Result 저장 계층은 추가하지 않았다.
