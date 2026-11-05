# W0 T45 — Git clean Native Worktree의 외부 inode 별칭·재사용 경계

- 실측일: 2026-11-05 (KST)
- 기준 커밋: 682a8082b70b56278842b87fbb3620f9b7cd7cef
- 테스트 커밋: f4517b71cd5a1afa80f9829b83db1464de397b53
- 범위 판정: **Git clean·동일 Attempt 재사용에서 하드링크 외부 inode 비검출을 검증**
- 전체 판정: **G0 PARTIAL / W1 DEFER**

## 선행 근거 및 목적

T44의 실제 Mac Codex App Server workspaceWrite 시험에서는 Sandbox 진입 전에 이미 존재한 외부 파일 하드링크를 통해 외부 B 파일을 100회 수정했다. Sandbox 바깥 경로 직접 쓰기, 외부 심볼릭 링크 쓰기, Sandbox 내부의 신규 외부 하드링크 생성은 거부됐다.

T45의 질문은 실제 Host Writer Attempt Worktree가 새로 만들어지거나 같은 Attempt 경로에서 재사용될 때, Git HEAD·clean 상태 검증이 외부 inode 별칭까지 판단하는지 여부다.

## 기존 코드의 신뢰 경계

- prepareHostWriterAttemptWorktree는 Attempt마다 결정적인 경로를 사용한다.
- 신규 경로에는 Git worktree add --detach를 사용한다. 정상 Checkout은 별도 inode를 갖는다는 T44 실측이 있다.
- 기존 동일 Attempt Worktree를 재사용할 때 reuseWorktree는 inspectGitWorkspace의 HEAD 및 git status clean만 확인한다.
- reserveHostWorkspaceWriter는 외부 파일 Reservation 마커로 같은 물리 Worktree의 Writer 중복 실행을 차단한다. 이는 inode 연결 검사와 서로 다른 역할이다.
- 부모 App Server/RPC 종료는 분리된 Native 후손 Writer 종료 증명이 아니다.

## T45 유한 반례

기존 tests/kernel-workspace-writer-reservation.test.ts에 실제 두 생산 Worktree 함수를 사용하는 새 시험을 추가했다.

1. 격리 임시 Owner Git Repo에 tracked.txt를 Commit하고 prepareHostWriterAttemptWorktree로 최초 Attempt를 생성한다.
2. 새 Attempt 추적 파일과 Owner 추적 파일 inode가 서로 다름을 확인한다. 새 Worktree는 reused:false다.
3. Sandbox 바깥 시험 Host가 Attempt 추적 파일을 제거하고, 내용이 **완전히 동일한** Owner 추적 파일을 가리키는 하드링크로 교체한다. 양쪽 inode는 같고 nlink는 2 이상이다.
4. 기존 inspectGitWorkspace는 여전히 ready:true를 반환한다. Git HEAD·clean 검사가 파일 내용만 보고 외부 inode 공유를 놓친다.
5. 기존 prepareHostWriterAttemptWorktree는 같은 Attempt 경로를 reused:true로 반환한다.
6. Attempt 내부 추적 파일에 쓰면 Owner 추적 파일도 변한다.
7. 변조 뒤 Git 검사에서는 ready:false가 반환된다. 이는 **사후 드리프트 탐지**일 뿐 앞선 외부 Owner 데이터 변경의 방지는 아니다.
8. 시험이 소유한 Attempt는 유한 범위에서 삭제한다. 기존 사용자/Native 세션·Owner 작업 데이터는 변경하지 않는다.

## 검증

| 검증 | 결과 |
| --- | --- |
| Linux 격리 Clone TypeScript / 테스트 빌드 | PASS |
| Linux 기존 Writer 예약 + T45 반례 집중 | 5 PASS / 0 FAIL |
| 실제 Mac 격리 Clone TypeScript / 테스트 빌드 | PASS |
| 실제 Mac 기존 Writer 예약 + T45 반례 집중 | 5 PASS / 0 FAIL / 0 SKIP |
| Mac module boundary | 9 modules / 313 files / 855 edges PASS |
| Linux Writer 예약·Recovery·Fence 확대 회귀 | **10 PASS / 1 OS SKIP / 0 FAIL** |
| Native Writer 모든 임의 후손 종료 | 미증명 |
| Native 자동 합류 / Writer 예약 해제 | 비활성 |

Linux 집중·빌드 operationId b15b11c7-8a52-4422-862c-57462c050a90.
Linux 주변 확대 회귀 10 PASS/1 OS SKIP 및 경계 operationId 41e8b929-eb22-4e46-b8f3-0582f6e950a7.
실제 Mac 전체 집중·타입/테스트 빌드·경계 operationId e6970182-2bf3-45ab-86be-a992ea01e9a0.

## 해석·변경 판단

이번 반례는 **재사용 Worktree의 Git clean 상태가 외부 inode 별칭 비존재의 물리 증거가 아니라는 것**을 보여준다.

T45가 기존 외부 Writer Reservation까지 우회했다는 뜻은 아니다. 현재 같은 물리 Worktree로 두 번째 Native Writer를 실행하는 것은 Reservation이 차단한다. T44에서 실제 Codex Native Sandbox의 사전 생성 하드링크 쓰기가 허용된 점과 T45의 Git clean 재사용 비검출을 결합하면, 별칭이 유입된 경우 **Git 상태로 보호를 대체할 수 없다는 구조적 위험**이 확인된다.

이번에는 제품 코드를 변경하지 않았다. 우선 새 Git Worktree 기본 물리화 및 기존 Reservation을 유지한다. 외부 프로세스가 단발 검사가 끝난 직후 Worktree 파일을 바꾸는 TOCTOU가 남으므로, 모든 파일을 재귀 검사하거나 링크 수만 확인하는 기능을 곧바로 Native 자동 합류의 완전한 증거로 삼지 않는다. 정책·폴백·DB·Queue·Scheduler·PID 감시 계층도 추가하지 않는다.

다음에는 Runtime/Attempt Worktree에 **외부 쓰기 주체가 준비 후에도 접근 가능한 권한 구조**를 조사하고, 실행 중 Path/FS 권한을 실제로 배타적으로 확보할 수 있는지 검증해야 한다. 일반 Native 후손의 종료 또는 OS 차원의 쓰기 제외가 증명되기 전까지 writerExitVerified:false, deliveryAuthorized:false, 예약·Worktree 보존, Native 자동 합류 비활성을 유지한다.

**T45 제한된 재사용·inode 반례 완료 / 전체 G0 PARTIAL · W1 DEFER.**
