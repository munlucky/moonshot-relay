# W0 T25 후속 — 실제 Native 도구 소유권과 Kernel Attempt의 안전한 Writer 재할당

- 검증: 2026-11-03 (KST)
- canonical 코드: `main / cf5de5687a965f66f7b1d26b9f4c85508431deb5`
- 작업 방식: **소스 조사·Linux fixture/기존 테스트·문서 반영은 Moonremote MCP**, Mac 로컬 Codex는 별도 `CODEX_HOME`의 **실제 Native API 검증**에만 사용
- 판정: **Native Background Terminal 종료 경로 시험 PASS(격리 사례), 현재 Kernel Lease 만료 후 같은 Workspace 재허가의 물리 안전 증명 FAIL, 전체 G0 PARTIAL**
- **제품 코드 변경/새 DB/Queue 없음.** 기술 경계가 확인되지 않은 범용 강제 종료·기본 정책 변경은 하지 않음
- 기초: [T25 기존 반례](W0_T25_OS_WRITER_FENCING_2026-11-03.md) · [Code Map](W0_CODE_MAP.md) · [W0 검증 계약](VERIFICATION.md)

## 1. Codex Native에서 실제로 확인한 실행 식별자

격리된 Mac Codex CLI `0.162.1`의 `app-server generate-json-schema --experimental`로 다음 정의를 확인했다.

| 프로토콜/원본 이벤트 | 관측한 필드 | 실제 의미 |
| --- | --- | --- |
| `turn/start`·`item/started` | `threadId`, `turnId`, `item.id` | Native Thread/Turn/Tool Item의 식별자 |
| `ThreadItem(type=commandExecution)` | `id`, `processId`, `status` | 모델 도구 항목 및 Native 명령 핸들. OS PID가 아님 |
| `thread/backgroundTerminals/list` | `threadId` 요청, 응답 `itemId`, `processId`, nullable `osPid` | Native가 관리 중인 Background Terminal 목록. 항목이 항상 존재하는 것은 아님 |
| `thread/backgroundTerminals/terminate` | `threadId`, `processId` | Native가 인식하는 해당 터미널 종료 요청. RPC 성공만으로 모든 후손 OS 프로세스 종료를 보장하지 않음 |
| `command/exec` | 클라이언트 제공 `processId`, 명령 argv, sandboxPolicy | **직접 Host-소유 command**. Model Turn 내부 commandExecution과 다른 경로 |
| `command/exec/terminate` | `processId` (연결 범위 제한) | **원래 command/exec를 요청한 연결에서만** 해당 실행을 종료할 수 있음 |

### A. 모델 Turn이 직접 실행한 Codex 도구

- 분리된 `CODEX_HOME`/임시 Workspace에서 모델 Turn **1회**에 오직 임시 `mr_native_*.py` 실행을 요청.
- `item/started`의 `type=commandExecution`, `itemId=exec-9a84d931-a494-4a16-8b97-e8fc5925ca46`, `processId=1454`를 받았고 `threadId`·`turnId`가 요청과 일치함을 확인.
- 실제 Python Writer의 `PID=40894`, `PPID=40769`, `PGID=40894`를 별도 PID fixture와 `ps`에서 관측. 위 `processId=1454`는 **OS PID 40894와 다름**.
- 새 WebSocket의 `backgroundTerminals/list`에서 같은 `itemId`와 실행 명령을 확인. `osPid=null`이었다.
- 반환된 Native `processId`로 `backgroundTerminals/terminate` 호출 **RPC PASS**. 이어서 fixture OS PID 소멸과 추가 800ms의 파일 쓰기 **0회**를 확인.
- 임시 Codex App Server/Workspace 종료·삭제. Mac OS PID 및 임시 디렉터리 잔여 없음.
- **범위:** 이 특정 Background Terminal은 Native API로 관리할 수 있었다. 모든 foreground/TTY/분리된 후손/Windows tool이 같은 핸들을 제공한다는 근거는 없다.

**실행 영수증:** Mac Native `operationId=60388db6-3f6b-44c4-8608-423c0684d9f6`. 스키마 `e7ae8cd1-fc28-43d3-a8a6-8cc6147082cb`, `5b2029e1-2f0f-4c3b-99c6-3501b1ba45a1`.

### B. Host가 직접 실행한 명령

- 별도 임시 `/tmp` Workspace의 `command/exec` 호출에 `sandboxPolicy={type:workspaceWrite,writableRoots:[<격리 Workspace>],networkAccess:false}`를 부여.
- Writer 프로세스가 실제로 생성되고 파일을 기록하는 중, **다른 WebSocket**의 같은 logical `processId` 종료 요청은 `no active command/exec for process id`로 거절됨.
- **원본 WebSocket**의 `command/exec/terminate`는 성공했고, 실제 Writer의 OS PID 소멸·추가 800ms 기록 0회 후에만 B의 단일 append를 허가. B 이후 A 추가 기록 0회.
- 이 경로는 **모델 Turn이 자동으로 실행한 commandExecution의 종료 보장과 동일하지 않다**. Host 실행 연결이 사라지면 그 연결 범위의 종료 권한을 다른 연결이 그대로 승계한다고 주장할 수 없다.
- 기본 Sandbox에서는 파일 생성이 거부됐으며, 별도 Workspace에 쓰기 권한을 명시하고 재측정했다. 사용자 작업 폴더의 Sandbox 권한은 변경하지 않았다.

**실행 영수증:** Mac Native `operationId=dbd14d95-a192-4463-aa4b-82f75234f887` (기본 Sandbox의 `PermissionError`), `eb481d9e-19d1-45e5-8fee-151907e65a63` (격리 쓰기 권한 확인), `18fb36ae-f28b-4a13-bca6-34e9a4ffbad0` (cross-connection terminate 거부, owner terminate 및 B 허가). 모두 실험 종료 후 임시 자료를 정리했다.

## 2. 실제 Kernel Attempt와 연결하는 현재 소스 경계

| 소스 | 현재 코드에서 확인한 사실 | 남은 연결 |
| --- | --- | --- |
| `src/host/kernel/host-turn.ts` | `prepareHostTurn`에서 Work Unit Mutation Lock을 획득하고 Canonical `beginAttempt`로 `attemptId`를 생성해 `executionContract`에 연결 | **in-flight** `threadId/turnId/itemId/processId`를 Attempt·Workspace와 함께 추적하는 Host 실행 관찰자 없음 |
| `src/host/kernel/turn-dispatcher.ts` | `adapter.dispatch`에 실행 Capsule/계약/작업 Directory를 전달하고 결과를 기다림 | Native `item/started`·Background Terminal 상태 스트림의 기존 Work Attempt 결합 경로 없음 |
| `src/host/kernel/adapters/codex.ts` | `spawn_agent` handle의 `waitForOutcome/wait/result`를 기다린 뒤 결과 이벤트/설정 관측 | Provider 응답 이후 수집만으로는 실행 중 OS Writer 종료를 제어할 수 없음 |
| `src/kernel/persistence/work-attempt-store.ts` | `attemptId`, `bindingId`, `actorSessionId`, `stepId`, `workspaceId` 및 `started/reported/verifying` 상태 보유 | **OS Writer 생존과 실제 종료를 나타내는 검증된 수명 증거가 없음** |
| `src/kernel/state-store.ts` | `acquireWorkspaceMutationLockV2`는 임대 유효성 및 sessionToken 비교·fencingToken 증가를 수행 | TTL 만료 자체는 OS Writer 종료 증명이 아니므로 **같은 Workspace 재할당 전 별도 Gate 필요** |
| `src/host/kernel/workspace/physical-worktree.ts` + `parallel-dispatcher.ts` | Worker별 Worktree 격리·Delivery apply의 기존 CAS/fencing/시간 제한 경로 | Host-owned Worker를 Owner 직접 Checkout에서 분리하면 구 Writer가 계속 쓰더라도 **같은 물리 Workspace의 이중 쓰기**를 피할 수 있음. 실제 통합 테스트 필요 |

### C. Kernel 만료 잠금 반례 (MCP Linux)

격리 Runtime SQLite에서 Workspace 1개, Run 1개, Step 1개, `status=started`인 Attempt 1개를 만들었다. A가 `ttlMs=1`로 lock을 얻고 40ms 뒤 B가 **동일 Workspace/Run을 다른 `sessionToken`으로 획득**했다.

| 관측 | 결과 |
| --- | --- |
| 최초 A Lock 획득 | `true` |
| Active Attempt | `started` (미정착) |
| B Lock 획득 | **`true`** |
| Fencing Token 증가 | `true` |
| 물리 OS Writer 종료 증거 | **제공되지 않음** |

이는 기존 **잠금 API의 만료 재획득 동작**을 보인 독립 소스 fixture다. 동일 시험에서 실제 A 프로세스를 동시에 실행한 것은 아니므로 **직접적인 동시 파일 쓰기 발생**이라고 주장하지 않는다. 위 Native 사례가 *Turn 취소만으로 old Writer가 살아 있을 수 있음*을 보여준다.

기존 `kernel-parallel-fencing`, `kernel-workspace-mutation-lock`, `kernel-run-step-resume` **총 12/12 PASS**. 이 PASS는 CAS/기존 잠금 동작 증명이며 `physical terminated`의 PASS가 아니다.

**실행 영수증:** Linux MCP `operationId=b22bca13-281d-46d9-a845-25f9647d8c8c` (격리 만료/Attempt), `e6d8d4e1-dd97-423b-9db4-4b0aa6a51744` (회귀 12/12). 앞선 문법·import·입력 fixture 오류는 수정한 새로운 격리 실행으로 확인했고 실패를 성공 증거로 포함하지 않았다.

## 3. 최소 구현을 위한 정확한 계약

**핵심 분리:** `cancel requested`, `Turn interrupted`, `Native terminal termination RPC accepted`, `OS Writer physically stopped`, `new mutation owner authorized`는 모두 다른 상태다. 이 중 하나를 다른 것의 증거로 대체하지 않는다.

1. **소유권 결합:** `prepareHostTurn`이 제공하는 기존 `runId/stepId/attemptId/workspaceId`와, Host가 직접 받은 `threadId/turnId/itemId/processId`를 묶는다. 코드에서 Native 이벤트를 수신할 수 있는 **Host 소유 App Server 연결**이 선행돼야 한다. `item/started`의 `itemId`로 `backgroundTerminals/list`의 항목을 확인하고 `processId`를 동일 Attempt의 **명령 핸들**로 식별한다. `processId`를 OS PID로 해석하거나 Provider 버전별 임의 prefix를 가정하지 않는다.
2. **최초 안전 제어:** 해당 핸들이 Provider에서 실제 관측된 경우에 한해 `thread/backgroundTerminals/terminate` 또는 Host가 직접 소유한 `command/exec/terminate`를 사용한다. 원본 연결이 필요하면 Host가 유지하고, 없는 핸들/실패/unknown을 성공으로 만들지 않는다.
3. **종료 증명:** Native 항목의 종료 상태·Background Terminal 목록 소멸과 **실제 OS Writer/후손의 소유 경계**를 별도 확인. `osPid`가 null일 수 있으므로 Native 종료 RPC만으로 물리 종료가 증명됐다고 단정하지 않는다. 종료 증명 경로가 없다면 **동일 Workspace 재할당 금지**.
4. **복구와 연속성:** 기존 Kernel Attempt·operation ID와 Receipt를 재조회하고 unknown 실행은 중복 spawn하지 않는다. **처음부터 별도 격리 Worktree에만 쓰도록 제한된 A**라면 Host가 중단돼도 B를 또 다른 Worktree에서 준비할 수 있다. 다만 그 상태에서 Owner Checkout에 결과를 적용하려면 기존 Owner CAS 및 이전 Delivery 경합 차단을 통과해야 한다. **A가 이미 Owner Checkout에 직접 쓰고 있던 경우에는 새 Worktree 생성만으로 안전하지 않으며, A의 물리 종료/쓰기 정착 전에는 B의 동일 Owner Workspace 변경·적용을 금지한다.** 원본 Owner Workspace에 새 Host-owned Worker의 직접 쓰기 권한을 주지 않는 것이 선행 조건이다.
5. **최종 Delivery:** 기존 `parallel-dispatcher.ts`의 Owner Lease/CAS/patch apply deadline 경로에서만 변경을 Owner Checkout에 반영한다. 구 Worker가 뒤늦게 결과를 제출하면 이전 fencing token으로 Owner 변경을 수용하지 않는다.
6. **추가 구조 금지:** 새 Worker DB·Queue·자체 Scheduler·Prompt 규칙 묶음·무조건 killpg/SIGKILL·Codex 버전별 fallback은 W1의 선행 조건이 아니다. 기존 Host 연결의 한정된 수명 관리와 기존 Work/Trust/Knowledge 권위를 우선 사용한다.

**제품 코드 변경 유예 이유:** 현재 Codex adapter는 App Server 스트리밍 클라이언트를 소유하지 않고, Native `osPid`도 이번 실제 모델 시험에서 `null`이었다. 이 상태에서 `state-store.ts`의 만료 Lease를 단순히 “Attempt 시작 상태면 영구 차단”으로 변경하면 기존 owner-direct 복구를 중단시킬 수 있다. 반대로 Attempt를 단순히 `failed`로 정착시켜 B를 허용하면 실제 OS Writer가 계속 남을 수 있다. 둘 다 충분한 구현이 아니다. 따라서 **관측·격리·물리 종료 계약을 먼저 확보**한 뒤, 같은 Workspace에 한정해 검증된 Exit/Isolation 증거가 있을 때만 새 Writer를 허용하는 내부 Gate를 구현한다.

## 4. 다음 실행 단위

- **W0-T25b:** MCP에서 현재 Host adapter 호출 경계와 `parallel-dispatcher`의 Worker Worktree 격리·Owner CAS를 기준으로 **in-flight Native 이벤트 수신·Attempt 결합 가능한 가장 작은 접점**을 결정. 실제 런타임 변경은 격리 fixture와 경계 테스트가 확보된 뒤.
- **W0-T25c:** Mac Native에서 실제 commandExecution이 Background Terminal 목록에 나타나지 않는 반례, `osPid=null` 및 Host 연결 종료 중 종료 요청의 unknown 결과를 각각 조사. 실패 시 동일 Workspace Worker B를 금지하되 **별도 Worktree로의 안전한 재개 가능성**을 검증.
- **W0-T26:** Host-owned 실행 연결과 사용자 Main/MCP 연결 분리 상태에서 성공·실패·비정상 종료 후 **동일 Attempt 재조회/중복 spawn 금지** 테스트.
- **Windows Native:** 현재 `persistence_unavailable`을 해결한 뒤 Job Object/종료 확인을 교차 검증.
- **G0 판정:** Mac 격리 T25의 특정 종료 가능 사례를 전체 Host Worker 수용 PASS로 확대하지 않음. **G0 PARTIAL, W1 DEFER** 유지.

## 5. 부작용 및 복잡도 검토

기존 Linux 저장소의 제품 소스·생성 Runtime·DB 스키마·사용자 Session/Profile은 변경하지 않았다. Mac Native 작업은 모두 실제 격리 Codex 프로토콜/모델 실행 검증이었고, 사용자 운영 Codex 작업을 중지하지 않았다. 실험마다 별도 임시 홈/Workspace를 사용하고 종료 후 정리했다. 신뢰할 수 없는 PID에 대한 강제 종료는 자동화하지 않았고, 실험 고유 파일명과 PID가 일치하는 fixture만 정리했다.

**핵심 방향:** “모든 프로세스를 찾아 kill”하는 범용 관리 시스템을 만들지 않는다. **Host가 관리하는 명령만 제어**, 관리할 수 없는 Writer는 원본 Workspace를 공유하지 않도록 기존 Worktree 격리·Owner CAS를 사용한다.
