# W0 T48 — 실제 Native Codex App Server OS 격리 도메인 초기화 가능성

- 검증일: 2026-11-05 (KST)
- 기준 main: be4c473a27112b2d545d3fa6f18b318a634ae521
- 범위: Native 실행 소스 정독, 실제 macOS App Server의 별도 CODEX_HOME 및 Scoped Seatbelt initialize RPC
- 판정: **App Server 프로세스 격리 초기화 성공 / 모델 Turn 및 모든 임의 후손 종료·미래 쓰기 격리 미증명**
- 전체: **G0 PARTIAL / W1 DEFER**

## 선행 범위

T39/T40은 Mac Native App Server 종료 후에도 독립된 손자 Writer가 쓰는 상태를 실측했다. T44는 Sandbox 전에 만들어진 외부 inode 하드링크가 Mac Native scope 안에서 외부 파일을 바꾸는 반례였다. T45/T46에서는 Git clean 및 Kernel 예약을 유지해도 같은 UID 외부 프로세스가 Worktree를 바꿀 수 있음을 증명했다. T47은 chmod-only와 부분적 Seatbelt로 기존 비참여 OS Writer를 제한할 수 없음을 확인했다.

## 실제 제품 실행 계약

- src/host/kernel/host-owned-writable-attempt.ts: canonical Attempt 검증 및 실제 Worktree 준비 뒤 createCodexAppServerTransport를 호출한다.
- src/host/kernel/codex-app-server-transport.ts: spawn('codex',['app-server'],{cwd,env,stdio,shell:false})로 단일 App Server 프로세스를 시작한다. 별도 UID 전환, mount/user namespace, 전체 후손 OS 집합을 소유하는 방식은 현재 사용하지 않는다.
- thread/start 및 turn/start는 workspace-write/workspaceWrite(writableRoots=[workspace],networkAccess=false) RPC 정책을 지정한다. 이는 App Server 전체의 OS 시작 경계가 아니라 Turn-level 정책이다.
- close()는 App Server 부모 하나만 종료시키며, 모든 도구 후손의 종료는 증명하지 않는다. writerExitVerified는 항상 false다.
- 기존 Host Writer Reservation은 협조적인 Host 중복 실행을 거부하지만 같은 UID 외부 프로세스의 raw 파일 쓰기는 중재하지 않는다.

## 실제 macOS Codex App Server 초기화

실제 설치된 Codex App Server 0.162.1, macOS UID 501에서 실시했다. 기존 사용자 Codex Home이나 계정 파일을 수정하지 않고 /tmp/t48-native-envelope-*에 임시 HOME/CODEX_HOME 및 Workspace를 생성했다. 모델 Turn과 도구 실행은 수행하지 않고 JSON-RPC initialize만 보냈다.

| 조건 | 결과 |
| --- | --- |
| 별도 CODEX_HOME 일반 app-server initialize | **정상 JSON-RPC 응답** |
| 처음 논리 /tmp 경로로 지정한 Seatbelt | **exit 1 실패**, PASS 아님 |
| 실제 /private/tmp canonical 쓰기 scope로 지정한 Seatbelt로 실제 app-server initialize | **정상 JSON-RPC 응답** |
| Scoped Seatbelt 안의 시험용 내부 파일 쓰기 | **허용** |
| Scope 밖 별도 임시 파일 쓰기 | **DENIED_EPERM** |
| Scope 밖 별도 임시 파일 읽기 | **허용** |

첫 읽기/쓰기 반례는 외부 대조군 파일을 허용 Root 안에 둔 잘못된 시험이었고, 쓰기가 허용됐다. 이를 외부 차단 PASS로 세지 않았다. 허용 Root 바깥의 독립 임시 경로로 재시험한 결과 외부 읽기는 허용되고 외부 쓰기는 거부됐다. 따라서 이번 Seatbelt는 읽기/자격증명 기밀성 격리가 아니라 **쓰기 범위 제한**이다.

Mac 증거 operationId:
- 초기 일반 및 논리 Sandbox 시도: ab1c8232-f0b9-4b1e-ad4f-1781b21fd77c
- 결과 증거 확인: 29be83a0-ed41-44db-b732-46de7040fd8e
- canonical Seatbelt App Server 초기화: ec882a49-1d0b-4c0c-9ca2-7d49e29f5ce3
- JSON-RPC 응답 확인: b084e6f9-e6b3-49c1-9911-07b2e1ad792a
- 잘못 배치한 외부 대조군: 5314527f-e851-4c54-a3c7-2046a21d0e34 (성공 아님)
- 별도 외부 파일 읽기/쓰기 검증: 503f6198-d7c5-4e84-99ab-1f07e2096e5f

## 제한과 다음 판단

- 모델 Turn, Codex Tool Exec, 모든 후손의 Sandbox 정책 상속, App Server 종료 이후 완전한 OS Writer 종료는 이번 실험에서 확인하지 않았다.
- 임시 CODEX_HOME의 initialize만 검증했으며 기존 사용자 인증/자격증명을 복사하거나 계정 동기화하지 않았다. 로그인/토큰 갱신/도구 호환성 및 실제 사용 권한 계약은 미검증이다.
- 기존 맥 OS 범위 쓰기 정책은 같은 UID의 Sandbox 비참여 프로세스를 제한하지 않는다. T44에서 사전 존재한 하드링크 외부 inode 문제도 여전히 남는다.
- Linux MCP에는 codex 실행 파일이 없고 T47에서 이 실행기의 User/Mount Namespace 생성은 EPERM이었다. Linux Native Writer의 동일한 보호 수준을 이번 Mac 초기화 성공으로 주장할 수 없다.
- 제품 코드·정책은 변경하지 않았다. DB·Queue·Scheduler·PID 감시·Provider 폴백·불필요한 파일 전수 검사를 추가하지 않았다.

**다음 T49:** 격리된 실제 Native Turn/도구 후손에 대한 OS 정책 상속과 종료 관측을 검증할 수 있는 권한·인증 계약을 먼저 확정해야 한다. 모델 사용이 필요한 테스트는 기존 사용자의 인증을 임의 복제하지 않는다. 기존 T40 도구 후손 실측과 구분해, App Server 부모 격리와 모든 외부 비참여 Writer 배제를 동일한 보장으로 취급하지 않는다.

G0 PARTIAL / W1 DEFER, writerExitVerified:false, deliveryAuthorized:false, Native 자동 합류·예약 자동 해제 비활성 유지.
