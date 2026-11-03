# W0 Host Capability Matrix — 관측과 미검증의 경계

- 2026-11-03, 사용자 계정/기존 Codex 프로세스·DB는 변경하지 않음
- Source 기준 SHA: `77b55f52c7035f570532078424bf28c1567625fe` (W0 코드 변경 전)
- 판정 값: `OBSERVED` = 제한된 사실 직접 관측, `UNKNOWN` = 결과 불충분, `DEFER` = 안전한 실행 경로 없음, `NOT_TESTED` = 실행하지 않음. 이 파일은 W1의 Host 지원을 PASS로 인증하지 않는다.

## 실행 환경 관측

| 표면 | 확인한 사실 | Worker 관련 제한 |
| --- | --- | --- |
| Windows-side Linux MCP (`/shared/moonshot-relay`) | Node v22.23.4, `main/77b55f52`, `codex` 명령 없음. `NODE_ENV=production` 때문에 dev TypeScript optional 플랫폼 패키지 설치 누락. 격리 `/tmp` checkout에서 개발 의존성 설치 후 TypeScript 테스트 실행 | **CLI native Codex Worker 실험 불가.** Model adapter unit/E2E fixture만 가능 |
| Windows Native (Moonremote host executor) | `exec_command(executionTarget=host)` 호출이 `persistence_unavailable` / `Native host executor heartbeat is stale` 오류로 실행 전 거절 | **DEFER.** 기존 사용자의 native 실행기를 임의로 재시작하지 않음 |
| Mac-side Linux MCP (`/shared/moonshot-relay`) | Mac 연결의 Linux MCP checkout `main/3797c60f`, clean, 실행 중 Moonremote task 없음. Windows-side와 서로 다른 workspace/Host | Source baseline 다름. Native 세션 생존 증거가 아님; 이 checkout에는 write하지 않음 |
| Mac Native (Moonremote-Mac host executor) | `Darwin 25.5.0 arm64`, `codex-cli 0.162.1`. 격리 인증 후 실제 Turn 시작/완료·이력 조회 PASS. [in-flight 연결 시험](W0_INFLIGHT_CONNECTION_LIFECYCLE_2026-11-03.md)에서 시작 연결 해제→interrupted, 시작 연결 유지→다른 연결에서 inProgress 재조회/interrupt PASS, 새 App Server에서 중단 이력 조회 PASS | **연결·이력·Turn-level 제어만 부분 PASS**. 실제 Codex OS Writer·진행 중 command 복구·사용자 Main 세션 분리·Windows 교차 검증 미실행 |

**주의:** 이전 미인증·빈 Thread의 `list_turns is not supported yet`/`no rollout found`는 그 시험 조건의 결과다. 이후 인증·실제 완료/중단 Turn의 이력 읽기가 성공했다. Host 연결을 유지한 모의 Main 클라이언트 교체 성공은 실제 사용자 Main→Host 통합이나 OS Writer 생존·복구의 증거가 아니다. Windows Native stale heartbeat도 기능 부재의 증거는 아니다.

## T26 — 연결/프로세스 종료별 독립 시험

| 관측 항목 | Windows-side MCP | Windows Native | Mac-side MCP | Mac Native |
| --- | --- | --- | --- | --- |
| Main 연결 종료 후 실제 Worker 생존 | NOT_TESTED | DEFER | NOT_TESTED | **모의 비소유 클라이언트 연결 종료 후 Turn inProgress 재조회 PASS**, 실제 Main 세션 종료는 NOT_TESTED |
| MCP 연결 종료 후 실제 Worker 생존 | NOT_TESTED | DEFER | NOT_TESTED | UNKNOWN |
| App Server 종료 후 실제 Worker 생존/안전 정지 | NOT_TESTED | DEFER | NOT_TESTED | 새 App Server에서 중단 Turn의 이력 read PASS, **in-flight command 재개 NOT_TESTED** |
| Host 프로세스 종료 후 생존/재개 | NOT_TESTED | DEFER | NOT_TESTED | DEFER (실사용 세션 보호) |
| 독립 Thread ID 및 Turn ID 관측 | NOT_TESTED | DEFER | NOT_TESTED | **Thread ID·Turn ID PASS** (격리 실제 Turn 3회) |
| 현재 실행 중 command의 idempotent 재연결 | NOT_TESTED | DEFER | NOT_TESTED | UNKNOWN |
| status 재조회 | NOT_TESTED | DEFER | NOT_TESTED | **Host 연결 유지 조건의 inProgress 재조회 PASS**, 시작 연결 종료 시 interrupted 재조회. OS command status UNKNOWN |
| 승인/취소 신호와 적용 시점 | NOT_TESTED | DEFER | NOT_TESTED | 다른 연결의 `turn/interrupt` 후 interrupted 상태 PASS; 승인·후손 OS 프로세스 종료 UNKNOWN |
| 원본 transcript/terminal event 직접 접근·digest | NOT_TESTED | DEFER | NOT_TESTED | App Server 재시작 후 `thread/read(includeTurns=true)` 기록 조회 PASS; 원본 event digest/lossless·in-flight 명령 복구 UNKNOWN |
| Native `spawn_agent` 실제 사용 가능 | 코드 wrapper만 확인 | DEFER | 코드 wrapper만 확인 | UNKNOWN |
| old Worker에 대한 물리 쓰기 차단 | **MCP Linux 반례: TTL 만료 후 A 실제 Writer 생존·추가 쓰기. 후속 격리 실험에서 Host B 예약 거부 PASS** | DEFER | NOT_TESTED | **turn/interrupt-only FAIL**. [T25 물리 Workspace 예약](W0_T25_PHYSICAL_WORKSPACE_WRITER_RESERVATION_2026-11-03.md): 독립 Node 프로세스끼리 같은 물리 Workspace의 single-use 예약 재획득 거부, 별도 Worktree 허용. **Worker가 예약을 삭제할 수 있는 보안 한계, Native Host 자동 적용·후손 종료·다른 OS 머신 미검증** |

## 관련 소스 경계

- `src/host/kernel/adapters/codex.ts`는 주입된 `spawn_agent` 함수를 받을 수 있으며, Native wrapper에서 결과까지 `await`한다. 실제 App Server 소유 Worker handle을 영속화하거나 다른 Main에 재연결할 수 있다는 증거는 없다.
- `src/host/kernel/process-observation.ts`는 PID existence를 검사하지만, 실제 파일 쓰기가 불가능해졌다는 증거는 아니다.
- `src/kernel/persistence/work-attempt-store.ts`에는 실행 식별·status가 있으나 중단 후 Provider 내부 Thread 및 Command 상태를 재조회하는 API는 코드 소유 범위에서 미확인.
- `src/host/kernel/codex-session-observer.ts`의 event/rollout 인식과 Native 원본 transcript 보존·복구는 다른 기능이다.

## W1 시작 조건

1. **실제 Host capability**: 격리된 별도 Worker 생성, 식별 가능한 handle/Thread, 새 Main의 실존 상태 재조회와 cancel/approval/stop 제어를 사용자 계정에 영향 없이 증명.
2. **single writer**: 실행 중 Worker A 중단 또는 격리와 Workspace Rev/CAS 확인 전 Worker B에 같은 mutation scope를 주지 않음을 실험.
3. **미관측 데이터 정직성**: `threadId/turnId/pid`가 응답에서 없으면 null로 기록, session/Attempt ID를 물리 PID로 대신하지 않음.
4. **우회 금지**: Native Host 미연결을 `owner-direct` 자동 전환이나 수명이 보장되지 않는 `spawn_agent` wrapper로 해결했다고 주장하지 않음.

**G0 capability 판정: PARTIAL / Native independent worker lifecycle NOT VERIFIED.** W0-Fix(ContextReceipt)는 이 미검증과 독립적으로 진행 가능. Windows/Mac Native의 재시작/종료 시험은 운영 세션 보호 원칙상 자동 실행하지 않았다.

## 추적 가능한 MCP 실행 근거

- Windows Native `operationId=8ad5ed25-d440-4029-9bcd-700707f80cb4`: executor stale heartbeat, 도구 수준 미시작.
- Mac Native `operationId=c8d67563-2dc4-45e3-9a11-1ad993de13b6`: Darwin/`codex` PATH 확인; 출력 뒤쪽 불완전.
- Mac Native `operationId=ae443193-e21f-47b9-be3c-65c1cb1d2199` 및 `2252de2c-e2d1-47c9-bfd1-4f1b9607d74d`: 최초 빠른 명령의 stdout 획득 불가. `561fd7cf-fbb1-4d4e-802c-e5a27c8c4536`에서 실제 CLI 출력 확인. 추가 WebSocket 실험의 영수증은 [후속 문서](W0_NATIVE_FOLLOWUP_2026-11-03.md) 참조.
- Windows-side Linux MCP `operationId=42b57a86-fd4b-4fcb-820d-1e6f21b91846`: `codex` not found.
- 연결별 Workspace SHA 비교는 `get_work_context`의 읽기 전용 관측이며, 동일 물리 Run 저장소를 공유한다는 의미가 아니다.
