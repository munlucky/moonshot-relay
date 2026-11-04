# W0 T42-A — 독립 Host Canonical Worker Result 읽기 전용 검증

- 작성일: 2026-11-04
- 기준선: main / c595c6f7f633ae8f2294169274aebd814d75e800
- 변경: src/host/kernel/workspace/canonical-worker-receipts.ts, physical-worktree.ts, 기존 T24 두 Host 회귀
- 판정: T42-A Readback 구현. **T42-B 실제 Owner 정착은 미완료**. G0 PARTIAL / W1 DEFER.

## 왜 Readback부터 하는가

T24에서 서로 다른 두 Host가 같은 Run의 다른 Step을 각각 claim했다. 두 Host는 실제 Git Commit·Patch Digest·Worker Report를 기존 Canonical Attempt에 남겼다. 새 Host의 getExecutableSteps는 이미 claim된 Step을 반환하지 않는다. Worker를 재실행하지 않고 이전 Canonical Receipt를 읽어야 한다.

T39~T40에서는 Native App Server와 부모 프로세스가 종료돼도 독립 Grandchild Writer가 계속 기록할 수 있음을 확인했다. 따라서 결과 Commit이 온전해도 Native Writer 완전 종료나 Owner Delivery 권위를 자동 승인할 수 없다.

## 구현 경계

기존 prepareStepWorktree와 읽기 전용 검사기가 동일한 executionStepWorktreePath 함수를 사용한다. 검사기는 파일·Step·Attempt·Git 데이터를 읽기만 한다. Worktree 생성, Step claim, Writer 실행, Fence 취득, Owner CAS, Report 정착, 예약 변경을 하지 않는다.

- Run이 현재 Canonical Revision과 Plan Revision을 유지하고, 차단·완료되지 않았으며 현재 실행 가능한 Step이 없어야 한다.
- 각 Step에 해당하는 Canonical routed Attempt가 정확히 하나 있어야 하며, Result Attempt ID·Commit SHA·Workspace ID·Workspace Identity·Worker Report와 Run Revision을 일치시킨다.
- 실제 Git Worktree가 Run별 물리 실행 경로 안에 있고 Owner와 같은 Git common-dir을 사용해야 한다.
- Result Commit HEAD와 부모 Commit은 각각 Canonical Receipt 및 현재 Owner Base Commit에 일치해야 한다. Dirty·미추적 파일·중간 작업 변경은 거부한다.
- git show --format= --binary의 SHA-256이 patchDigest와 같아야 하고 git diff-tree의 변경 경로도 changedPaths와 일치해야 한다.
- 성공 결과에도 writerExitVerified:false와 deliveryAuthorized:false를 명시한다. 실패는 blocked와 이유 코드로 반환한다.

## 재현·검증

기존 tests/kernel-parallel-positive-two-hosts.test.ts를 확장했다. 실제 서로 다른 Host 프로세스가 두 Worker의 결과를 Canonical SQLite에 저장한 뒤 제3 Host가 재조회한다. Weak Proof는 경쟁 claim을 우회하지 못한다. 시험 소유 Worktree만 미추적 파일 삽입 및 Git HEAD 롤백을 수행하고 blocked를 확인한 다음 복구한다. 또한 시험 Owner에 임시 Commit을 추가하여 baseline 드리프트를 만들고 다시 복구한다.

| 범위 | 결과 |
| --- | --- |
| Linux TypeScript·제품·테스트 빌드 | PASS (operationId=a75cb02c-591e-4636-99fc-2799c7121eb9) |
| Linux 집중 실제 두 Host 3 시나리오 | 3 PASS / 0 FAIL |
| Linux 확대 Dispatcher·Proof·Fence·Report 및 모듈 경계 | 37 PASS / 4 OS SKIP / 0 FAIL; 9 modules, 313 files, 854 edges PASS (operationId=01f7660e-2614-41a1-95a4-6041cd8dfcae) |
| macOS 독립 Native Host 실제 Canonical Readback | 완료 후 반영 |
| 서로 다른 과거 Host의 결과를 단일 CAS·Proof·Report로 자동 정착 | **미구현 — T42-B** |

## T42-B 선행 조건

실제 자동 정착은 T41의 단일 Owner Fence/새 물리 Integration Worktree/OS Scoped Proof를 사용하더라도, 기존 Native Writer가 결과 Worktree를 다시 변경할 수 없다는 충분한 증거가 필요하다. 두 복구 Host 경쟁, Step/Attempt 불일치, stale base/digest, Fence 만료, CAS 후 Host 종료, Report 정착 exactly-once를 통과하기 전에는 자동 Native 재사용·Writer 예약 해제·Owner Delivery를 활성화하지 않는다.

새 DB, Queue, Scheduler, Provider 폴백, 감시 프로세스 또는 Receipt 저장 계층은 추가하지 않는다.

**최종 게이트: G0 PARTIAL / W1 DEFER.**
