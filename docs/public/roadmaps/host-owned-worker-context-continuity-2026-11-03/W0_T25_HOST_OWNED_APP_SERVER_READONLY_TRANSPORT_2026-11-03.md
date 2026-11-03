# W0 T25 — Host-owned Codex App Server 읽기 전용 연결 수명 검증

> 최초 읽기 전용 경로의 검증 문서이다. [후속 변경](W0_T25_EXTERNAL_WRITER_ADMISSION_2026-11-03.md)으로 선택형 Writable Turn 시작 Gate가 추가됐다. 기본 읽기 전용 실행은 유지한다.

- 일자: 2026-11-03 (KST)
- 기준: `main / 4078ef688f78e81194b18d5009b6ef1dc6b2df57`
- 변경: `src/host/kernel/codex-app-server-transport.ts`, `tests/kernel-codex-app-server-transport.test.ts`.
- 판정: **Host 소유 App Server 표준 입출력(JSON-RPC) 연결 구현 및 격리 회귀 PASS. 실제 Native 모델 Turn 종료·복구, Writer OS 종료와 Kernel 동일 Workspace 재할당 Gate는 미검증. G0 PARTIAL, W1 DEFER.**
- 작업 범위: 일반 코드/시험/문서는 Linux Moonremote MCP, Mac 로컬 Codex는 별도 `CODEX_HOME`·임시 Workspace의 **실제 프로토콜 검증**에만 사용.

## 1. 최소 제품 변경 및 책임 경계

기존 `src/host/kernel/turn-dispatcher.ts`의 Canonical Attempt 바인딩 및 `adapter-dispatch.ts`의 이벤트 파서를 그대로 사용한다. 기본 `createCodexAdapter`·`spawn_agent`·Owner-direct 실행을 대체하지 않는다. Host가 명시적으로 생성하는 `createCodexAppServerTransport`를 **내부 선택 기능**으로 추가했다.

| 동작 | 결과·권위 |
| --- | --- |
| Host-owned 실행 수명 | 별도 `codex app-server` 자식 프로세스 1개를 표준 입출력으로 시작, `initialize` → `initialized` → `thread/start` → `turn/start`, 이벤트 구독·종료 관리 |
| Sandbox | `read-only`/실행 승인 `never`, Turn의 `sandboxPolicy.type=readOnly`; **쓰기 Worker로 자동 승격 금지** |
| 모델 선택 | `turn/start`에서 `model`·`effort`를 명시. 잘못된 모델/effort가 Hang 되면 timeout으로 unknown; 자동 폴백 없음 |
| 이벤트 | 조기 item 이벤트는 한정 버퍼에 보존. 시작 응답의 `threadId`와 `turnId`로 일치 검증하고 `onEvent(event, startedTurn)`로 Host에 전달 |
| 완료 이벤트 | `item/started`/ `item/completed`의 `params.turnId`와 달리 `turn/completed`는 `params.turn.id`를 검증. 다른 Turn 완료 이벤트 거부 |
| 실패·종료 | RPC 오류, 스트림 소실, 시간 초과, 관측 콜백 오류는 연결 사용 중단. **unknown 실행을 중복 시작하지 않음** |
| Workspace | 물리 경로(`realpath`)를 사용. 같은 연결에서 한 번 Turn을 시도한 Workspace는 **Writer 종료 증거 없이 재사용 불가**. 다른 물리 Workspace는 구분 |
| Shutdown | 자체 App Server PID만 종료. **OS Writer/후손 종료를 주장하지 않음**. 반환값 `writerExitVerified=false` 고정 |
| 데이터 권위 | Kernel Attempt, Trust/Knowledge, Owner CAS 또는 사용량 Receipt를 생성/갱신하지 않음. 별도 DB/Queue/Scheduler 없음 |

**중요한 제한:** 이 모듈의 Workspace 재사용 제한은 **한 Host 연결 인스턴스 내부**에만 적용된다. 별개 Host/연결에서 같은 Workspace를 여는 것을 전역적으로 차단하지 않는다. 실제 Kernel Writer Gate 구현이나 종료 증명 PASS로 해석하지 않는다. 새 연결로 retry하지 않으며, 기존 `spawn_agent`의 의미·기본값도 바꾸지 않았다.

## 2. 소스 검증과 프로토콜 비교

- 모의 App Server child process는 실제 JSON-RPC stdin/stdout stream으로 응답한다. 완료 응답 이전 조기 `commandExecution` 이벤트·다른 Thread 이벤트·다른 Turn 완료 이벤트를 섞어 전송한다.
- `bindNativeCommandEvent`와 함께 실행해 Host의 기존 Canonical `runId/stepId/attemptId/workspaceId`를 관측 결과에 연결하고, 명령 `processId`는 OS PID가 아님을 유지한다.
- 연결 중복 Turn, 동일 Workspace 재실행/경로 별칭, 다른 독립 Workspace, 연결 소실, `turn/start` 정체, `initialize` 타임아웃을 확인했다.
- 공식 App Server 가이드의 `initialize`, `thread/start`, `turn/start`, `turn/completed` 수명과 결과 스키마를 참고해 `turn/completed.params.turn.id`를 실제 포맷에 맞게 수정했다. 문서: https://learn.chatgpt.com/docs/app-server

### 검증 결과

| 검증 | 판정 |
| --- | --- |
| TypeScript typecheck / Runtime build / tests build (격리 Checkout) | **PASS** |
| 신규 App Server stdio Transport 테스트 | **4/4 PASS** |
| 기존 Turn Dispatcher/Codex Adapter/Owner Fencing 포함 관련 회귀 | **총 58/58 PASS** |
| 모듈 경계 검사 | **PASS**, 9 modules / 309 files / 844 edges (초기 코드 기준, 뒤의 완료 이벤트 수정은 같은 모듈 범위) |
| Mac 실제 App Server 프로세스에서 initialize·읽기 전용 thread/start | **SMOKE PASS** (별도 임시 CODEX_HOME, model Turn 없음, exit 0) |
| 실제 Mac 모델 `turn/start` → `turn/completed` | **NOT TESTED** |
| Host 교체/중단 후 OS Writer 종료 및 중복 B Dispatch | **NOT TESTED** |

Linux 원본 설치의 누락된 TypeScript 플랫폼 패키지는 기존대로 원본 설치를 수정하지 않고 `git archive HEAD` 기반 임시 `/tmp` checkout에 개발 의존성을 설치하여 검증했다. 실제 런타임/계정/DB/실사용 Codex 세션은 수정하지 않았다.

- Linux 격리 실행: `operationId=95bb2755-63a2-465a-a246-3ef85cb5f53f` (초기 4/4), `7af53e4c-50df-4524-acbb-82b3e3ca0282` (58/58·경계), `a7b3ed9d-bf8b-44c3-bd3f-05610219b332` (완료 이벤트 수정 후 재빌드), `72e69d84-2e64-4e66-b50b-f92f367fd6a6` (수정 후 58/58).
- Mac 실제 격리 프로토콜: `operationId=3619e86f-74d1-4de0-ac84-221d2d2fa780`, exit 0. 모델 Turn은 실행하지 않음.
- 기존 Native handle→Kernel Attempt 선택적 이벤트 관측 경계: [W0_T25_NATIVE_ATTEMPT_EVENT_SEAM_2026-11-03.md](W0_T25_NATIVE_ATTEMPT_EVENT_SEAM_2026-11-03.md).
- 기존 실제 A Writer + Owner CAS: [W0_T25_OWNER_CAS_INTEGRATION_TEST_2026-11-03.md](W0_T25_OWNER_CAS_INTEGRATION_TEST_2026-11-03.md).

## 3. 안전성 리뷰 및 다음 단계

1. **실제 Runtime 통합 전에 모델 Turn E2E 필요.** 이번 코드는 내부 Transport만 구현한다. `createCodexAdapter`에 이 Transport를 자동 연결하지 않고, 비어 있는 Worker Outcome을 성공으로 반환하지 않는다.
2. **같은 Workspace의 Writer 재할당 Gate는 미완료.** Turn 완료나 App Server 프로세스 종료는 분리된 OS 명령 Writer의 정착을 증명하지 않는다. 이전 [T25 물리 Writer 반례](W0_T25_ADDITIONAL_NEGATIVE_VERIFICATION_2026-11-03.md)를 보존한다.
3. Host-owned Native 실행 연결을 기존 `Attempt/operationId`에 묶고, **unknown 시 기존 실행 재조회 및 중복 spawn 금지**를 검증한다. 진행 중 App Server 소실 시 원본 OS Writer를 억지로 종료했다고 가정하지 않는다.
4. Writer를 처음부터 **격리 Worktree**에만 기록하도록 제한하고, Owner에는 기존 fencing·CAS의 단일 Delivery로 반영한다. 다른 Host 인스턴스 간 동일 Workspace 예약·종료 증명은 별도 기술 실험에서 수용한다.
5. 실제 종료·OS 후손 정착, Windows Native Job Object, T26 Host 수명 분리, T24 Goals 중복 여부가 해결되기 전에는 G0를 PASS로 올리지 않는다.

**G0 = PARTIAL / W1 = DEFER.** 규칙·DB·Provider별 폴백을 추가하는 대신 Host의 명시적 실행 소유권과 기존 Kernel 완료 권위를 연결한다.
