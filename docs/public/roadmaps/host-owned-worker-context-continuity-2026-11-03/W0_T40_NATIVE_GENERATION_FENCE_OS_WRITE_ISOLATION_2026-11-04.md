# W0 T40 — Native Host Crash·Owner Fence 만료와 복구 Worktree 세대별 OS 쓰기 격리

- 날짜: 2026-11-04
- 기준선: `main / 4e6e3473c7f885e6ff105c5a92af8db42d3f018d`
- 범위: 기존 `tests/kernel-native-host-disconnect-recovery.test.ts` **실제 macOS Codex App Server direct `command/exec`** 검증 경로와 문서만 확장한다. 제품 Dispatcher·Native Transport·Kernel Schema 변경 없음.
- 통합 게이트: **G0 PARTIAL / W1 DEFER**. 임의 Native Writer 물리 종료 및 Canonical 자동 정착을 허용하지 않는다.

## 가장 작은 개선 후보

T39에서 실제 Codex `command/exec`의 App Server 및 직계 Supervisor가 종료된 뒤에도 Grandchild Writer가 PPID=1, 독립 PGID에서 계속 쓴다는 것을 확인했다. 따라서 부모 종료·프로세스 그룹 SIGKILL·RPC 완료·한 번의 `ps` 조회를 `writerExitVerified:true`로 승격하면 잘못된 재사용·삭제 또는 Writer 중복 실행이 가능하다.

별도 OS 프로세스 감시·DB·Queue·Scheduler를 설계하기보다 이미 구현한 **Host 전용 Writer 예약(T27/T31), OS `workspaceWrite` Sandbox(T28/T39), 복구별 물리 통합 Worktree(T36), 기존 Owner Fence Epoch(T37)**를 결합한 실제 반례를 평가한다. 이는 *이전 Native Writer의 물리 종료*와 별개인 **새 Host/Owner 외부 경로의 쓰기 격리**를 확인하는 단계다.

## 실제 Native 수용 시나리오

1. 별도 실험 macOS Git Owner·Kernel SQLite Run을 생성한다. 기존 Owner Fence를 Host A 소유로 획득하고 실제 Native App Server에 `command/exec`를 요청한다. Sandbox는 A의 물리 Attempt Worktree만 쓰기 허용한다.
2. 이탈한 `spawn({detached:true})` Writer가 A의 Worktree에서 실제 `fsync` heartbeat를 기록하는 동안 **Host A를 SIGKILL**한다. App Server 자체 PID를 종료해도 A Writer는 계속 써야 한다. Kernel Canonical Attempt 상태 `started`와 예약 마커 1개를 보존한다.
3. 새 Host B는 이전 A Worktree에 다시 Native Provider를 실행하지 않는다. 기존 Owner Fence가 유효하면 B의 획득이 거부돼야 하며, TTL을 넘긴 후에만 새 Fence Epoch를 획득한다. A Token의 갱신은 거부되고, **이전 A Writer의 OS 권한은 Fence 만료와 무관**하다.
4. B는 기존 `prepareHostWriterAttemptWorktree()`로 별도 Step Attempt Worktree를 만들고, T36의 `prepareRecoveryIntegrationWorktree()`로 **새로운 물리 통합 Git Worktree**를 생성한다. A/B/복구 Integration은 실제 서로 다른 경로여야 한다.
5. B가 A Worktree 안에 새 타깃 정보(B Step, 새 Integration, Owner)를 넣으면, 계속 살아 있는 A Native Writer는 자기 A 경로를 쓸 수 있지만 **B Step·새 Integration·Owner에 직접 파일 쓰기를 OS Sandbox가 `EPERM`/`EACCES`로 거부**해야 한다. 대상 경로가 이미 존재하는 상태에서 실제 쓰기를 시도해 검증한다. 구형 논리 Fence만으로 허용 여부를 결정하지 않는다.
6. 별도 B Native `command/exec`는 오직 B Worktree에 파일을 쓸 수 있고, 기존 A Writer는 그 동안 계속 살아 있어야 한다. A/ B 외부 Host Reservation 마커 2개를 유지한다. Owner Revision은 `0`; Native 결과만으로 Canonical Report/CAS가 생성되지 않는다.
7. 알려진 유한 A Writer가 heartbeat 240회 후 자체 종료하고 Launcher도 실제 PID에서 사라진 뒤, B Native 명령도 종료됐음을 확인한 **테스트 소유 Worktree만** 삭제한다. 모르는 사용자 Worker/OS 프로세스를 종료·정리하지 않는다.

## 검증 증거

| 검증 | 결과 |
| --- | --- |
| Linux TypeScript·제품·테스트 빌드 | **PASS** (`operationId=6b1cad92-d02f-4474-82e2-0861de117574`) |
| Linux 기존 T31·T36·T37·T39 회귀 | **집중 3 PASS / 3 OS SKIP / 0 FAIL**, 확대 **32 PASS / 4 OS SKIP / 0 FAIL**, 모듈 경계 9 modules / 312 files / 850 edges PASS (`operationId=7aed70d2-ef7e-4552-823f-95a5f7042120`) |
| macOS 실제 Native Crash + Owner Fence Epoch 만료 + 새 Integration Worktree 외부 쓰기 차단 | **1 PASS / 0 FAIL / 0 SKIP**; 새 Fence Epoch 1→2; B Step, Recovery Integration, Owner 각각 125회 거부·허용 0 (operation 46bd456d-6242-4291-97cf-d555ab0f2ed5) |
| 다른 Host Native Worker의 실제 동시 실행과 기존 A의 생존 | **PASS**; 이전 Writer가 계속 쓰는 동안 B Native 실행 성공, 이전 Provider 재실행 0, Owner Revision 0, 예약 유지 |
| 일반 Native Tool의 임의 후손 전부 종료 | **미검증** |
| 제품 자동 Owner Delivery/Report 회수·Writer 예약 해제 | **미적용, DEFER** |

## 실제 Mac Native 실증 및 정리

소스 SHA 0d52fbeef630c499aedd72dfbe5fd4be7f59ae8a의 별도 Mac Git Clone과 빈 격리 CODEX_HOME에서 strict TypeScript·제품·테스트 빌드 후 실제 Codex App Server 직접 command/exec를 실행했다. 모델 Turn과 운영 Codex 세션은 호출하지 않았다.

- Host A가 Native 명령 실행 중 SIGKILL돼도 이전 Writer는 계속 heartbeat를 기록했다. 별도 Host B는 원래 Fence가 유효하면 진입할 수 없고, TTL 만료 후에만 새 Epoch 2를 얻었다. 이전 토큰 갱신은 거부됐다.
- A와 다른 물리 B Step Worktree 및 새로운 T36 복구 Integration Worktree를 생성했다. 이전 A Writer는 B Step·새 Integration·Owner에 각각 125회 실제 쓰기를 시도했으나 모두 OS Sandbox에서 거부됐다. 외부 쓰기 성공 0건이다.
- 별도 B Native command/exec는 자신의 B Worktree에만 쓰기 성공했다. A Launcher 재실행 0회, Owner Mutation Revision 0, Canonical Report 권위 없음, Writer 예약 자동 해제 없음.
- 유한 A Writer가 heartbeat 240회를 기록하고 자체 종료했으며 Launcher도 OS PID에서 사라진 것을 시험 안에서 확인했다. 시험 결과와 원격 SHA를 재대조한 후 별도 Clone/격리 CODEX_HOME만 제거했다 (operation 2b851ebd-bf84-45c7-8c80-6ba7a644b1e8). 원본 Mac checkout 및 사용자 Codex 세션은 변경하지 않았다.

이 PASS는 해당 macOS Native Sandbox에서 살아 있는 이전 Writer의 외부 쓰기 격리를 입증한다. 임의 미래 Native 명령의 모든 후손 종료, 다른 OS 격리 및 자동 Canonical 결과 회수는 입증하지 않는다. Linux 최초 npm prepare의 테스트 타입 선언 오류는 Control Plane 반환 타입으로 수정해 동일 격리 환경에서 빌드·회귀를 재검증했다. 제품 코드는 변경하지 않았다.

## 권위·복잡도 제한

- **OS 권위:** macOS의 실제 Codex `workspaceWrite` Sandbox만 외부 파일 쓰기를 거부한다. Fence Token은 Owner 논리 변경을 제어할 뿐 이전 OS Writer의 쓰기 권한을 빼앗지 못한다.
- **Kernel 권위:** Owner Fence Epoch·Canonical Attempt·Owner CAS·Proof/Report는 기존 Kernel에서만 판정한다. Native Provider Turn `completed`, App Server/직계 PID 소멸, 새 Step 파일 존재로 Canonical 완료를 주장하지 않는다.
- **물리 생명주기:** 알 수 없는 하위 프로세스의 종료는 미증명이다. `writerExitVerified:false`, 단일 사용 Writer 예약, 만료/중단 Worktree 보존을 유지한다. 자동 회수보다 안전한 차단이 우선이다.
- **적용 제한:** macOS Native Sandbox와 격리 Worktree의 쓰기 제한은 통합 증명이 가능하더라도 모델의 도구 호출이 동적 외부 writable root 또는 Sandbox를 우회하지 않는다는 보장은 별도 검증 대상이다. Linux/Windows는 이 macOS 증거로 통과 처리하지 않는다.
- 새 DB, Queue, Scheduler, 지속 PID 추적 계층, Provider별 폴백, Writer 종료 단정 규칙을 추가하지 않는다. 검증이 선행되지 않은 제품 Dispatcher 기본 경로는 변경하지 않는다.

## 다음 게이트

실제 Native A Writer가 살아 있고 이전 Fence가 만료된 상황에서도 B/새 Integration/Owner로 쓸 수 없음이 증명되면, **외부 쓰기 격리**는 보강된다. 그러나 자동 Canonical 결과 재사용에는 여전히 올바른 Worker 결과 Receipt, 동일 Owner Fence의 첫 `cherry-pick`~Scoped Proof~CAS~정착, 중단 후 재조회, 정확히 한 번 Delivery가 필요하다. 임의 Native Writer의 완전 종료를 모르는 동안에는 새 Writer 예약을 재사용하거나 자동 합류를 활성화하지 않는다.

**전체: G0 PARTIAL / W1 DEFER.**
