# W0 T31 — 실제 Native Host 중단·불명 실행·Canonical Attempt 복구 검증

- 검증일: **2026-11-04**
- 기준선: `main / 7e777e95ad1366763b1e4eead1d084e83ed4655f`
- 판정: **macOS 실제 Host 프로세스의 Native RPC 진행 중 SIGKILL → 재접속 Kernel Attempt·외부 Writer 예약 복구 → 동일 Workspace 중복 실행 거부 → 다른 물리 Worktree 후속 Attempt 실행 1/1 PASS.** 기존 Native 명령의 최종 RPC 결과나 임의 OS 후손 종료를 되찾았다는 뜻은 아니다. **G0 PARTIAL / W1 DEFER.**

## 1. 목적과 기존 경계

[T30](W0_T30_NATIVE_PROOF_REPORT_SETTLEMENT_2026-11-04.md)에서는 실제 Native 명령 2개가 정상적으로 끝난 뒤 통합 검증→Owner CAS→Kernel Report/Proof를 정착하는 경로를 검증했다. 이번 단계는 **Host가 실제 RPC 응답을 받기 전에 사망한 경우**를 별도로 확인했다.

현행 코드는 두 종류의 권위를 가진다.

- Kernel의 **Run/Step/Attempt/Workspace ID**는 영속 Control Plane에 있다. 메모리상의 Native RPC 결과·프로세스 PID가 작업 완료 권위가 되는 구조가 아니다.
- `reserveHostWorkspaceWriter`는 Workspace의 **realpath SHA-256**으로 이름을 만든 Host 외부 `writer-*.json` 파일을 `open('wx')`로 생성한다. 같은 물리 Workspace는 동일 예약을 재발급받지 못한다. 이 파일은 TTL·PID 수명 증명이나 자동 Release 기능이 없다. 예약 디렉터리는 Writable Worktree 및 Sandbox 밖에 있어야 한다.
- `runHostOwnedWritableAttempt`는 Canonical Attempt와 물리 Worktree 소유권을 대조하고, Transport의 `runTurn` 안에서 Host 외부 예약을 얻은 다음 Native `turn/start`를 진행한다. **오래된 예약·불확실한 Worktree를 자동 재실행하지 않는다.**

**선택형 테스트 구현만 추가했다.** 제품 Native Transport, Kernel, Dispatcher, DB·Queue·Scheduler 및 별도 복구 영수증 상태는 변경하지 않았다.

## 2. 실제 Mac Native 실험 순서

- macOS, Node `v24.6.0`, Codex CLI `0.162.1`. 격리된 W0 `CODEX_HOME` 및 사용자 운영 Checkout과 분리된 임시 Git Owner/Kernel Runtime을 사용했다.
- `tests/helpers/native-host-disconnect-runner.ts`가 **별도 OS Host 프로세스**로 실행된다. 이 Host는 실제 제품 `reserveHostWorkspaceWriter`를 호출해 예약하고, 실제 Codex App Server JSON-RPC `command/exec`를 실행한다. 호출된 실제 Native 명령은 `workspaceWrite`, `writableRoots=[Attempt A]`, 네트워크 차단을 명시한다.
- Native 명령은 별도의 PGID를 가진 유한 Node Writer A를 시작하고 자신도 일정 시간 실행 중 상태로 남는다. Writer는 A Worktree에 append·fsync한다. 테스트는 Host PID, App Server PID, Native launcher PID, Writer PID, 첫 heartbeat 및 **단 한 번의 launcher 시작**을 관측한다.
- 실제 Host 프로세스가 살아 있고 원래 `command/exec` RPC가 아직 완료되지 않은 상태에서 **Host에 `SIGKILL`**을 보낸다. Host 메모리에 있던 RPC 결과는 없다. 그 후 Writer A의 파일 기록이 계속 증가하는지 검사한다.
- 테스트 전용 App Server PID만 확인해 `SIGTERM`으로 종료한다. **이후에도 Writer A가 기록을 이어가는지** 다시 검사한다. App Server 종료를 후손 Writer 종료로 오판하지 않는다.
- 기존 Kernel 인스턴스는 닫아 둔 상태였으며, 새로운 `createKernelControlPlane`이 동일 Runtime을 다시 연다. 원래 Run의 Mutation Revision, **A의 started 상태·Attempt ID·Workspace ID·Base Identity**, 기존 Host 외부 예약 파일 내용을 확인한다.
- 재접속 Host가 동일 A Workspace에 다시 `reserveHostWorkspaceWriter`를 시도하면 **`host_writer_workspace_already_reserved` 거부**를 확인한다. `runHostOwnedWritableAttempt`의 새 Native 공급자 시작 시도를 감지하는 Sentinel을 연결해 **실제 Provider 재실행 0건**을 확인한다. A의 Launcher 로그도 1건만 남는다.
- Host는 A를 Kernel 관점에서 실패 처리하되 **OS 종료라고 간주하지 않는다**. 별도 Canonical Attempt B를 발급하고, **새 Git Worktree·Workspace ID·별도 Host 예약**에 대해 실제 Codex `command/exec`를 실행한다. B 작업은 자신의 Worktree만 변경하며 Owner Git은 기존 내용, Mutation Revision 0을 유지한다.
- 테스트용 Writer A와 Launcher가 **유한 실행을 마치고 PID가 사라지고 240회 기록이 안정화된 뒤에만** 테스트가 생성한 A/B Worktree와 임시 디렉터리를 제거한다. 기존 W0 실측 Attempt나 불확실한 예약은 정리하지 않는다.

## 3. 실측 결과

실행: `W0_NATIVE_HOST_DISCONNECT_CONFORMANCE=1`, 격리 `CODEX_HOME`, `W0_CODEX_EXECUTABLE=/opt/homebrew/bin/codex`에서 macOS Native Host 테스트 실행.

| 검증 항목 | 결과 |
| --- | --- |
| 실제 별도 Host가 Writable 예약 후 Native 명령 실행 | PASS |
| Native `command/exec`가 완료되기 전 Host PID `SIGKILL` | **PASS** |
| Host 종료 뒤 A Writer가 append·fsync 계속 수행 | **PASS** |
| App Server 종료 뒤에도 A Writer 추가 기록 | **PASS** |
| 새로운 Kernel 인스턴스가 원래 A Attempt ID/Workspace ID 복원 | **PASS** |
| 원래 A의 Kernel 상태 | `started`, 실제 OS 실행 상태는 **unknown** |
| 기존 A 외부 Host 예약 파일·원본 IDs 정합 | PASS |
| 기존 A Workspace 예약 재시도 | `host_writer_workspace_already_reserved` |
| `runHostOwnedWritableAttempt`의 Provider 재시작 감시 | **0건 실행** |
| 기존 A Native Launcher 실행 횟수 | **1건** |
| 새로운 Canonical B의 다른 Git Worktree·Workspace ID·예약 | PASS |
| 실제 Native B 명령 | exit `0`, 자신의 `successor.txt=B_ONLY` |
| B 실행 시 A의 OS Writer 생존 | PASS |
| Owner 자동 변경·Report 승인 | **없음**, Mutation Revision `0` |
| 테스트용 유한 Writer A 정착 | **240회**, Launcher/Writer PID 부재·기록 안정화 뒤 삭제 |
| macOS Native 테스트 | **1 PASS / 0 FAIL / 0 SKIP**, 약 19.6초 |

Mac 실행 영수증 `operationId=513b90d5-0d3f-4a79-a768-e727201f1aab` (exit 0), 구조화된 결과 파일 `/tmp/moonrelay-w0-mac-real-attempt-Pg7Oqk/t31-native-host-test-2.log`에 Attempt/Workspace IDs, 재실행 건수, Reviewer/Owner 권위 부재·정착 조건을 보존했다. 이전 첫 실행 `operationId=45e35a4b-e60f-47f1-90c1-082dd554ff16`은 Mac 테스트 Entrypoint 파일 배치 누락으로 **실제 Host 실험을 시작하지 않았으며** 테스트 진입 파일을 보완한 뒤 같은 코드를 재실행했다.

## 4. 범위와 운영 판단

**확인된 것:** 실제 Host 프로세스 강제 종료와 App Server 종료가 발생한 뒤에도 Writer A는 살아 있었다. 새 Kernel은 A의 Canonical 정체성과 외부 Writer 예약을 복원할 수 있었으며, **이전 A를 다시 실행하지 않고** 새로운 물리 Worktree B를 예약해 진행했다. 이 과정에서 Native 명령의 시작 또는 성공이 Kernel Report/Owner CAS로 무단 승격되지 않았다.

**확인되지 않은 것:** Host가 상실한 **in-flight Native RPC의 원래 결과나 원래 Native Tool handle을 재연결해 조회한 것은 아니다.** PID·App Server 종료 상태·Writer 로그가 어떤 Native 모델 명령이라도 완전히 종료됐음을 증명하지 않는다. 임의의 Model Tool, 후손 Process Group 탈출, Host 클러스터 분산 재시작, 공유 파일시스템의 원자적 `open('wx')`, Linux/Windows OS confinement, T24 Goals/Dispatcher 중복 진입까지 일반화할 수 없다.

**중요한 경계:** 이 테스트에서 A의 Kernel 상태를 `failed`로 바꾼 것은 새로운 B Attempt를 발급하기 위한 **명시적인 테스트 동작**이다. A의 실제 OS Writer 종료가 확인됐다는 뜻이 아니다. 실제 운영에서 B 허용 여부는 새로운 B가 물리적으로 격리됐고 모든 Writable 경로가 실제 샌드박스·Owner CAS 권위를 지킨다는 검증이 필요하다.

## 5. Linux 격리 회귀 및 구조 검토

- Linux MCP `git archive` 격리 checkout에 테스트 두 개만 반영하여 별도 `npm ci --include=dev`, TypeScript `typecheck`, 제품 `build` 및 `build:tests`를 확인했다. 모두 **PASS**.
- 기존 Native Transport·Writer 예약을 포함한 집중 검증: **17건 중 16 PASS·1 macOS 전용 SKIP·0 FAIL**.
- Native/Owner/병렬 통합 확대 12개 Test Suite: **102건 중 96 PASS·6 OS 전용 SKIP·0 FAIL**.
- `check:boundaries`: **9 modules / 311 files / 849 dependency edges PASS**.
- 기존 제품 Native Transport·Kernel/Host/Dispatcher 및 사용자 설치 경로·운영 계정은 변경하지 않았다. 별도 테스트 Helper는 테스트 전용 컴파일 산출물만 사용한다. 새 Provider별 복구 폴백, DB 테이블, Watcher/Queue/Scheduler, 임의 규칙을 추가하지 않았다.

## 6. 적용·검증 파일과 다음 순서

- `tests/kernel-native-host-disconnect-recovery.test.ts` — 실제 Native Host SIGKILL 및 재접속 Kernel/예약/후속 Attempt 선택형 Mac conformance.
- `tests/helpers/native-host-disconnect-runner.ts` — 별도 Host 프로세스가 실제 제품 예약을 사용하는 Native 명령 실행기. 테스트 전용이며 운영 Runtime에 포함되지 않는다.
- macOS 전용 테스트는 명시적 플래그와 격리 `CODEX_HOME`이 없으면 SKIP한다. Linux 기본 테스트에 Native 모델 실행을 추가하지 않는다.
- 다음 단계는 **T24 Main/Goals/Dispatcher 중복 발급·중복 실행 경계**와 **실제 Native 모델 Tool의 무제한 OS 후손 수명 관리**를 점검한다. 이후에야 오래된 물리 Workspace 및 외부 Writer 예약의 안전 폐기 기준을 정할 수 있다.

**최종: T31 실제 Host 중단 안전 복구 수용 PASS(명시된 Mac 실험 범위), G0 PARTIAL / W1 DEFER.**
