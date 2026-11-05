# T50 — Native OS 쓰기 격리 실행 가능성 실측 및 수용 결정

- 실행 날짜: 2026-11-05 (KST)
- 기준: `main c03867a0723aa32c2aae23842c8a11c2d4458e47` (작업 시작 시), Linux WSL2 6.18.54.1 / root, Mac MCP 기존 체크포인트 rev 48
- 원본 계약: [VERIFICATION](VERIFICATION.md) I01~I12·T25/T26·G0~G6, [T49 결정](T49_DECISION.md), [T49 최종 수용](T49_FINAL_ACCEPTANCE.md)
- 결과: **실측 가능한 유한 DAC 경계 PASS / 실제 Native App Server·Tool 보안 경계 DEFER / 최종 `HOLD_SAFE`**
- 모든 파일·프로세스 시험은 독립 `/tmp/t50-*` 아래에 격리. 사용자 CODEX_HOME, 실제 인증, Git/DB/Run/예약 및 Owner 작업환경을 시험 대상으로 사용하지 않음

## 1. 환경과 음성 capability 관측

| 항목 | 이번 실측 | 수용 경계 |
| --- | --- | --- |
| Linux WSL2 `unshare -Ur true` | `Operation not permitted`, exit 1 | 현 MCP에서 unprivileged user namespace 불가. namespace 기반 Worker 보호 PASS 불가 |
| `/sys/fs/cgroup` | 현 컨텍스트 쓰기 불가 | cgroup 관리 하위 트리/종료 증명 불가. 기존 후손 종료 증명에 전용 금지 |
| `id` / Owner checkout | UID 0(root), 저장소 및 `.git` 디렉터리 `777` | **현 checkout은 Owner 보호 디렉터리가 아님**. 프로덕션 수준 격리 PASS 불가 |
| OS 저권한 프로세스 | `setpriv` 및 `runuser` 사용 가능 | 자격증명 없는 독립 UID 파일 접근 검증에 한정 |
| macOS `executionTarget=host` | 명령 exit 0, stdout/stderr 0바이트 | `uname` 등의 실행 확인 불가. macOS Native PASS로 해석하지 않음 |
| Windows Native | 지원되는 실행 연결/결과 없음 | DEFER. WSL2 Linux 증거를 Windows Native로 전용하지 않음 |

## 2. Linux 독립 UID/FS 능동 시험

격리 Fixture: `mktemp -d /tmp/t50-uid-proof.*`, Owner root:root `0700`, Owner 파일 `0600`, Worker UID/GID 65534 전용 디렉터리 `0700`. Worker는 `setpriv --reuid=65534 --regid=65534 --clear-groups`로 실행. 기존 Owner inode를 Worker Worktree에 하드링크한 반례까지 포함.

| 공격/정상 동작 | 관측 결과 |
| --- | --- |
| Worker → Owner 직접 append | `EACCES (13)`, 차단 |
| Worker → Owner 심볼릭 링크 append | `EACCES (13)`, 차단 |
| 사전 생성 Owner inode 하드링크 append | `EACCES (13)`, 차단 |
| Worker → 자신의 디렉터리 결과 쓰기 | 성공 |
| 소유권 높은 root 기존 프로세스 → Owner | 여전히 쓰기 가능, 보안 경계 밖 |

다른 임시 Fixture에서 저권한 Worker가 새 세션으로 분리 손자를 생성하고 부모가 종료된 뒤 손자가 Owner `future.txt`에 늦은 append를 시도했다. `DENIED:13`, Owner 파일 내용 `secure` 유지. 손자의 `PPID=1`, 독립 PGID가 확인됐고 최종 관측 시 zombie 상태로 종료돼 있었다. **유한 저권한 반례 1회 성공이지 모든 임의 후손 종료 증명은 아니다.**

임시 Fixture는 명령의 cleanup trap으로 회수했다. 제품/사용자 Worktree, DB, Native 예약, 인증 자료는 변경하지 않았다.

## 3. 실행 경계 아키텍처 결정

요구 불변식은 **프로세스 종료 여부의 추정이 아니라 이전 Writer가 새 Owner와 이후 mutation scope를 실제로 변경하지 못한다는 것**이다. 범용 PIDs/PGID/Process Group만으로 이를 충족하지 못한다.

1. Host/Owner의 권한은 Worker의 권한보다 커야 한다. Owner와 통합·Proof·CAS 작업 위치는 Worker가 파일 직접 쓰기, 링크 우회, chmod 복구, 객체 변경으로 침범할 수 없는 **OS 권한 영역**이어야 한다.
2. 별도 UID/보안 주체의 Worker는 **새로 생성한 별도 파일 객체의 Worktree**에만 쓰도록 한다. Worker와 Owner 또는 다른 세대 Worktree 사이에 기존 hardlink inode, 공유 writable mount, 열려 있는 공유 FD가 없어야 한다.
3. 실제 Codex App Server뿐 아니라 그가 생성한 **모델 Tool, Shell, 손자/분리 후손 모두 같은 낮은 권한**으로 실행해야 한다. Host가 Worker의 모델 Turn 종료만 확인하는 것은 불충분하다.
4. Worker 결과는 Host 권한으로 접근 가능한 **별도 불변 후보 영역**에 원본 바이트·Git object·Receipt 범위를 검증하면서 취득한다. 복사/증명/Owner 정착 중 Worker의 원본 변경과 새 파일 쓰기 레이스, 기존 FD, alias를 반례로 시험해야 한다. Owner Proof와 CAS는 기존 Kernel 권위만 사용한다.
5. 사용자의 일반 계정에서 권한 분리·파일 소유권을 실현할 수 없다면 임의 권한 상승 서비스/폴백을 몰래 만드는 대신 **선택형 기능 미지원**으로 판정한다. 검증된 OS 경계 없는 환경에서는 `writerExitVerified:false`, `deliveryAuthorized:false`와 Native 자동 재합류 차단 유지.

### 플랫폼별 구현 후보 — 검증 전 미채택

| 플랫폼 | 가장 작은 검증 후보 | 배제해야 할 반례 / 조건 |
| --- | --- | --- |
| Linux | 별도 UID/GID, Owner 전용 디렉터리, 실제 App Server 최초 spawn부터 권한 강등, 상호 공유 inode 없음 | Worker 하위 전 프로세스 UID 상속, fd/link/mount, 외부 동등 UID Writer, root/privilege capability, immutable snapshot 검증. 현재 WSL checkout 777은 미적합 |
| macOS | 실제 별도 macOS 계정 권한 + 소유권 보호를 전제로 Seatbelt 범위 보조 사용 | 기존 T44 사전 hardlink 100/100, 같은 UID 비Sandbox 형제, 실제 모델 Tool 후손, 인증 분리. Seatbelt 단독은 기각 |
| Windows | 격리 사용자/Restricted Token 또는 AppContainer + 파일 DACL, Job Object는 종료 수명 보조로만 | DACL과 공유 파일 객체, 실제 Tool 권한 상속, Job 이탈/분리, native host 실행 증명 필요. Linux 결과로 승격 금지 |

## 4. G0~G6 / P3~P5 결론

| Gate | 지금 판정 | 다음 허용 조건 |
| --- | --- | --- |
| G0 | **PARTIAL** | 실제 Native App Server·Tool 전체 권한 상속·보호 OS 경계와 Context/원본 계약 실증 |
| G1 | **DEFER** | Worker old/new 동일 mutation scope 동시 쓰기 물리 배제, 정확한 복구 조건 |
| G2–G4 | **DEFER** | G1을 통과한 Host의 실제 Main 재접속, 승인/취소, Loop/Context 수용 |
| G5 | **PARTIAL** | Linux 유한 Kernel 복구 12 PASS/0 FAIL/2 macOS SKIP 유지, Native 후손/쓰기 공격 검증 필요 |
| G6 | **NOT_RUN** | G0/G1 안전 경계 통과 후 같은 모델/조건 A/B/E/C/D 성능·품질 실측 |

- P2 결정 **`HOLD_SAFE` 유지**. 이번 유한 DAC PASS는 새로운 Native App Server/Tool 격리 PASS가 아니다.
- P3 제품 구현/Owner 자동 합류/예약 자동 해제는 **미승인**, Runtime 코드 변경 없음.
- P4 실제 Native Tool+후손+공유 inode+old Writer 적대 시험은 **DEFER**.
- P5 전체 제품 채택/성능 수치 없음. 제한된 시험 결과를 G6로 승격하지 않는다.
- 추가 상시 Worker 감시자, 별도 DB/Queue/Scheduler, Provider별 폴백을 도입하지 않는다.
- 위 기준이 실증되는 Native 실행 환경/권한을 확보한 경우에만 **기존 App Server 시작 경계에 최소한의 권한 격리를 결합**하고, A~E 원본 계약을 재검증한다. 추가 T번호를 계속 늘리기보다 이 문서의 Gate를 갱신한다.

## 5. 실행 참조

- Linux 환경/Namespace/cgroup/checkout: operation `f25b6e51-290e-4d66-a373-6e8c628b30d5` (exit 0, 내부 namespace 시도 exit 1).
- Linux OS reservation/Host 코드 점검: `d10a4519-9f75-45ad-9555-22f52d1b41d9` (exit 0).
- 독립 UID/직접·symlink·하드링크 반례: `c1a61763-6dbd-45ce-9158-1a4718d6b51c` (exit 0).
- 분리 저권한 후손 late-write 반례: `668642b9-6df5-49fa-aadf-5d289fe58789` (exit 0).
- Mac Native Host 관측: `a5e028f4-82cd-475d-bb95-a75b370b2e7a` (exit 0 / 출력 없음 → Native 판정 DEFER).

**최종:** 이번 환경의 지원 가능한 증거 범위까지 검증 완료. 제품 자동 합류는 승인 조건을 충족하지 못해 HOLD_SAFE로 명시적 종결한다. 권한 경계가 준비되지 않는 한 새 규칙/임시 폴백을 통한 우회 구현은 진행하지 않는다.
