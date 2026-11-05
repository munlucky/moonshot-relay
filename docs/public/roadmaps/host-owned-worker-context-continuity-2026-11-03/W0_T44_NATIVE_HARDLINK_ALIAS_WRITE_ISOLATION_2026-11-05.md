# W0 T44 — Native Sandbox 경로 별칭과 하드링크 외부 쓰기 반례

- 실측일: 2026-11-05 KST
- 기존 기준선: 015dc572421ca37a4ddc6d657e1c630beb325b4e
- 정식 테스트 커밋: d523893eb08e4af912009addfd9b7a5c1f6f88d5
- 전체 상태: **G0 PARTIAL / W1 DEFER**

## 목적

T39/T40은 실제 macOS Codex App Server command/exec가 App Server 종료 뒤에도 독립 Grandchild Writer를 남길 수 있고, OS workspaceWrite Sandbox가 새 물리 Worktree·Owner의 직접 쓰기를 차단하는 것을 검증했다. 이번에는 경로 별칭으로 **외부 inode**를 수정할 수 있는지 조사했다.

## A. 사전에 존재한 외부 하드링크 — 실제 격리 우회 확인

테스트 Host가 격리 시험 디렉터리 A 안에 외부 B 파일과 동일 inode를 공유하는 하드링크를 Sandbox 실행 전에 만들었다.

- macOS 시스템 sandbox-exec에서 A 내부 하드링크 쓰기가 허용돼 외부 B 내용이 HARDLINK로 변경됐다.
- **실제 Codex App Server direct command/exec**에서도 유한 Grandchild Writer가 해당 하드링크를 통해 외부 B 파일을 **100회 수정**했다. B 직접 쓰기와 Host 전용 디렉터리 직접 쓰기는 각각 100회 모두 거부됐고, 외부 심볼릭 링크 쓰기도 100회 모두 거부됐다.
- 외부 B 파일 원래 내용 B_ONLY가 ALIAS_WRITTEN으로 바뀌어, 원래 Native 시험이 **1 FAIL**을 기록했다. 이는 단순 테스트 오류가 아닌 **격리 한계 부정 증거**다. PASS로 소급 변경하지 않는다.
- Node Writer는 시험용 유한 100회 실행 뒤 스스로 종료했고, 조회 당시 Writer·Supervisor PID가 남아 있지 않았다. 시험 밖 사용자 파일·Owner Checkout·Codex 계정은 변경하지 않았다.
- 실측: macOS operationId df3cd6b4-5d1f-4278-a1ca-ab2a404b5c44; 결과·inode·PID 대조 operationId 37fbe92e-ec37-45e2-a6f8-c973478d5b83.

**중요:** 경로 기반 Sandbox는 외부 파일에 대한 직접 쓰기를 막더라도, **Sandbox 진입 전에 허용 경로에 이미 존재하는 하드링크의 외부 inode 변경**을 반드시 막지는 못한다.

## B. Sandbox 실행 중 새 하드링크 생성 — 거부 확인

- macOS 원시 Sandbox 안에서 외부 B를 가리키는 새 하드링크 생성 호출은 EPERM으로 거부됐다. B 내용은 유지됐다 (operationId 3d321787-466b-4593-97b5-31e9f04ff721).
- 실제 Native App Server command/exec의 분리 Grandchild Writer도 같은 신규 하드링크 생성 100회를 전부 거부했다.
- Native 실측에서 B 직접 쓰기 100/100 거부, Host 직접 쓰기 100/100 거부, 사전 존재 외부 심볼릭 링크 쓰기 100/100 거부, 외부 쓰기 허용 0이었다.
- 해당 시험은 Mac 격리 소스에서 1 PASS / 0 FAIL (operationId 4a94f6ae-edce-4f0b-a4b3-69e423981ad0).

따라서 **Sandbox 내부에서 새 외부 하드링크를 생성하지 못했다**는 사실과 **미리 존재하는 외부 하드링크를 쓸 수 있었다**는 사실을 구분해야 한다.

## C. 정상 Git Worktree 물리 파일 분리

macOS에서 임시 Git Owner 파일을 Commit하고 별도 Attempt·Recovery Git Worktree를 생성했다.

- Owner/Attempt/Recovery 같은 내용 파일은 동일 디바이스에서 서로 다른 세 inode를 가졌다.
- 세 파일의 링크 수는 각각 1이었다.
- 새 Git Checkout이 기존 Owner 파일의 하드링크를 그대로 가져오지 않는다는 **시험 범위**를 확인했다 (operationId 299dfc75-7907-43f4-a404-bf5796bc17a6).

추적되지 않은 파일이 외부 프로세스에 의해 사전 삽입되거나 작업 중 변조되는 경우, 다른 파일시스템 구현 및 임의 Native 명령 전체의 쓰기 권한은 검증 범위 밖이다.

## D. 정식 테스트 적용과 검증

기존 tests/kernel-native-sandbox-confinement.test.ts에 신규 외부 하드링크 생성·외부 심볼릭 링크 쓰기 거부 계측만 추가했다. 기존 실제 Native command/exec, App Server 종료, 독립 Supervisor/Grandchild, Local Writer 100회 및 Process 종료 검증을 재사용한다.

| 항목 | 실측 |
| --- | --- |
| macOS 실제 Native 시험 (d523893e) | **1 PASS / 0 FAIL / 0 SKIP** |
| 신규 외부 하드링크 생성 | **100 DENIED / 0 ALLOWED** |
| 외부 심볼릭 링크 쓰기 | **100 DENIED / 0 ALLOWED** |
| 외부 B/Host 직접 쓰기 | 각각 **100 DENIED / 0 ALLOWED** |
| macOS TypeScript·테스트 빌드 | PASS |
| macOS 모듈 경계 | 9 modules / 313 files / 855 edges PASS |
| Linux 격리 TypeScript·테스트 빌드 | PASS |
| Linux Native/Parallel 집중 | **7 PASS / 2 OS SKIP / 0 FAIL** |
| Linux 모듈 경계 | 9 modules / 313 files / 855 edges PASS |
| 사전 생성 외부 하드링크 | **100 ALLOWED / 외부 파일 변경 확인** |
| 임의 Native Writer 후손 전체 종료 | 미증명 |
| Native 자동 Owner Delivery | 비활성 |

정식 macOS 검증 operationId 12c73ce0-19c3-44c5-a74e-3dc981a3b41e; Linux 검증 operationId 93d534c6-b8b1-43a1-980b-5a2a54f95a27.

## 판정과 복잡도 관리

- 사전 존재 하드링크 음성 시험은 현재 Sandbox 한계를 보여주는 중요한 반례다. **일반적인 외부 쓰기 격리 PASS로 승격하지 않는다.**
- 동시에 새 Git Worktree 정상 생성에서는 Owner와 외부 inode 공유를 관측하지 않았고, Sandbox 내부의 새 외부 하드링크 생성은 거부됐다. 이 조건을 무시하고 전역 재귀 파일 스캔이나 새로운 DB/Queue/Scheduler/프로세스 감시 계층을 바로 추가하지 않는다.
- 제품 Dispatcher·Proof·Owner Fence, Native Writer 예약 자동 해제·재실행, 자동 Owner 정착 경로는 변경하지 않았다.
- 실제 Writer의 모든 임의 분리 후손 종료 및 미래 쓰기 가능성 제거는 미증명이다. writerExitVerified:false, deliveryAuthorized:false, 예약·Worktree 보존과 Native 자동 합류 비활성 상태를 유지한다.

**T44 제한된 OS 별칭 수용 검증 완료. 확인된 Sandbox 경계 한계와 남은 위험 때문에 전체 G0 PARTIAL / W1 DEFER 유지.**
