# W0 T33 — Native App Server process group 전체 종료의 후손 Writer 누락 반례

- 작성: 2026-11-04
- 기준선: `main / 9ef7f3c0c7e6bb5946c0424bfc2bb4b64ad2bf53`
- 범위: 기존 선택형 macOS `tests/kernel-native-sandbox-confinement.test.ts` 실측만 확장. **제품 OS 종료 정책, Native 자동 예약 해제, Provider/Dispatcher, DB/Queue/Scheduler 변경 없음**.
- 판정: **직접 소유한 App Server의 OS process group 전체 종료만으로는 분리된 Writer의 수명 종료를 증명하지 못한다.** 기존 Mac 샌드박스 쓰기 격리와 별도로 확인한다. 임의 Writer/후손 전체 종료 `NOT VERIFIED`; **G0 PARTIAL / W1 DEFER**.

## 기존 증거와 신규 질문

[T27](W0_T27_NATIVE_DESCENDANT_SURVIVAL_AND_RETIREMENT_GATES_2026-11-04.md)에서는 App Server 프로세스 자체가 종료된 뒤 별도 PGID Writer의 파일 쓰기가 지속되는 것을 확인했다. [T28](W0_T28_NATIVE_DETACHED_WRITE_CONFINEMENT_2026-11-04.md)에서는 해당 Writer가 자기 Attempt 디렉터리에서는 쓰되 B/Host 테스트 센티널을 변경할 수 없음을 확인했다. [T29](W0_T29_CANONICAL_AB_NATIVE_OWNER_CAS_2026-11-04.md)는 실제 Kernel Attempt A/B 별도 물리 Worktree와 Owner CAS를 검증했으므로 이번에 반복하지 않는다.

이번 질문은 **App Server PID만 종료하는 것과 달리, Host가 정확하게 소유한 App Server의 전체 POSIX process group에 SIGTERM을 보내도 Writer가 살아남는가?** 이다. 성공이면 단순 `killpg(serverPgid)` 방식은 일반적인 Native Writer 전체 종료 확인에 사용할 수 없다는 음성 증거가 된다.

## 시험 방법과 통제 범위

- Mac 전용 명시적 테스트 환경: `W0_NATIVE_SANDBOX_CONFORMANCE=1`, 격리된 `CODEX_HOME`, Node의 `codex app-server` 명령과 모델을 호출하지 않는 직접 `command/exec` 테스트. 운영 Source/DB/세션에 쓰지 않는다.
- 테스트 자체가 시작한 App Server만 `detached: true`로 실행해 **독립 process group**을 만든다. 실제 OS `/bin/ps`로 `serverPid === serverPgid`임을 시작 시점과 Signal 직전에 확인한다. 다른 프로세스 그룹이나 PID 파일의 임의 PID에는 신호를 보내지 않는다.
- 기존 100회로 수명이 제한된 test-only Node Writer가 별도 `detached: true` 그룹(`writerPgid === writerPid`, `writerPgid !== serverPgid`)에 속함을 실측한다.
- `command/exec`가 성공한 뒤 App Server 그룹에 SIGTERM을 보내고, 종료가 지연되면 **정확히 해당 시험 그룹**에 SIGKILL을 보낸다. App Server의 OS exit 이벤트를 확인한다.
- App Server 그룹 종료 직후와 짧은 추가 구간에 Writer 자체 heartbeat가 계속 증가하는지 확인한다. Writer가 B의 파일 및 Host 예약 **시험 센티널**을 수정하는 시도는 기존 Native `workspaceWrite` 정책으로 각각 100회 모두 거부돼야 한다.
- 해당 Writer는 테스트 명령에 명시된 유한 루프를 스스로 마친다. 기록 100건 정착 및 해당 OS PID 부재까지 확인한 경우에만 테스트가 생성한 임시 파일을 제거한다. 종료가 확인되지 않으면 파일을 보존한다.

## 수용·비수용 기준

| 구분 | 해석 |
| --- | --- |
| App Server가 실제 별도 PGID이며 신호 후 종료 | **직접 소유한 App Server 그룹 수명** 수용 |
| Writer 별도 PGID로 분리 후 App Server 그룹 종료에도 쓰기 지속 | **`killpg` 전체 Worker 종료 가설 반박** |
| Writer의 A 내부 쓰기는 진행, B/Host 외부 쓰기는 차단 | **해당 Mac Sandbox 경계 실측** 재확인 |
| Writer 자체 유한 종료·추가 쓰기 정착·PID 부재 | **해당 시험 Writer만** 테스트 후 안전 정리 |
| 실제 모델 Tool의 임의 OS 후손 전체 종료, 운영 예약 자동 해제 | **미검증 / 허용하지 않음** |

Linux MCP는 cgroup v2가 쓰기 불가능한 기존 환경이다. Linux에서 본 macOS 테스트는 의도대로 SKIP이다. Mac의 `launchctl`·`sandbox-exec` 명령 존재를 해당 API가 모든 Worker 후손의 강제 종료를 제공한다는 의미로 오인하지 않는다.

## 검증 결과

- Linux 격리 TypeScript 7·제품 빌드·테스트 빌드 PASS, 집중 **14 PASS / 4 OS SKIP / 0 FAIL**, 경계 **9 modules / 311 files / 849 edges PASS** (`operationId=326ead21-b4d6-4fc7-a91a-515988c96141`). Mac 전용 실측은 Linux에서 SKIP으로 남기며 성공으로 승격하지 않는다.
- **Mac 실제 POSIX process group 수명 검증 1 PASS / 0 FAIL / 0 SKIP**: macOS Darwin 25.5.0, Node v24.6.0, Codex CLI 0.162.1, 동일 Git 소스 `7e9aad28b2edecef132de815301d527c6b1fdaca`. 격리 `CODEX_HOME`, TypeScript·제품·테스트 빌드 PASS. 직접 생성한 App Server PGID `26167`의 전체 그룹 종료를 OS에 요청하고 App Server exit를 확인한 뒤에도 Writer PID/PGID `26173` (PPID 1)는 별도 그룹에서 살아 자기 작업 파일에 쓰기를 지속했다. 유한 루프 **100회 기록**, 다른 B 및 Host 테스트 경로 쓰기 **각 100회 거부·허용 0건**, Writer 자체 수명 종료 뒤 PID 부재와 로그 정착 확인. `writerExitVerifiedForArbitraryTurn=false` 유지. 실행 `operationId=4632e1eb-2099-41e5-abd3-9bef6871c44a`, 원본 관측값 재검사 `operationId=9acb2d7a-33cf-4b1b-9608-00eb7d3c7ce0`.

Mac 시험의 Writer와 자체 PGID는 단 하나의 테스트 생성 경로에 대해서만 식별했고, 종료 신호를 이 Writer 그룹에 보내지 않았다. 따라서 **App Server 전체 group 종료의 효과가 Writer에게 도달하지 않았다는 반례**이며, 모든 process group 수거의 가능성을 증명한 것이 아니다. 시험용 Worktree와 빈 `CODEX_HOME`은 시험 Writer의 유한 종료 및 검증 후에만 제거했다(`operationId=e7d0e317-1c61-48a6-a4f8-789e9eec713e`). 원본 Mac checkout 및 실제 사용자 Codex 세션은 변경하지 않았다.

## 다음 작업

종료를 확인할 수 없는 임의 Native Writer의 예약/Attempt Worktree는 보존한다. 단순 PID/PGID/Turn 완료로 Writer 종료 영수증을 생성하지 않는다. Host가 프로세스 그룹 이탈을 방지하는 OS 강제 containment를 실제로 제공하는지 확인하거나, 안전한 쓰기 범위가 검증된 별도 Worktree로 새 Attempt를 진행하는 기존 방식을 유지한다. **통합 Proof 이전의 Owner Fence 획득·유효기간 유지·동시 복구/만료 반례와 Canonical 결과 자동 합류는 별도 다음 게이트**이며, 물리 종료 증거 없이 제품 자동화는 켜지 않는다.
