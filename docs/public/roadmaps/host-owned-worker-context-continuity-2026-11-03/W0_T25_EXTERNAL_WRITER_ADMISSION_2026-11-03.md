# W0 T25 — Host 외부 Writer 예약 및 Native Writable Turn 진입 검증

> 당시에는 동일 Run·Step의 재시도 Worktree 문제가 미완료였다. [후속 Attempt별 Worktree 격리](W0_T25_ATTEMPT_ISOLATED_WORKTREE_2026-11-03.md)에서 선택적 물리 경로 분리를 검증했다. 자동 정리·종료 증명과 기본 실행기 연결은 여전히 미완료다.

- 기준: 2026-11-03, main / c1178ebd3fe39bac11f52dc7930f158e50c530c3
- 판정: **겸용 파일시스템의 협력적 Host 중복 예약 차단 및 명시적 Writable Turn 진입 테스트 PASS. G0 PARTIAL / W1 DEFER.**
- 변경: `workspace-writer-reservation.ts`, `codex-app-server-transport.ts` 및 해당 테스트 2개. 기본 `spawn_agent`·Owner-direct·Parallel Dispatcher는 변경하지 않는다.

## 변경 내용

기존 예약 파일은 Worker Worktree 내부에 있었다. 이제 기존 Kernel `runId/attemptId/workspaceId`와 Host가 지정한 필수 `reservationRoot`를 사용한다. 물리 Workspace의 `realpath`를 해시한 파일명을 **Worker Workspace 외부 Host 경로**에 만든다. 동일한 예약 경로를 공유하는 프로세스는 `open('wx')`의 독점 생성으로 재예약을 거부한다. Host 예약 경로가 Worker Workspace 내부이면 실패한다. 예약의 TTL, 자동 해제, 새 DB·Queue·Scheduler는 없다.

내부 선택형 App Server `runTurn`에 `writableWorker: { reservationRoot }`를 추가했다. 해당 옵션은 기존 `executionOwner`와 `onNativeExecution`이 모두 있어야 사용할 수 있다. **예약 성공 후** `thread/start`와 `turn/start`를 호출한다. `workspace-write`/ `workspaceWrite` 샌드박스를 사용하며 명시적 쓰기 경로는 Canonical Workspace 하나이다. 기본 읽기 전용 실행은 변경하지 않는다. 완료 이벤트를 Kernel Report나 OS Writer 종료 증거로 해석하지 않는다.

## 검증

| 검사 | 결과 |
| --- | --- |
| 실제 OS Writer A 생존 중 Kernel Lock TTL 만료 | 재현 |
| 다른 Host OS 프로세스 B의 같은 Workspace 예약 | 거부 PASS |
| 경로 별칭, Host 재시작 후 재예약 | 거부 PASS |
| 별도 물리 Worktree 예약 | 허용 PASS |
| 예약 후 Worker Git 작업 트리 오염 | 없음 PASS |
| Host 예약 경로가 Worker Workspace 내부인 경우 | Native 요청 전 거부 PASS |
| 모의 App Server의 두 Host 동일 Writable Workspace 경쟁 | 두 번째 시작 거부 PASS |
| Canonical Kernel Run/Attempt → Writable 이벤트 연결 | PASS (모의 서버) |
| Writable Turn 완료 뒤 Kernel Attempt 상태 | started 유지 PASS |
| TypeScript·Runtime/테스트 빌드 | PASS |
| 집중 회귀 | 20/20 PASS |
| 확장 회귀 | **67/67 PASS** |
| 모듈 경계 | PASS, 9 모듈·310 파일·845 관계 |

Linux MCP 격리 검증: `bef834d7-8267-4f7a-a34f-931ca0cc85e1` (최종 67/67). Mac Native 스키마 확인: `d5f5dcad-4e76-435b-ae6d-2306ed2afc89`. Mac 임시 인증 홈의 격리 Writable Turn 실험: `c6bb34db-1032-4403-a728-9f5415f8cf73`, 종료 코드 0. 스크립트는 Workspace 내부 쓰기·Host 예약 파일 보존·명령 이벤트를 조건으로 검사했지만 **표준 출력이 수집되지 않아 개별 관측값을 독립 확인할 수 없다.** 실제 운영 Native Worker/Kernel 일체형 E2E로 간주하지 않는다.

## 보류 조건

- **Host 전용 경로를 쓰는 것만으로 OS 강제 격리가 완성되지는 않는다.** 같은 UID의 비격리 Writer가 Host 파일에 접근할 수 있는지, 실제 샌드박스·OS 권한에서 확인해야 한다.
- 기존 `prepareStepWorktree`는 동일 Run·Step의 Worktree를 재사용할 수 있지만 이 예약은 단일 사용이다. 무조건 적용하면 정상 재시도가 중단될 수 있다. Attempt별 물리 Worktree 또는 안전 종료가 증명된 정리 경계가 선행돼야 한다.
- Native Writer Outcome/Kernel Report·Owner CAS 전달, OS 자식·후손 종료, Host 복구와 중복 spawn 차단, 실제 서로 다른 머신의 공유 파일시스템, Windows Job Object는 아직 미검증이다.
- 실제 제품 Codex Adapter에 이 경로를 자동 연결하지 않았다. 완료되지 않은 영역을 성공으로 간주하지 않는다.

**G0 PARTIAL / W1 DEFER** — 기존 Kernel 권위·기본 실행 흐름 유지.
