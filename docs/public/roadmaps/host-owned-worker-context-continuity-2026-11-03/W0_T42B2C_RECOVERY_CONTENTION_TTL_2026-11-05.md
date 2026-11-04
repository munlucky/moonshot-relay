# W0 T42-B2-C — 분리 Host 복구 경합 및 Proof 도중 Fence TTL 만료

- 검증일: 2026-11-05 (KST)
- 기준 소스: bd34353b62702f3b7be341ffd362020094cd011b
- 범위: 종료가 확인된 동기식 시험 Worker의 분리 Host Canonical 결과
- 판정: T42-B2-C 제한된 Linux·Mac 시험 PASS / Native Writer 자동 합류 DEFER
- 전체 상태: **G0 PARTIAL / W1 DEFER**

## 검증 목적

T42-B2-A는 두 Host의 Canonical 결과를 Owner CAS 1회와 Report 2건으로 정착했다. T42-B2-B는 CAS 직후 복구 Host의 실제 프로세스를 종료하고 재진입 시 중복 정착이 차단되는 것을 확인했다.

이번 검증은 **두 독립 복구 Host가 실제 첫 cherry-pick 이전에 경쟁하는 경우**와 **Trusted Proof 진행 중 기존 Fence의 TTL이 만료되는 경우**를 동일한 분리 Host 결과 경로에서 재현했다. 별도 제품 경로나 자동 Native Writer 합류는 구현하지 않았다.

## 시나리오 A — split-dual-recovery

1. 원래 Host A/B의 동기식 Worker가 각각 종료된 상태에서 Canonical Attempt 2개는 started, Owner Revision은 0이다.
2. 별도 복구 Host A/B OS 프로세스가 같은 Canonical 결과를 읽고 Barrier에서 출발한다.
3. 복구 A가 기존 Owner Fence를 먼저 획득하고 첫 cherry-pick 이전까지 유지한다. 복구 B는 A의 보호 구간에 진입하려 하지만 delivery_mutation_fence_lost로 거절된다. B가 Git 통합이나 Proof를 시작하기 전에 차단됐음을 확인한다.
4. A만 신규 물리 Recovery Integration Worktree에서 두 Result Commit을 cherry-pick하고 Trusted Proof를 실행한다. Mac에서는 실제 macos-seatbelt Scope Proof를 사용한다.
5. A가 Owner CAS 0→1을 한 번 적용하고 Canonical Report 2건을 정착한다. 새 Worker나 Attempt는 만들지 않는다.

결과: **경합 선점 1, 거부 1, Proof 진입 1, CAS 1, Report 2, 최종 passed Step 2, 기존 Attempt 2 유지.**

테스트는 두 OS 프로세스를 동시에 시작하되, 한쪽이 Fence를 보유한 시점에서 다른 쪽의 획득 거부를 Barrier로 결정적으로 재현한다. 모든 무작위 스케줄링을 탐색하는 모델 검사는 아니다.

## 시나리오 B — split-ttl-proof

1. 이전의 동기식 Writer가 종료된 Canonical 결과 2건을 새 Recovery Worktree에 통합한다.
2. 복구 Host A가 TTL 5초의 기존 Owner Fence를 획득한 뒤 실제 Trusted Proof 프로세스를 시작한다. Proof는 통합 Worktree 안에 대기 Marker를 기록한다.
3. 최초 Fence의 만료 기한이 지난 뒤 독립 복구 Host B가 더 높은 Epoch Token으로 Fence를 획득한다. B는 **UUID 세대가 다른 새 물리 Integration Worktree**를 생성한다. 원래 통합 Worktree는 재사용하지 않는다.
4. 복구 B가 Proof 대기를 해제하면 A의 기존 Proof는 정상 종료된다. 그러나 **Proof 성공은 Owner Delivery 권한이 아니다.**
5. A의 기존 Token으로 renewOwnerWorkspaceMutationFence, assertOwnerWorkspaceMutationReady, recordOwnerWorkspaceMutation을 호출하면 모두 delivery_mutation_fence_lost로 거부된다.
6. Owner Revision 0, Attempt started 2개, 새 실행 가능 Step 0개, Owner 대상 파일 미생성 상태가 유지된다.

결과: **실제 Proof 도중 TTL 만료·새 Epoch 획득·새 Worktree 생성·오래된 Token의 갱신/적용 허가/CAS 차단을 확인.**

Linux의 Proof는 OS Scope 미지원이므로 일반 Trusted Proof로 실행한다. macOS에서만 실제 Seatbelt OS 쓰기 제한을 검증했다. Fence 자체가 임의 분리 OS Writer의 쓰기 권한을 박탈한다고 주장하지 않는다.

## 테스트 범위와 복잡도 점검

- 변경 파일은 tests/kernel-parallel-positive-two-hosts.test.ts 하나다. 기존 Canonical Readback, Kernel Fence, T36 Recovery Worktree, Trusted Proof 및 CAS/Report 테스트 코드를 재사용했다.
- 신규 테스트 모드 2개와 테스트 소유 Marker/Barrier만 추가했다. 새 DB·Queue·Scheduler·OS 감시·Provider 폴백·자동 Writer 정리·제품 공개 명령은 없다.
- 최초 TTL 시험에서 제품 Proof 실행기의 환경 변수 allowlist 때문에 테스트 제어용 환경 변수가 자식으로 전달되지 않았다. 그 결과 초기 5 PASS / 1 FAIL이 발생했다. 이 실패는 성공으로 계산하지 않았다. 제어 신호를 테스트 전용 통합 Worktree의 .t42-proof-enable Marker로 옮겨 수정했다. **제품 보안 allowlist는 변경하지 않았다.**
- 원본 Linux 저장소에서는 NODE_ENV=production으로 개발 의존성이 빠져 TypeScript 바이너리를 찾지 못했다. 별도 시험 Clone에만 npm ci --include=dev를 실행해 해결했다. 원본 의존성과 사용자 전역 환경은 변경하지 않았다.

## 결과

| 검증 | 결과 |
| --- | --- |
| Linux 격리 TypeScript typecheck / 제품 build / 테스트 build:tests | **PASS** |
| Linux focused | **6 PASS / 0 FAIL / 0 SKIP** |
| Linux Dispatcher·Fence·Recovery 확대 회귀 | **27 PASS / 2 OS SKIP / 0 FAIL**, 총 29 (focused 포함) |
| Linux module boundary | **9 modules / 313 files / 855 edges PASS** |
| Mac 실제 Darwin Node 24.6.0, 소스 bd34353b, 독립 Clone | **의존성·TypeScript·제품·테스트 빌드 PASS** |
| macOS Seatbelt Trusted Proof 포함 focused | **6 PASS / 0 FAIL / 0 SKIP** |
| macOS module boundary | **9 modules / 313 files / 855 edges PASS** |
| Native Codex Writer 및 모든 분리 후손 종료/재합류 | **미증명 / 비활성** |

### 추적 실행 증거

Linux:
- 새 테스트 집중 PASS(최초): 2e158d11-5a66-419f-8d55-e05d0adcd7d8
- 오래된 Epoch의 적용 허가·CAS 차단까지 확장한 집중 PASS: ce1a0024-8a59-47c8-aeae-f77c02d3f70c
- 확대 회귀: 4901b093-2c89-4115-857c-1e70d76654a2
- 제품 빌드 및 9/313/855 모듈 경계: d4d72cf0-0985-4abf-a10e-67e5d48cf8bf
- 초기 환경/실패 근거(성공으로 계산하지 않음): 907082c3-92f1-48dc-96f8-a2955a6dfddd, b2eb381b-943b-4cdc-8726-06d62f12662d, 32053cc5-6268-47ee-a94b-86231bc5e1eb

macOS:
- 정확한 소스 SHA 독립 Clone, 설치, 타입 검사, 테스트 빌드 및 focused 6 PASS 로그: 068c56cd-df67-474a-abff-9f1ad5dcaa1d
- 결과 로그 재확인과 제품 빌드·모듈 경계: 83474f94-aa17-4db0-aeae-167b7c1205e6
- 경계와 원본 Checkout SHA/clean 재확인: e1aa5fa8-ebbd-4cdb-a61a-f7b12d43f673

**결과 추출 주의:** macOS Node 24 Reporter는 Linux TAP과 다른 ℹ tests/ℹ pass 형식이므로 첫 시험 실행의 마지막 Linux식 grep 명령만 exit 1이었다. 실제 Node 테스트는 6 PASS/0 FAIL이며 후속 독립 로그 검사에서 이를 재확인했다. 이 출력 파서 실패를 테스트 실패나 Mac 코드 결함으로 분류하지 않는다.

## 남은 안전 조건

이번 시험은 제한된 동기식 파일 Writer의 종료가 확인된 상태에서만 Owner Delivery를 수행한다. **임의 Native App Server Writer의 모든 후손 물리 종료·영구 OS 쓰기 차단은 아직 미증명**이다. 따라서 writerExitVerified:false, deliveryAuthorized:false, 기존 예약과 Worktree 보존, Native 자동 합류 금지를 유지한다. Linux/Windows의 물리 OS Proof 쓰기 격리도 별도 문제다.

전체 판정은 **T42-B2-C 제한 범위 완료 / G0 PARTIAL / W1 DEFER**다. 다음 작업은 임의 Native Writer 후손의 실제 종료/격리 증거를 확보한 뒤에만 자동 합류를 검토한다.
