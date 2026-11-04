# W0 T34 — 통합 Proof 이전 Owner Fence 수명과 OS 이탈 후손의 음성 반례

- 작성일: 2026-11-04
- 기준선: `main / 1894aac431f820254ed25331dc0be87585853b5c`
- 검증 소스: `tests/kernel-parallel-proof-fence-lifetime.test.ts`
- 판정: **기존 Owner Fence의 독립 Control Plane 간 상호 배제는 실제 Trusted Proof가 진행되는 동안 유효. 그러나 Fence 수명이 끝나면 이전 Trusted Proof의 분리된 OS Writer가 여전히 통합용 파일에 쓸 수 있다.** 무조건 `acquireOwnerWorkspaceMutationFence()`를 Proof 앞으로 옮기는 것만으로는 안전한 자동 복구가 아니다. **G0 `PARTIAL`, W1 `DEFER`.**

## 왜 현재 Dispatcher를 그대로 바꾸면 안 되는가

기존 `src/host/kernel/parallel-dispatcher.ts`의 `integrateParallelResults()`는 Worker Commit을 통합 Worktree에 `git cherry-pick --no-commit`으로 적용하고 `executeIntegrationVerification`을 실행한다. 그 후 `materializeDelivery`에서만 Owner Fence를 획득하여 Owner `git apply`/CAS를 보호한다. 따라서 **통합 Worktree의 최초 쓰기·통합 Proof·두 Host의 복구 경쟁은 현재 Fence 보호 범위 밖**이다.

현재 `executeTrustedProof()`는 Node의 `spawnSync()`와 단일 실행 timeout을 사용한다. POSIX에서 Timeout은 직접 실행한 프로세스의 종료를 뜻할 수 있으나, Proof 명령이 따로 생성한 분리 OS 후손 전체의 종료·쓰기 정착까지 증명하지는 않는다. 새 Kernel Host가 Fence를 획득했다고 이전 Host/Proof의 파일 쓰기 권한이 자동 소멸하지도 않는다.

T33에서 실제 Mac Native App Server의 전체 process group 종료 후에도 분리된 Writer가 살아남았다는 사실과 **서로 다른 경로의 문제**다. 이번에는 모델·Native Provider 없이 기존 Kernel Owner Fence와 **Trusted Proof 실행기 자체**의 실패 창을 분리해 검증한다.

## 테스트 설계

운영 저장소·Codex 세션·Runtime에 쓰지 않고, 각 테스트에 새로운 임시 Git Owner와 격리된 Kernel SQLite Runtime을 사용한다. 같은 Run에 대해 독립 `createKernelControlPlane()` 객체 2개를 생성한다. **T24의 두 독립 Host 프로세스 경합 검증을 대체하지 않는다.** 이번 시험은 동일 프로세스의 두 Control Plane 객체가 실제 SQLite Fence 권위를 공유하는 조건에 한정한다.

1. 정상 경로: Host A 소유 Token으로 Owner Fence를 Proof **전에** 획득한다. 다른 Control Plane의 다른 Session Token은 획득에 실패한다. manifest에 선언된 `test:proof`를 실제 `executeTrustedProof()`로 실행한 뒤 같은 Fencing Token으로 갱신한다. 상대방은 여전히 거부되고 Owner Mutation Revision은 `0`이다.
2. 종료 불명확 경로: Test-only `test:proof`가 유한한 Launcher/분리 Writer를 만든다. Launcher/Writer PID는 서로 다른 시험 파일에 남긴다. Proof는 짧은 Timeout으로 `failed/timedOut`이 되고, 분리된 Writer는 계속 명시적 시험 통합 경로에 대한 쓰기 준비를 유지한다.
3. 첫 Owner Fence가 실제 만료된 뒤 두 번째 Control Plane이 새 Fencing Epoch로 같은 Run의 Fence를 획득한다. 첫 Host의 예전 Token 재갱신은 거부된다. **새 Fence가 살아 있을 때** 테스트가 기존 분리 Writer에게 유한한 파일 쓰기를 허용하면, 이전 Writer가 `late-proof-write`를 생성한다. Kernel Revision은 `0` 그대로이고, 새 Fence 갱신도 정상이다.
4. Writer와 Launcher는 테스트 내부에서 정한 유한 기한으로 자체 종료한다. OS `ps` 결과에서 실행 중인 상태가 없음을 확인했을 때만 임시 디렉터리를 삭제한다. 실패·확인 불가이면 시험 데이터를 보존한다. 운영 PID/프로세스 그룹 종료, 무제한 Retry/별도 Scheduler는 없다.

이는 **실제 제품 Dispatcher가 Proof 전에 Fence를 획득하도록 이미 변경했다는 테스트가 아니다.** 해당 코드를 바꾸기 전에 필요한 음성 반례를 고정한다. 뒤늦은 쓰기는 이 시험의 명시적 격리 통합 경로에만 발생했으며, Canonical Owner Git은 바꾸지 않았다.

## 검증 결과

| 항목 | 결과 |
| --- | --- |
| Linux TypeScript·제품·테스트 빌드 | PASS (격리 Runtime, 실제 Trust Proof) |
| Linux 집중 T34 두 시나리오 | **2 PASS / 0 FAIL** (`operationId=8afca193-e835-4176-b9c2-5faf14dd9f66`); 최종 source 포함 확대 검증에서도 재현 |
| 정상 Proof 실행 중 경쟁 Fence 차단 | PASS |
| Timeout·Lease 만료·상대 Host 획득·옛 Token 거부 | PASS |
| 새 Fence 유지 중 이전 OS 후손의 쓰기 | **재현 PASS (안전성 요구는 미충족)** |
| Linux 확대 회귀·모듈 경계 검사 | **60 PASS / 1 OS SKIP / 0 FAIL**, 9 modules / 311 files / 849 edges PASS (`operationId=6452a98a-6c7c-43d7-8e4d-9f507d0a8fc0`) |
| Mac Native OS 유한 후손 검증 | 검증 완료 후 반영 |

최초 독립 Linux `npm ci` prepare 시 Strict TypeScript가 `renewed.lock`과 `renewal.lock`의 Nullable 계약 미확인을 정확히 검출했다. 제품 API가 null을 반환할 수 있음을 인정하고 테스트 Assertion에서 `lock` 존재를 먼저 확인한 후 typecheck, 빌드, 집중 검증에 성공했다. 제품의 nullable 경계를 임의 폴백으로 숨기지 않았다.

## 결정 및 다음 구현 게이트

- **이번 Wave에 제품 Dispatcher의 Owner Fence 시점을 이동하지 않는다.** 먼저 실제 Proof 프로세스와 후손의 쓰기 권한이 Fence 소유 수명 내에 정착하거나, 다른 Host가 사용하는 실제 통합 Worktree와 격리된다는 검증이 필요하다.
- 완료를 증명하지 못한 Proof가 통합 Workspace에 접근 가능한 한, 단순 TTL 증가·SIGTERM·POSIX `killpg`·PID 부재 추정·승인 후 재시도는 안전하지 않다. OS containment 또는 기존 Worktree/Host Sandbox 격리를 사용한 검증된 경계만 후보로 남긴다.
- 이후에만 최초 Git cherry-pick 이전부터 Proof, Owner CAS, Canonical Report settlement까지 **단일 복구 조정자의 권위**를 확보한다. 두 Host 동시 진입·Lease 만료·CAS 이후 중단 반례를 통과해야 한다. 기존 `writerExitVerified:false`, 외부 Host Writer 예약, `recoverPendingDeliveryMaterialization()` 차단은 유지한다.
- 별도 DB, Queue, Scheduler, Provider별 폴백, 모호한 차단 정책의 누적을 도입하지 않는다.

**전체 상태: G0 PARTIAL / W1 DEFER, Native 자동 결과 합류 비활성화.**
