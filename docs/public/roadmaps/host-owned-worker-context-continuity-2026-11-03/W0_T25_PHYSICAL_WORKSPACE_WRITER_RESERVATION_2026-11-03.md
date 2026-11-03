# W0 T25 — 물리 Workspace Writer 중복 예약 실측과 신뢰 경계

- 검증: 2026-11-03 (KST)
- 기준: `main / f9a8f7635ae869cf199c65fc0c21f10b6b43ff3a`
- 변경: `src/host/kernel/workspace-writer-reservation.ts`, `tests/kernel-workspace-writer-reservation.test.ts` 및 W0 문서
- 판정: **같은 물리 Workspace를 공유하는 독립 Node Host 프로세스의 중복 Writer 예약은 거부 PASS(격리 Linux)**. 실제 기존 Kernel Mutation Lock의 TTL이 만료돼도 예약 파일은 유지되며, 다른 물리 Worktree는 독립 예약 가능. **실제 다른 OS 머신 간 공유 파일시스템·악의적 Worker의 예약 삭제 방지·생산 Host Dispatcher 강제 적용은 미검증/미구현. G0 PARTIAL / W1 DEFER.**

## 1. 최소 구현과 권위

`reserveHostWorkspaceWriter({ workspaceRoot, runId, attemptId, workspaceId })`는 **명시적으로 호출할 때만** 물리 Workspace에서 `realpath`를 해석한 후 `.moon-relay-host-writer-reservation` 파일을 `open('wx', 0o600)`으로 원자적으로 생성한다. 파일에는 기존 Canonical Run/Attempt/Workspace ID와 무작위 `reservationId`만 기록하고 fsync한다. 별도 DB·Worker Queue·Scheduler·TTL·Provider 분기·PID kill은 없다.

- 이미 예약 파일이 있으면 `host_writer_workspace_already_reserved`로 **거부**한다. 파일이 손상되거나 내용이 비어 있더라도 `EEXIST` 자체가 거부 근거다.
- 필수 소유권이 없으면 `host_writer_reservation_identity_missing`로 거부한다. 파일 생성 실패는 성공처럼 처리하지 않는다.
- 자동 만료, 무조건 해제, 다른 Writer에게 자동 인계하는 API를 만들지 않았다. Host 실패 또는 종료 불명확 시 예약 파일을 유지한다.
- 한 번 예약한 Worktree는 **single-use**로 취급한다. 기존 격리 Worktree의 물리 Writer와 후손에 대한 종료·격리 증명이 확보된 뒤에만 Worktree 전체를 정리해야 한다. 실제 Worktree 정리 시스템과의 통합은 이번 범위가 아니다.
- 기존 Kernel `acquireWorkspaceMutationLockV2`의 TTL/fencing 동작, Attempt 상태, Owner Delivery CAS, 현재 `createCodexAdapter` / `spawn_agent` 기본 실행은 변경하지 않았다.

**경계 제한:** 예약 파일은 Workspace 안에 있으므로 해당 경로를 쓸 수 있는 Worker가 파일을 삭제하는 공격이나 비협조적 Host가 API를 건너뛰는 경우까지 막지 못한다. 따라서 이것은 **공유 물리 경로를 사용하는 협력적 Host 간 원자적 admission guard**이지, Worker에 대한 강제 OS 권한 격리·보안 샌드박스가 아니다. Worktree 소유권 또는 sandbox가 예약 파일을 Worker에게서 보호하는 실제 정책을 확인하기 전에는 이를 최종 Writer fencing으로 사용하지 않는다. 비공유 파일시스템에서 서로 같은 논리 경로를 가리키는 서로 다른 호스트도 이 파일만으로 조정할 수 없다.

## 2. 실제 OS Writer 및 두 Host 역할 프로세스의 격리 검증

임시 Git Owner Workspace와 별도 `git worktree add --detach` Worker B를 만들었다. 새 Kernel Runtime의 `createKernelControlPlane`에서 Run과 `started` Attempt를 생성했다. A가 기존 Workspace Lock을 TTL 50ms로 획득한 후 **별도 Node OS Writer 프로세스**가 반복 append + fsync로 Owner의 파일을 갱신했다.

1. A Writer의 실제 파일 기록 4회 이상과 프로세스 생존 확인.
2. A의 Kernel Lock TTL이 지난 뒤 다른 `sessionToken`으로 **같은 Workspace Lock 재획득 성공**. 기존 `started` Attempt만으로 OS Writer 종료가 보장되지 않는다는 선행 반례 보존.
3. A가 쓰는 동안 **별도 Node 프로세스**를 Host B로 실행해 **같은 생산 예약 모듈**의 `reserveHostWorkspaceWriter` 호출. 예약 `EEXIST` → 거부 (종료 코드 29).
4. `../`를 포함한 같은 물리 디렉터리의 경로 별칭으로도 재시도 → 동일 거부.
5. B 거부 뒤 A 기록이 계속 증가하는지 확인. 예약은 기존 A의 파일 쓰기를 종료시키지 않고, **두 번째 협력적 Writer의 admission만 차단**한다.
6. **다른 물리 Worktree B**는 신규 예약 성공. 같은 B Worktree 재예약은 다시 거부.
7. 별도 fixture에서 이전 Host가 종료·실종돼도 예약 파일이 남는 상태를 재조회. 새 Host 프로세스 및 같은 프로세스 재예약 모두 거부.
8. 격리 Writer 종료·임시 Git Worktree/Runtime/예약 파일 전체 삭제. 실제 사용자 Workspace·Codex 세션 무변경.

| 검증 | 결과 |
| --- | --- |
| A 실제 OS Writer 생존 및 파일 append/fsync | PASS |
| 기존 Workspace Lock TTL 만료 후 다른 session 재획득 | **허용**, 선행 위험 재현 |
| Host B의 **같은 물리 Workspace** 원자적 예약 | **거부 PASS** |
| 경로 별칭을 통한 예약 우회 시도 | 거부 PASS |
| 별도 물리 Git Worktree 예약 | 허용 PASS |
| B Worktree 재예약 및 죽은 Host의 예약 유실/자동 만료 | **재예약 거부 PASS** |
| 실제 서로 다른 OS 머신·공유 네트워크 FS 원자성 | **NOT TESTED** |
| Writer가 예약 파일을 삭제할 수 없는 강제 접근 제어 | **NOT IMPLEMENTED** |
| App Server/Kernel Dispatch 자동 적용, 물리 OS Writer 종료 | **NOT IMPLEMENTED / NOT VERIFIED** |

## 3. 독립 검증

기존 Linux 원본 `node_modules`는 수정하지 않고 `git archive HEAD`와 신규 소스/테스트를 임시 `/tmp` checkout에 복사해 개발 의존성을 설치했다. **초기 테스트의 실패는 새 테스트 subprocess가 생성 Runtime 경로를 잘못 불러온 문제**였고, 생성된 `scripts/host/kernel` 모듈을 실제 서브프로세스에서 호출하도록 수정한 후 재검증했다.

- TypeScript typecheck, 정규 Runtime build, tests build: **PASS**
- Host Writer/기존 App Server/Owner Fencing 집중 검사: **17/17 PASS**
- Native Dispatcher·Codex Adapter·Workspace Lock 포함 확장 회귀: **64/64 PASS**
- `check:boundaries`: **PASS** (9 modules / 310 files / 844 edges)
- 주요 MCP 영수증: 초안 컴파일/실패 재현 `b10c1b29-4c98-4fb7-98a0-09a3f80196b7`, 수정 집중 PASS `d4c9d9d6-f65e-4f3c-83e6-78ad74d21f45`, 확장 회귀·경계 PASS `e73052fd-5bd4-4efe-93ed-a95e264df7c9`.
- 독립 Mac 실제 Codex 모델 Turn/읽기 전용 명령 이벤트 실측은 [이전 검증](W0_T25_REAL_MODEL_AND_KERNEL_ATTEMPT_LINK_2026-11-03.md)에서 PASS했으며 이번 Writer 중복 예약의 실행 주체는 **Linux MCP 격리 OS 프로세스**였다. Mac Native 실제 Worker와 이번 예약 모듈을 결합한 테스트는 없다.

## 4. 다음 작업과 G0 수용 경계

- **실제 Host-managed Writable Worker에 한해** Workspace 예약의 원자적 생성, Kernel Canonical Attempt 매핑, 실제 Native Transport 실행 시작을 하나의 Host 경계로 묶는다. 현재는 독립된 **선택형 예약 API**이며 자동으로 Writer의 모든 실행 진입을 막지 않는다.
- Worker가 예약을 삭제하지 못하도록 Host 전용 보호 영역/OS 권한/읽기 가능한 기존 커널 조정 경계 중 가장 단순한 것을 검증해야 한다. 단순 Workspace 안의 파일만으로는 강제 격리를 주장하지 않는다. 검증하기 전에는 새 Writable Worker가 Owner에 직접 쓰도록 허용하면 안 된다.
- 종료 RPC 성공·Turn completed·App Server exited·OS child exited·후손/쓰기 정착은 각각 별도 사건이다. **기존 Writer의 실제 종료 증거가 없다면 동일 물리 Workspace를 다시 허가하지 않는다.** 새 Worktree에서 별도 B를 준비한 후 Owner 반영은 기존 Mutation Fence/Revision/CAS를 반드시 통과시킨다.
- Host가 서로 다른 실제 머신인 경우 물리 경로·공유 파일시스템·원자적 생성의 범위를 측정한다. 검증하지 않은 네트워크/분산 파일시스템 보장은 추가하지 않는다.
- 기존 Workspace Lock TTL을 늘리는 방법이나 Attempt status만으로 문제를 해결하지 않는다. 새로운 DB/Queue/별도 완료 권위·Provider별 폴백을 도입하지 않는다.

**G0 = PARTIAL / W1 = DEFER**. 이번 PASS는 **협력적 다중 프로세스 예약 경쟁의 차단**이다. 전역 Host Writer 권한과 물리 OS 종료의 종단간 수용 PASS가 아니다.
