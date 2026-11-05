# W0 T47 — Native Worktree OS 사용자 권한·Sandbox 지속 격리 실측

- 검증일: 2026-11-05 (KST)
- 기준: b42a4b542f9cb0539c63742510166d571905d6a3
- 판정: OS 권한·환경 비교 완료, **현재 Native 경로의 지속 쓰기 배타성은 미증명**
- 전체: **G0 PARTIAL / W1 DEFER**

## 배경

T44는 실제 macOS Native Sandbox에서 기존 외부 inode 하드링크가 사전 생성된 경우 외부 파일 100회 쓰기 우회를 확인했다. T45는 Git clean 및 같은 Attempt 재사용 검사가 동일 내용의 외부 하드링크를 발견하지 못함을 확인했다. T46은 같은 OS 계정의 비예약 외부 프로세스가 Worktree 생성 직후와 예약된 Writer 실행 도중 모두 파일을 바꿀 수 있지만, Kernel Writer Reservation 자체의 중복 수용 차단은 유지됨을 확인했다.

T47은 파일 검사나 더 많은 Kernel 예약 대신 **OS 사용자·파일시스템·Sandbox에 실제 지속 접근 차단 경계가 있는지** 검증한다. 실측은 격리된 임시 파일만 사용하고 사용자 Checkout·Codex 계정·제품 코드는 변경하지 않는다.

## 현행 코드/실행 환경

- physical-worktree.ts는 Git Worktree 생성과 HEAD/clean 검사를 수행하지만 별도 OS UID/마운트를 지정하지 않는다.
- host-owned-writable-attempt.ts는 현행 Host에서 Codex App Server를 생성하며 모든 Native 후손을 별도 OS UID로 강제하는 경로는 확인되지 않는다.
- workspace-writer-reservation은 협조적인 Host 간 중복 Writer 등록을 막는다. OS의 raw file write를 중재하지 않는다.
- macOS write-containment.ts의 Seatbelt는 실행된 Scoped Proof와 정책 상속 후손의 파일 쓰기를 제한한다. 비Sandbox 형제 프로세스에는 소급 적용되지 않는다.

## Linux 임시 파일 권한 실측

Linux MCP: WSL2 커널, 실행 UID 0. CAP_SYS_ADMIN이 없는 제한된 실행기다.

1. root가 생성한 임시 디렉터리의 소유자를 UID 65534로 변경하고, 디렉터리 700/파일 600을 설정했다.
2. 다른 비특권 UID 65533의 파일 쓰기는 Permission denied였다.
3. 소유 비특권 UID 65534는 디렉터리 권한을 000으로 바꾼 후 스스로 700으로 복구하고 파일을 쓸 수 있었다.
4. unshare -Ur 및 unshare -m 호출은 모두 Operation not permitted였다. setpriv로 비특권 UID 전환은 가능했다.

해석: 서로 다른 **비특권** UID 간 DAC 분리는 격리 후보이나, 동일 소유 UID의 chmod는 지속 쓰기 차단이 아니다. 실행기 root에는 DAC override 능력이 있으므로 해당 시험을 모든 권한 계층·보안 환경에 일반화하지 않는다. Namespace EPERM도 이 MCP 실행기의 관측값이지 모든 Linux의 미지원 증거는 아니다.

## 실제 macOS 임시 파일/Seatbelt 실측

macOS Native Host UID 501, 별도 임시 시험 경로만 사용.

1. 소유 디렉터리를 mode 000으로 변경하면 해당 UID Node 프로세스의 직접 쓰기가 EACCES로 거부됐다.
2. 같은 소유 UID가 chmod 700으로 복구하면 다시 파일을 쓸 수 있었다.
3. Seatbelt의 쓰기 허용 경로를 실제 canonical /private/tmp/.../allowed로 설정했다. Sandbox 내부 파일 쓰기는 허용되고 외부 파일 쓰기는 Operation not permitted로 거부됐다.
4. 동일 UID의 **Sandbox에 참여하지 않은** 별도 Node 프로세스는 동일 외부 파일을 수정했다.

최초에는 /tmp 논리 경로를 Seatbelt subpath로 지정해 내부 쓰기까지 차단됐고 명령이 실패했다. 이를 PASS로 처리하지 않았다. 실제 물리 경로로 수정한 후 내부 쓰기 허용과 외부 쓰기 거부를 확인했다.

## 실측 증거

| 증거 | operationId | 결과 |
| --- | --- | --- |
| Linux 환경·capability·namespace | dc7f6198-b3d6-42c6-adb6-c01aead69e52 | user/mount namespace EPERM |
| Linux 다른 UID DAC/소유 UID 권한 복구 | 68e0bcd9-6f30-4ab2-8720-e538f1f8aba0 | 다른 UID DENIED, 소유 UID 복구 PASS |
| macOS 동일 UID mode 000·복구 | 92a3f98e-080c-44d1-91aa-085416388bd9 | EACCES 후 chmod 복구 허용 |
| macOS 초기 논리 경로 실패 | 9f51da8d-0624-43a6-ae04-582c6be784b4 | 내부/외부 모두 거부, 성공으로 계산 안 함 |
| macOS 정규화된 Scoped Sandbox·비참여 형제 | 517ed810-66bb-42e5-935b-e760c80febf2 | Scoped 외부 DENIED, unconfined 형제 WRITE PASS |

## 구조적 결론과 다음 단계

**같은 OS UID의 Kernel 예약, chmod, 단발 inode 검사, Git clean 및 Fence는 외부 프로세스의 미래 쓰기를 차단하는 지속 권위가 아니다.** Scoped Sandbox는 참여 프로세스의 쓰기를 제약하지만, 기존 비참여 후손·형제를 자동으로 제약하지 않는다. 별도 비특권 UID 및 OS 파일 권한 분리는 가능한 대안이지만 현재 Native 실행 경로의 실제 지원·자격증명·Worktree 소유권·도구 프로세스 수명 계약까지 검증하지 않았다.

Linux/Windows OS 격리를 Mac Seatbelt 증거로 대체하지 않는다. 새로운 OS별 예외 처리, 재귀 파일 검증, DB, Queue, Scheduler, 감시/폴백을 제품에 추가하지 않았다.

다음 T48은 Native App Server와 모든 후손의 단일 OS 보안 도메인 실행이 가능한지를 구현 전 분석하고, 가능할 경우 실제 Runtime 분리·재연결을 제한된 Fixture로 증명해야 한다. 이를 입증하기 전에는 writerExitVerified:false, deliveryAuthorized:false, Native 자동 합류·예약 자동 해제 비활성을 유지한다.

**T47 OS 경계 실측 완료 / G0 PARTIAL / W1 DEFER.**
