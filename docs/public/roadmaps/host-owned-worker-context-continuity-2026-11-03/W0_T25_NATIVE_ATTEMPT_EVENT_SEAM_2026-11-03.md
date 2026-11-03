# W0 T25 — Native 실행 이벤트 ↔ Kernel Attempt 관측 경계

- 검증일: 2026-11-03 KST
- 기준: `main / e715f9c37ea3a3a2b6710d07d3ed6af740fe73f1`
- 변경: `src/host/kernel/adapter-dispatch.ts`, `turn-dispatcher.ts`, `adapters/codex.ts`, 기존 테스트 2개
- 판정: **Native 이벤트와 Canonical Attempt의 선택적 결합 구현 및 집중 회귀 PASS. 실제 App Server 지속 연결·Writer 종료·재할당 Gate는 아직 없다. G0 PARTIAL / W1 DEFER.**

## 1. 코드 변경

1. Host Dispatcher는 `boundAttempt`/`executionCapsule`을 기반으로 `runId/stepId/attemptId/workspaceId`를 만든다. Run·Step·Workspace 식별자 불일치 또는 필수 값 누락 시 관측을 제공하지 않는다.
2. `dispatchKernelTurn`에 **선택적** `onNativeExecution`을 추가했다. Native 실행 함수에만 `executionOwner`·`observeNativeExecutionEvent`가 전달되며 현재 owner-direct 기본 경로는 변하지 않는다.
3. Host가 `thread/start`·`turn/start` 응답으로 **직접 확인한** `threadId/turnId`를 관측 콜백의 별도 인자로 받아, 이벤트의 `params.threadId/turnId`가 일치하는 경우에만 `commandExecution` 항목을 연결한다. 서로 다른 Thread·Turn, 명령이 아닌 항목, 불완전한 ID는 무시한다.
4. Native `processId`는 Provider 명령 핸들일 뿐 OS PID가 아니다. raw command/stdout/env/사용자 모델이 주장하는 owner 정보는 수집하지 않고 종료·fencing·Kernel 완료 권위를 생성하지 않는다.
5. 기존 `createCodexNativeAgentLauncher`는 `spawn_agent`에 허용된 Provider 필드만 전달한다. Host의 Attempt 식별자와 관측 콜백은 Provider payload로 투영되지 않는다.
6. 새 DB/Queue/Scheduler/스키마, Provider 버전별 하드코딩 및 강제 종료 fallback은 추가하지 않았다.

## 2. 검증 근거

- `tests/kernel-turn-dispatcher-envelope.test.ts`: Canonical Attempt 바인딩, Native 시작 Thread·Turn과 이벤트 ID 일치, 다른 ID 또는 누락 이벤트 배제, 모델에 내부 owner 정보 미노출
- `tests/kernel-codex-model-adapter.test.ts`: Production `spawn_agent` payload에 Host 관측 콜백·Attempt ID 비노출
- 격리 개발 checkout: 원본 환경의 Linux TypeScript 플랫폼 패키지가 없어 임시 `git archive` checkout에 개발 의존성을 설치. 원본 `node_modules`·운영 Runtime은 수정하지 않음

| 확인 항목 | 결과 |
| --- | --- |
| TypeScript 검사 | PASS |
| 정규 Runtime/테스트 build | PASS |
| Turn Dispatcher Envelope·Codex Adapter·Host Model Dispatch·Parallel Fencing | **66/66 PASS** |
| `check:boundaries` | **PASS**, modules 9 / files 308 / edges 843 |
| 실제 Mac Native App Server/사용자 운영 Codex 연결 | **이번 변경에서는 NOT TESTED** |

- 최종 MCP 영수증: `operationId=a6d82825-4d17-4849-82ab-d0e5886b9c46`
- 수행한 것은 **주입된 Host-owned Native Transport fixture의 이벤트 통보 검증**이지 실제 App Server 연결 스트림 수용 테스트가 아니다.

## 3. 남은 구현·수용 조건

- 현재 Production Codex 실행기는 주입된 `spawn_agent` 결과를 기다리는 구조이다. **App Server 시작·연결 유지·이벤트 구독·재연결 기능은 아직 구현되지 않았다.** 이번 수정은 해당 Host-owned Runtime이 들어갈 최소 관측 인터페이스다.
- 기존 `turn/interrupt` 뒤 OS Writer가 살아서 추가 기록한 반례는 [T25 실측](W0_T25_OS_WRITER_FENCING_2026-11-03.md)에 보존돼 있다. 관측된 `processId`나 종료 RPC 성공으로 실제 Writer 종료를 추정하지 않는다.
- **동일 Workspace 재할당 Gate는 미구현이다.** 기존 Lock 만료와 fencing token 증가를 물리 Writer 종료 증거로 사용하면 안 된다. 실제 Writer가 alive/unknown이면 B의 동일 Workspace 실행을 차단해야 한다.
- 처음부터 별도 Worktree에 격리한 B는 [기존 Owner CAS 통합 회귀](W0_T25_OWNER_CAS_INTEGRATION_TEST_2026-11-03.md)에서 입증한 Delivery 경계로만 반영한다. A가 Owner에 직접 쓰고 있었다면 Worktree만 추가하는 것으로 안전해지지 않는다.
- Review/parallel/retry, Host 종료 후 Attempt 재조회/중복 spawn 금지 및 Windows Native Job Object 제어는 미검증이다.

**다음 실행 단위:** 기존 Host가 관리하는 App Server의 `thread/start/turn/start` 및 `item/started` 스트림을 실제 소유하도록 연결한 뒤, 그 Runtime의 상태·종료 증거를 이용해 **same Workspace 새 Writer 거부**를 별도 시험한다. 기존 Work/Trust/Knowledge 완료 권위와 Owner CAS를 재사용한다.

**G0 = PARTIAL / W1 = DEFER.** 테스트의 이벤트 연동 PASS를 물리 Writer 차단 PASS로 승격하지 않는다.
