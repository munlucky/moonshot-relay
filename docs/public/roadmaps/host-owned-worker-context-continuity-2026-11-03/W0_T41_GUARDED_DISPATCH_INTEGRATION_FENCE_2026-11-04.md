# W0 T41 — Dispatcher 선택형 OS 격리 통합·단일 Owner Fence 수명

- 날짜: 2026-11-04
- 기준 소스: `main / 525a4f8f1b150cc97386e07c2b2b5b6e20a7cd49`
- 구현: `src/host/kernel/parallel-dispatcher.ts`
- 실증: `tests/kernel-parallel-post-cas-host-restart.test.ts` 및 T37·T38 선행 회귀
- 의사결정: **기본 Dispatcher와 Native 자동 재회수는 변경하지 않는다.** OS 강제 쓰기 경계를 가진 macOS에서만 명시적으로 선택하는 `guardedIntegration:true` 경로로 검증한다. 전체 **G0 PARTIAL / W1 DEFER**.

## 먼저 확인한 기존 단절

기본 Dispatcher는 두 Worker의 Canonical Attempt/Result Commit을 영속화한 뒤 다음 순서로 실행한다.

`일반 integration Worktree cherry-pick → Trusted Proof → materializeDelivery에서 Owner Fence 획득 → patch check/Owner CAS → Owner Fence 해제 → settleParallelResult → cleanup`.

따라서 첫 integration 쓰기와 Proof 도중 다른 Host의 Owner Fence 경쟁이 발생할 수 있으며, CAS 직후 Report 정착을 하기 전에 Fence가 해제된다. T34는 논리 Fence 만료 뒤에도 OS Proof 후손이 여전히 쓰는 반례를 증명했다. T35는 macOS `writeScope`에 의한 OS 강제 Proof 제한, T36은 복구 시도마다 새로운 물리 Integration Worktree, T37은 전 구간 Fence 수용 순서, T38은 CAS 직후 중단 시 안전한 blocked 복구, T39~T40은 Native 이탈 Writer의 외부 OS 쓰기 격리를 검증했다.

## T41 선택형 실제 제품 경로

- `dispatchKernelParallel({ guardedIntegration:true })`는 **macOS에서만** 실행한다. 다른 OS 또는 호출자가 직접 제공한 Proof Runner를 감지하면 작업을 시작하기 전에 `guarded_integration_os_proof_unavailable`로 **실패 종료**한다. 작업 준비·권위·입장 조건에 실패해도 기존 순차 실행이나 Sandbox 없는 Proof로 전환하지 않는다.
- 보호 모드는 **기존 고정 `integration` Worktree를 열지 않는다**. Step 준비 시 기존 물리 Step Worktree의 재사용이 확인되면, 실제 Writer 종료를 알 수 없으므로 새 Worker를 시작하기 전에 거부한다. 기존 Dispatcher의 Step·Integration 준비 동작은 유지한다.
- 기존 Host가 실행한 모든 Step의 Canonical Worker 실행 Receipt가 이번 배치 안에 준비된 경우에만 통합을 허용한다. 실패하거나 경쟁 Host에게 선점된 Step이 있으면 일부 결과만 Owner에 적용하지 않는다.
- 기존 `acquireOwnerWorkspaceMutationFence()`로 Owner Fence를 **최초 cherry-pick 이전**에 확보한다. 그 다음 T36의 `prepareRecoveryIntegrationWorktree()`에서 **새 물리 Git Worktree**를 만들어 Kernel에 등록한다. 실패 시 통합하지 않고 기존 Fence를 해제한다.
- 모든 `cherry-pick` 직전에 기존 Fencing Token을 `renewOwnerWorkspaceMutationFence()`로 갱신하고 Owner CAS 사전 검사를 받는다. 실제 Proof는 기존 `executeTrustedProof()`에 `writeScope=integration Workspace`를 명시해 macOS의 OS 제한을 상속한 후손을 생성한다. 외부 임의 Proof Runner를 허용하지 않는다.
- Proof가 실행 중 Fence를 잃거나 만료되면 Owner 변경 전에 기존 갱신·CAS 검사가 거부한다. 별도 Timeout·PID 감시·새 Lock 권위를 추가하지 않는다.
- 기존 `git apply --check → Fence 갱신 → assertOwnerWorkspaceMutationReady → git apply → recordOwnerWorkspaceMutation` 체계를 유지한다. **같은 Fencing Token**은 Owner CAS 이후에도 살아 있다. CAS 이전 갱신은 기존 Kernel `phase=pre`의 깨끗한 Owner 검사, CAS 이후 갱신은 기존 Mutation Guard의 `phase=post-commit` 검사로 현재 Owner Mutation Revision/Workspace Identity를 검증한다. 이 명시적 갱신 구분은 기존 `renewOwnerWorkspaceMutationFence` 인자에 추가하며 기본값은 `pre`로 유지한다. CAS 이후의 Owner Worktree는 원래 변경돼 있으므로 더 이상 `pre`로 판단할 수 없다. Report 정착 중 Host가 죽으면 T38과 같이 기존 Recovery가 미정착 Run을 blocked로 판정하도록 한다.
- 모든 Report 정착 시도와 오류 처리가 끝난 뒤 **동일 Fence를 정리**한다. 단, 마지막 Report에서 Run이 `completed`가 되면 Kernel의 기존 terminal reconciliation이 Fence를 이미 삭제할 수 있다. 이때 Dispatcher는 Canonical Run `completed`와 State Store의 현재 Fence 부재를 함께 확인하고 중복 삭제하지 않는다. 활성 Run에 남은 Fence는 기존 방식으로 정확한 Token을 지정해 해제하며, CAS 이후 정착 오류나 Fence 오류는 기존 `delivery_materialization_recovery_required`로 blocked 처리한다.
- 종료 불명 Worker·Proof 후손을 단순히 Report 성공으로 치우지 않는다. T36 복구 Worktree와 일반 Run/Step Worktree를 자동 삭제하지 않으며, 승인된 유한 시험 소스만 별도 명시적 정리한다.

## 검증 범위

| 검증 | 판정 |
| --- | --- |
| Linux strict TypeScript·제품·테스트 빌드 | **PASS**. 최초 제품·전 구간 빌드와 보정 이후 동일 격리 Source에서 strict TypeScript/테스트 빌드 재검증 (`operationId=1a4b93e5-6a12-474b-8df4-939429b50708`, `a3bfe8d2-ecb5-4fe5-8995-ae7f23dd3296`) |
| Linux 기본 Dispatcher 회귀 및 보호 경로 OS 미지원 거부 | 보정 후 확대 **37 PASS / 5 OS SKIP / 0 FAIL**, 최종 집중 **5 PASS / 2 OS SKIP / 0 FAIL**, `check:boundaries` **9 modules / 312 files / 850 edges PASS** (`operationId=1a4b93e5-6a12-474b-8df4-939429b50708`, `a3bfe8d2-ecb5-4fe5-8995-ae7f23dd3296`) |
| Mac 실제 Seatbelt `writeScope` Proof, 최초 Fence~CAS~정착 및 재시작 | **PASS** — `d792b05b`의 실제 macOS OS Host 시험. Guarded 정상 2개 Canonical Report, Owner Revision `0→1`, Run `completed`, 같은 Fence Token을 정착까지 유지하고 Kernel terminal이 Fence 정리. Scoped Proof `macos-seatbelt` 확인 (`operationId=cfaf1a60-35ce-4d77-bbe5-07b4960c8870`) |
| Mac 보호 경로 CAS 직후 Host 종료·다음 Host blocked 재조회 | **PASS** — 실제 독립 OS Host `guarded-crash`, 기존 두 Canonical Attempt·Owner Revision `1` 보존, 새 Host `delivery_materialization_recovery_required` 차단, 중복 Worker·Owner Delivery 없음 (`operationId=cfaf1a60-35ce-4d77-bbe5-07b4960c8870`) |
| 임의 Native Worker 실제 물리 후손 종료와 결과 자동 재회수 | **미증명; 이 옵션으로도 허용하지 않음** |
| Linux/Windows OS 강제 Proof | **미지원; 자동 일반 spawn 폴백 없음** |

## 첫 macOS 실증에서 확인한 수정 원인

커밋 `a20bb944`의 실물 Mac Native 시험은 strict TS/제품/테스트 빌드 PASS였지만 통합 4건이 FAIL로 판정됐다. 실패는 두 종류로 분리됐다.

- T38 정상·CAS 중단 및 T41 CAS 중단: 시험 fixture의 Git 메인 Worktree가 macOS에서 `/private/var/...`로 정규화됐는데 시험의 `/var/...` 문자열과 비교해 일치하지 않았고, Git 메인 Worktree를 제거하려고 시도하면서 **시험 정리 assertion만 FAIL**이었다. 두 Host·CAS 본문 실패로 보지 않는다. 개선은 `realpathSync()` 비교만 적용한다.
- T41 정상: macOS 실제 Scoped Proof가 성공하고 두 Canonical Step이 `passed`, Owner Revision `0→1`, Run `completed`, Fence 행이 **이미 삭제**된 증거를 읽기 전용 SQLite에서 확인했다. Kernel은 terminal Run으로 전환할 때 기존 Workspace Fence를 정리하지만 Dispatcher는 마지막 `finally`에서 동일 Token의 재해제를 요청해 `workspace_lock_handoff_failed`를 발생시켰다. 개선은 **`completed`와 기존 State Store의 Fence 부재가 동시에 관측될 때만** 재해제를 생략하며, 활성 Run의 Fence 상실은 기존 실패로 유지한다.

이 보정은 새로운 Lock 권위·영속 상태·예외별 폴백을 추가하지 않는다. 이전의 Mac 실패를 PASS로 소급하거나 같은 SHA를 검증했다고 주장하지 않는다. 이후 보정 커밋의 실제 Mac 회귀를 별도로 기록한다.

보정 커밋 `7ddd2e54`의 Mac 재시험에서는 일반 정상 경로가 PASS, 실제 Mac Scoped Proof/T36 격리와 T37 Fence 회귀가 PASS였다. 보호된 정상 경로도 Owner `completed` 및 terminal Fence 해제까지 진행했다. 다만 Crash·Guarded 3건이 공통적으로 **이미 지워진 Step Worktree의 Git metadata를 `realpathSync()`로 읽는 시험 정리 코드**에서 ENOENT로 실패했다. T38 fixture가 **자신의 경로로 확인된 남은 Worktree만** 정리하도록 `path.resolve`와 `existsSync`를 사용하고, 삭제된 경로의 Git 메타데이터는 기존 `git worktree prune`으로 제거한다. 두 번째 Mac 실패 역시 PASS로 소급하지 않는다.

## T41 최종 macOS 실물 검증 (커밋 `d792b05b`)

보정된 코드와 테스트의 정확한 Git SHA `d792b05b87a38e07b032636194e7a9fa0a69a817`을 별도 Mac Native Git Clone에서 빌드했다. macOS Node v24에서 TypeScript·제품·테스트 빌드 PASS, `node --test --test-concurrency=1`의 실제 Mac OS 교차 회귀 **9 PASS / 2 OS 별도 분기 SKIP / 0 FAIL**을 확인했다.

- **T38 원래 경로 2건**: 서로 다른 실제 Host 프로세스의 정상 두 Step Report 정착과 CAS 직후 강제 종료·다음 Host blocked 판정 모두 PASS.
- **T41 보호 경로 2건**: `guarded`는 처음 cherry-pick 이전 단일 Owner Fence 획득, 별도 물리 T36 Integration Worktree, macOS Seatbelt `writeScope` Proof, 같은 Fencing Token으로 두 Report 정착, Run `completed`와 terminal Fence 제거 확인. `guarded-crash`는 CAS 직후 Host 종료를 재현하고 새 Host에서 미정착 Run blocked, 두 Attempt·Owner Revision 보존 및 중복 Worker 없음.
- **T37 기존 Fence 회귀 2건**: 단일 Fence 범위와 만료 후 stale Token 거부 PASS.
- **T35·T36 기존 OS 격리 회귀 3건**: 분리 Proof 후손의 Owner·symlink 우회 쓰기 거부, 새 물리 Worktree 세대 격리·기존 후손의 새 세대 외부 쓰기 거부 PASS.
- **2 SKIP**: macOS에서 실행할 이유가 없는 non-macOS 지원 거부 및 타 OS writeScope 미지원 분기. 실패나 검증 누락을 PASS로 계산하지 않았다.

동일 시험에서 처음 두 Mac 커밋(`a20bb944`, `7ddd2e54`)은 각각 4 FAIL·3 FAIL이었고, 위에서 확인된 제품 terminal Fence 이중 해제 및 시험 정리의 macOS Git 경로 별칭·삭제된 Worktree 메타데이터 원인만 최소 수정했다. 실패 기록은 그대로 보존하고 **최종 커밋의 독립된 새 시험만 PASS**로 판정한다. 최종 시험과 앞선 실패 시험이 생성한 **세 개의 격리 Git Clone 및 일곱 개의 T38 fixture**는 결과·Git SHA·fixture identity를 대조한 뒤 정리했다 (`operationId=9a8dba30-ef53-40e7-8ce7-a7a0e8181a52`, `c264438a-8521-43fb-b8a3-a4df7e2699aa`, `10e90d13-2caa-438b-89e8-66c32c06f4b6`, `1f2f9e78-c74a-4de5-8291-30c1b6b5e2ee`). 원본 Mac 사용자 checkout은 `4f1ed1b0`의 clean 상태로 유지했다.

**판정 경계:** 이 시험은 *동기식으로 완료되는 시험 Worker*와 실제 OS-scoped Trusted Proof의 제품 Dispatcher 생명주기를 검증한다. 실제 임의 Native Codex Tool Writer가 생성한 모든 후손의 종료·동일 Attempt 예약 해제·다른 Host의 과거 split Worker 결과 자동 합류까지 증명하지는 않는다. 보호 옵션은 기본값 `false`를 유지한다. G0 `PARTIAL` / W1 `DEFER`.

## 구조·복잡도와 보수적 판정

이 변경은 기존 Kernel Control Plane, Owner Fence, OS Scoped Proof, T36 물리 Worktree, Canonical Attempt/Report API의 조합만 사용한다. 별도 DB/Queue/Service/Provider 전용 retry/fallback, 새로운 Fencing Token 또는 실행 스케줄러를 도입하지 않는다.

선택형 보호 통합은 **이번 Host가 실제 실행하여 완료한 Worker 결과만** 받는다. 다른 Host가 완료한 이전 split 결과를 자동으로 수집·재실행하거나 이전 Native Writer의 단일 예약을 해제하지 않는다. OS Sandbox로 과거 Worker의 Owner/다음 세대 외부 쓰기를 거부하더라도, 그 Writer의 **모든 후손이 실제 종료됐다는 증거**는 별개다. Native Writer의 전체 OS 종료가 모르는 상태에서 `writerExitVerified:false`, 물리 Worktree/예약 보존, `recoverPendingDeliveryMaterialization()` blocked 판정을 유지한다.

**G0 PARTIAL / W1 DEFER.**
