# W0 T46 — 동일 OS 계정 외부 Writer의 Worktree 생성 후·실행 중 변경

- 검증일: 2026-11-05 KST
- 기준: T45 86cb40e9
- 테스트 변경: a054e6cfaeddbc0950dcc784ed04a47a54ff9fbe
- 결과: 기존 Kernel Writer 예약과 별개로 OS 직접 파일 쓰기를 실행할 수 있음을 실증
- 전체: G0 PARTIAL / W1 DEFER

## 선행 증거

T44에서 macOS Codex App Server의 기존 하드링크 외부 inode 쓰기 가능성을 확인했다. T45에서는 동일 바이트의 Owner 하드링크로 치환해도 Git clean과 동일 Attempt 재사용이 통과한다는 것을 확인했다.

## T46 실행

기존 tests/kernel-workspace-writer-reservation.test.ts에 유한한 OS 프로세스 반례를 추가했다.

1. 실제 prepareHostWriterAttemptWorktree로 새로운 Git Worktree를 생성한다. Owner와 Attempt 추적 파일의 inode는 서로 다르다.
2. 예약되지 않은 별도 OS Node 프로세스가 Worktree 추적 파일을 같은 바이트의 Owner 하드링크로 바꾼다. Git은 계속 clean으로 평가한다.
3. 기존 reserveHostWorkspaceWriter로 Attempt 예약을 획득한다. 다른 Host의 두 번째 예약은 오류 코드 29로 차단된다.
4. 시험용 예약 Writer는 생성되고 준비 Marker에서 대기한다.
5. 별도의 비예약 OS Node 프로세스가 같은 Worktree 파일에 쓴다. 예약된 Writer가 아직 쓰지 않았으므로 Owner 파일에 해당 변경이 즉시 반영됐음을 확인한다.
6. Writer 재개 Marker를 발행하면 예약된 Writer가 파일에 쓰고 종료 코드 0으로 끝난다. Owner에서도 새로운 내용을 관측한다.
7. 그 뒤에도 두 번째 Host의 Writer 예약은 차단된다. 이는 Kernel의 협조적 예약 경계가 유지됨을 뜻한다. 하지만 외부 프로세스의 파일시스템 쓰기는 Kernel 예약의 적용을 받지 않는다.
8. 시험에서 생성한 모든 자식을 종료하고 격리 Git Worktree·Owner 임시 파일을 제거한다.

## 범위와 주의

이 시험의 Writer와 외부 프로세스는 유한 Node OS 프로세스다. 실제 Codex Native App Server의 임의 자식·후손 수명 전부를 증명하거나, 별도 사용자 계정 간 접근을 시험하지 않았다. OS Sandbox 실증은 T44 Mac Native 시험과 구분한다.

Kernel 예약은 같은 물리 Worktree에 두 번째 협조 Host Writer를 등록하는 행위를 막지만, 같은 계정의 외부 프로세스가 파일을 직접 열거나 교체하는 동작까지 차단하지는 못한다. Git clean·CAS·TTL·단일 inode 검사·Host 부모 종료는 미래의 외부 쓰기 차단 증거가 아니다.

## 검증

| 검증 | 결과 |
| --- | --- |
| Linux 격리 의존성·TypeScript·테스트 빌드 | PASS |
| Linux Writer 예약 집중 | 6 PASS / 0 FAIL / 0 SKIP |
| Linux Writer 예약·Recovery·Fence 확대 | 11 PASS / 1 OS SKIP / 0 FAIL |
| Linux 모듈 경계 | 9 modules / 313 files / 855 edges PASS |
| 실제 macOS 소스 a054e6cf TypeScript·테스트 빌드 | PASS |
| 실제 macOS Writer 예약 전체 | 6 PASS / 0 FAIL / 0 SKIP |
| 실제 macOS 모듈 경계 | 9 modules / 313 files / 855 edges PASS |
| 임의 Native Writer 후손의 완전한 종료·미래 쓰기 불가능 | 미증명 |

증거 실행:
- Linux 집중: operationId 8d183b1a-f01f-47a7-92ae-5eea91d23ca0
- Linux 확대: operationId 62152d58-14e4-4e8f-9ab1-75f1b1899d1a
- macOS 검증: operationId 3bea9e8a-417b-4683-a1ea-c1ee57279d3f
- macOS 경계 확인: operationId f51c2ae5-3d07-47eb-a64e-704b092d69ec

## 다음 작업과 안전 판단

운영 코드·DB·Queue·Scheduler·Provider 폴백은 변경하지 않았다. 기존 Writer 예약을 해제하거나 Native 자동 합류를 활성화하지 않았다. 무조건적인 재귀 파일 검사와 단발 inode 검사를 추가하지 않는다. 비협조 프로세스의 직접 쓰기를 방지하려면 파일시스템·OS 사용자·마운트 수준에서 지속되는 권위가 필요하다.

남은 핵심은 Native Worktree가 생성된 이후 OS 계정과 물리 파일 접근 권한을 어떻게 격리할지, Writer와 그 임의 후손이 해당 경계를 넘을 수 없는지를 확인하는 일이다. Linux/Windows의 OS 쓰기 격리는 Mac Seatbelt 실측으로 대체할 수 없다.

writerExitVerified:false, deliveryAuthorized:false, 예약·Worktree 보존, Native 자동 합류 비활성 유지. T46 제한된 경계 검증 완료, 전체 G0 PARTIAL / W1 DEFER.
