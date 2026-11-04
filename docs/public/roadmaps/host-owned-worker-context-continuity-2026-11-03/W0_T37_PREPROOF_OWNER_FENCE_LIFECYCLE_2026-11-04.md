# W0 T37 — 통합 최초 쓰기부터 Owner CAS·Report 정착 시도까지 Owner Fence 수명 검증

- 날짜: 2026-11-04
- 기준 소스: `main / 18e8705fe9a57ffa59b6e7384db05abdc89c12c6`
- 회귀: `tests/kernel-parallel-preproof-fence-lifecycle.test.ts`
- 판정: **기존 Kernel API만으로 전 구간 Fence를 유지하는 격리된 실행 순서와 만료 차단을 실측**. 단, 현재 `dispatchKernelParallel()` 제품 경로 자체의 Fence 수명 이동이나 자동 Canonical Worker 결과 회수는 **아직 적용하지 않음**. G0 `PARTIAL`, W1 `DEFER`.

## 실측한 기존 호출 경계

현재 Dispatcher는 Worker 결과 수집 후 `integrateParallelResults()`에서 결과 Commit의 `cherry-pick --no-commit`, Trusted Proof, 최종 Patch 계산을 수행한다. **이후에만** `materializeDelivery()`에서 `acquireOwnerWorkspaceMutationFence()`를 호출한다. `recordOwnerWorkspaceMutation()`의 CAS 성공·실패 후 `releaseOwnerWorkspaceMutationFence()`를 실행하고, 그 다음에 `settleParallelResult()`로 Report를 정착한다. 즉 현행 경로는 최초 Git 쓰기부터 Proof까지, 그리고 CAS 이후 Report 정착 시점까지 하나의 Fence로 보호하지 않는다.

T34는 Timeout된 Proof의 분리 후손이 이전 논리 Fence 만료 뒤에도 OS 쓰기를 할 수 있다는 반례를 이미 재현했다. T35는 Mac의 선택형 `writeScope` OS 격리를 검증했고 T36은 매 복구 시도마다 새로운 물리 통합 Worktree를 할당했다. 이 두 전제 없이 단순히 논리 Fence의 호출 시점만 앞으로 이동하면 격리됐다는 결론을 낼 수 없다.

## T37 실제 Kernel 회귀 (별도 구현을 누적하지 않음)

1. 운영 저장소 및 로컬 Codex 세션과 독립된 임시 Git Owner·실제 Kernel SQLite Runtime을 사용한다. 두 `createKernelControlPlane()` 인스턴스는 **같은 Canonical Run 및 Owner Fence**에 접근한다.
2. 통합 Host A가 **최초 `cherry-pick` 이전**에 Owner Fence를 획득하고, T36의 새로운 물리 통합 Worktree를 할당한다. 시험용 Step Worktree가 만든 실제 Git Commit을 `cherry-pick --no-commit`한다. A가 Fence를 보유한 동안 Host B의 획득은 거부돼야 한다.
3. A가 같은 Token을 갱신하고 실제 선언된 `test:ok` Trusted Proof를 실행한다. macOS에서는 T35의 실제 `writeScope`를 적용하며, Linux에서 강제 OS 쓰기 격리를 보장하는 것처럼 주장하지 않는다. Proof가 끝난 뒤 같은 Epoch 갱신으로 Owner CAS 준비를 증명한다.
4. 통합 Patch를 `git apply --check`, 기존 `assertOwnerWorkspaceMutationReady()`, `git apply`, `recordOwnerWorkspaceMutation()` 순서로 전달한다. Owner Revision `0 → 1`을 확인한다. **CAS 이후에도 Fence는 아직 해제하지 않은 상태**로 두 번째 Host의 새 Run Snapshot 획득이 거부되는지 확인한다.
5. 증거가 없는 `settleParallelResult()`의 실제 호출은 **evidence-rejected**여야 한다. 이것은 정상 Worker Report 정착의 성공 사례가 아니다. 정착 시도 중에도 B 획득이 거부됨을 확인한 뒤 A Fence를 해제한다.
6. 별도 만료 시험: A가 짧은 TTL로 Fence를 얻은 후 `test:long` Proof가 만료 시점을 넘어 실행된다. B는 새 Epoch로 Fence를 획득하고 새로운 물리 통합 Worktree를 할당한다. A의 오래된 Token 갱신은 거부되며 Owner Revision은 `0`, Owner 결과 파일은 없어야 한다.

## 검증 기록

| 항목 | 결과 |
| --- | --- |
| Linux 실제 SQLite·Git 전 구간 Fence 두 반례 | **2 PASS / 0 FAIL / 0 SKIP**, 타입·제품·테스트 빌드 PASS (`operationId=91252a04-a148-47eb-8050-dd12ed813d81`) |
| Linux 확대 Dispatcher·Proof·Report·Native Recovery 회귀 및 모듈 경계 | **36 PASS / 3 OS SKIP / 0 FAIL**, 모듈 경계 **9 modules / 312 files / 850 edges PASS** (`operationId=b2f0cfb4-f49c-4e64-a317-23f940912fae`) |
| macOS 실제 `writeScope` Trusted Proof와 동일 Fence 생명주기 | 검증 후 반영 |
| 기존 제품 Dispatcher의 첫 쓰기~정착 전 구간 Fence 보장 | **미적용 — T37은 수용 가능성 검증이며 기본 제품 경로 불변** |
| Canonical Report 정상 승인·Split Owner 결과 자동 재사용 | **미검증·DEFER** |

## 구조·복잡도 결정 및 남은 게이트

- 새로운 DB, Queue, Scheduler, Fencing Token 종류, Provider별 폴백을 도입하지 않는다. 기존 SQLite Run/Workspace Owner Fence, 기존 Git Worktree 및 Proof API를 그대로 사용했다.
- `spawnSync` Trusted Proof는 동기 호출 중 자동 Fence heartbeat를 보장하지 않는다. Proof가 TTL보다 오래 걸리면 이전 Token은 **반드시 거부**돼야 한다. 단순 TTL 연장은 완전한 후손 종료 증명이 아니다.
- 향후 제품 통합은 현행 Dispatcher의 최초 Git 쓰기·Verification·Owner CAS·Report 정착까지 동일한 **복구 조정자 권위**를 이동해야 한다. 완료 전에 OS 쓰기 격리와 유일한 물리 Worktree를 강제하고, 예외·만료·중단 시 이전 Worktree 및 unknown Writer 예약을 유지해야 한다.
- 정착 단계 정상 승인, CAS 직후 Host 중단·재시작, 두 **독립 Host 프로세스**의 재회수, 원래 Step/Attempt Canonical Receipt를 재실행 없이 사용하는 사례를 통과하기 전에는 자동 합류를 켜지 않는다.
- Native Worker 및 후손의 물리 종료 증거(`writerExitVerified`)는 아직 확보되지 않았다. 모르는 Writer를 성공으로 간주하거나 임시 Worktree를 삭제·재사용하지 않는다.

**전체 판정: G0 PARTIAL / W1 DEFER.**
