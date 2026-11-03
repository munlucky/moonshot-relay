# W0 T25 — 실제 Codex Model/Command 이벤트와 Canonical Attempt 연동 검증

- 일자: 2026-11-03 (KST)
- 기준: `main / 9de6b97326f6e44cf7362415a62258cbd81dd1a5`
- 변경: `src/host/kernel/codex-app-server-transport.ts`, `tests/kernel-codex-app-server-transport.test.ts`
- 결과: **Mac 실제 Codex App Server 두 가지 Turn 수명 실험 PASS**, Linux MCP의 **실제 Kernel Run/Attempt + Host-owned stdio Transport 연결 격리 회귀 PASS**. 이 둘을 하나의 실제 Mac+Kernel 생산 경로로 결합한 E2E는 **NOT TESTED**. **G0 PARTIAL / W1 DEFER** 유지.

## 1. 실제 Mac Codex 프로토콜 검증 (실제 모델 호출만)

Mac 계정의 격리 W0 인증 홈(`~/.local/state/moonshot-relay/w0-codex-auth`) 및 별도 임시 Workspace에서 App Server 표준 입출력 연결을 생성했다. 기존 사용자 Codex 세션과 프로젝트 Checkout은 건드리지 않았다. 둘 다 승인 `never`와 `sandboxPolicy.type=readOnly`로 실행했으며 별도 단일 모델 Turn마다 자체 App Server를 종료·정리했다.

| 실험 | 검증 관측 | 판정 |
| --- | --- | --- |
| 실제 모델 응답 Turn 1회 | `initialize` → `thread/start` → `turn/start` → 동일 Thread·Turn의 `agentMessage` item 이벤트 → `turn/completed.status=completed` | **PASS**, Mac MCP `operationId=7c1b8d95-6e29-49ab-8ef0-514d5dc2caab`, exit 0 |
| 실제 모델의 읽기 전용 shell 명령 Turn 1회 | 모델에 임시 Workspace에서 `pwd` 1회 요청. 동일 `itemId`의 `commandExecution item/started`·`item/completed` 및 해당 Turn의 `turn/completed.status=completed` 수신 | **PASS**, Mac MCP `operationId=6b6d54aa-2e40-4dc1-875c-67422f111120`, exit 0 |
| 모델별 토큰 사용량·품질 및 API 비용 | 측정하지 않음 | **NOT TESTED** |
| OS Writer 또는 후손의 실제 종료 증명 | 읽기 전용 명령 완료만 확인. 별도 OS writer가 없었음 | **NOT TESTED** |
| Native 모델 Turn의 운영 Kernel Attempt/Worktree 결합 | 모델 실행 대상은 별도 Mac 임시 Workspace; Kernel은 Linux 격리 fixture | **NOT TESTED** |

**범위 제한:** 원본 App Server 이벤트의 `processId`는 Provider 명령 핸들이다. `item/completed` 또는 `turn/completed`를 OS 프로세스 종료 증거로 사용하지 않는다. 위 실제 모델 실험에서 앱 서버 종료와 임시 Workspace 정리는 시험 스크립트가 실행했고, 각 작업은 exit 0으로 정착했다. 두 Turn은 명시적으로 별개이며 재시도/자동 B Writer 생성으로 실행하지 않았다.

## 2. Host Transport → Kernel Attempt 경계에 반영한 최소 코드 변경

기존 [Host-owned 읽기 전용 연결](W0_T25_HOST_OWNED_APP_SERVER_READONLY_TRANSPORT_2026-11-03.md)의 `runTurn` 내부 관측 포트를 조정했다.

1. 사용자 제공 원본 App Server 이벤트를 외부 콜백에 전달하던 `onEvent(raw, startedTurn)`를 제거하고, 기존 `NativeExecutionOwner`와 `NativeExecutionObserver`를 받는 **`executionOwner` + `onNativeExecution`**의 한 쌍으로 제한했다.
2. 두 인자가 함께 없거나 함께 있어야 한다. 둘 중 하나만 전달되면 `codex_app_server_observation_owner_required`로 거부한다. 기본 `runTurn`은 관측 없는 읽기 전용 실행이다.
3. 시작 RPC 응답에서 확인된 `threadId/turnId`로 기존 `bindNativeCommandEvent`를 호출한다. `commandExecution`에 필요한 ID가 없는 이벤트, 다른 Thread·Turn 및 비명령 항목은 **전달되지 않는다**.
4. 콜백이 받는 것은 `runId/stepId/attemptId/workspaceId`, `method`, `threadId/turnId/itemId/processId`뿐이다. 원본 명령·stdout·환경 변수·model-provided owner 및 OS PID를 전달하지 않는다.
5. 콜백 오류 발생 시 연결을 `codex_app_server_observer_failed`로 **사용 불가능**하게 만들고 현재 Turn을 거부한다. 다른 Workspace로 조용히 재시작하지 않는다.
6. **기존 `spawn_agent`, Owner-direct, Kernel Report/Review, DB, Workspace Lock TTL, Completion authority는 변경하지 않았다.** 연결의 같은 Workspace 1회 제한도 유지하되, 이것이 다른 Host 프로세스까지 보호하는 전역 Gate는 아니라는 점을 보존한다.

## 3. MCP Linux의 실제 Canonical Attempt 통합 회귀

`tests/kernel-codex-app-server-transport.test.ts`에서 임시 Git Workspace와 Kernel Runtime을 만들고, 실제 `createKernelControlPlane`을 사용해 Run/Attempt를 생성했다. 기존 State Store의 Run Workspace ID와 `beginAttempt`의 Step·Attempt ID를 `executionOwner`로 전달했다.

격리 모의 App Server가 `item/started`와 `item/completed`를 보내면 Host Transport가 기존 ID 검증 후 Native 이벤트를 Canonical Attempt로 결합한다. 이어서 모의 Turn 완료, App Server 종료 뒤에도 해당 Attempt의 상태가 **`started`로 유지**되는지 확인한다. 명령 관측만으로 Kernel 완료 Receipt가 생성되지 않는다는 반례다.

관측 콜백이 예외를 발생시키면 실행이 거절되고 Transport가 재사용 불가 상태가 되는 추가 검증도 도입했다.

| 검증 | 결과 |
| --- | --- |
| Kernel Control Plane Run/Attempt + Transport 연결 | **PASS (격리 모의 App Server)** |
| Canonical Run·Step·Attempt·Workspace 일치 검증 | **PASS** |
| 다른 Thread 이벤트 제외 및 결과값에서 raw 명령/OS PID 제외 | **PASS** |
| Native Turn 완료·Host 닫힘 뒤 Attempt 상태 `started` 유지 | **PASS** |
| 관측 콜백 실패 후 다른 Turn 시작 거부 | **PASS** |
| TypeScript typecheck, Runtime build, tests build | **PASS** |
| Transport / Turn Dispatcher / Codex Adapter / Parallel Fencing 관련 테스트 | **60/60 PASS** |
| `check:boundaries` | **PASS** — modules 9, files 309, edges 844 |

원본 Linux `node_modules`의 TypeScript 플랫폼 패키지가 없는 기존 환경 제약 때문에 `git archive HEAD`와 수정한 두 소스·테스트를 **임시 `/tmp` checkout**에 적용하고 개발 의존성만 해당 격리본에 설치했다. 사용자 Runtime·설치된 Codex·DB를 변경하지 않았다.

- Linux MCP 1차 통합·집중 검증: `operationId=94d33cfb-787a-4565-80ae-1a915280724b`, **59/59 PASS**
- 관측 오류 차단 추가 및 최종 재검증: `operationId=80512cff-f30b-4ad1-815a-6a9532848318`, **60/60 PASS** + boundaries PASS

## 4. 남은 수용 조건

- **실제 Mac Native Turn ↔ Linux Kernel Attempt는 여전히 분리된 실험이다.** 진짜 Worker를 시작하는 Host 실행기에서 Canonical Attempt와 App Server의 실제 원격 이벤트를 하나의 프로세스 경계에 결합한 결과는 아직 없다.
- 이전 [T25 Writer 물리 반례](W0_T25_ADDITIONAL_NEGATIVE_VERIFICATION_2026-11-03.md): 기존 TTL Lock을 만료시켜 B가 다시 획득했어도 A의 OS Writer는 5회 더 기록했다. **전역 동일 Workspace 새 Writer 재할당 차단 Gate는 미구현**이다.
- 실제 Writable Worker는 처음부터 분리 Worktree에만 쓰도록 구성하고, 기존 [Owner CAS 통합 검증](W0_T25_OWNER_CAS_INTEGRATION_TEST_2026-11-03.md)의 단일 Delivery 경계를 통과해야 한다. 아직 실제 Native Worker 권한·설치본 교차 검증을 진행하지 않았다.
- Host 연결 상실 후 **실제** OS 프로세스/후손 종료 또는 기존 Attempt/operationId 재조회·중복 시작 차단은 별도 시험이 필요하다.
- Windows Native Job Object 실험, T24 Goals·Host 자동 실행 중복 조사 및 W1 사용 가능 여부 판정은 남아 있다.

**다음 우선 작업:** Host가 기존 Kernel Attempt를 획득한 상태에서 실제 App Server 실행·재연결 관측을 동일 격리 환경으로 결합하고, **Host A Writer alive/unknown일 때 동일 물리 Workspace의 Host B 실행 거부**를 기존 Kernel 경계에서 증명한다. 새 Worker DB/Queue나 Provider별 하드코딩을 도입하지 않는다.

**G0 = PARTIAL / W1 = DEFER.**
