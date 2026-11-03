# W0 코드 호출 경계 및 재사용 자산 조사

- 조사 기준: `main / 77b55f52c7035f570532078424bf28c1567625fe`
- 2026-11-03 격리 Linux MCP 소스 조사와 Mac Native read-only capability probe
- **코드 구조 관찰만으로 실제 Worker 생존·서버 API 지원을 인정하지 않는다.**

## 1. 현재 실행 진입점

```text
Caller / existing Codex owner
  → src/host/kernel/turn-dispatcher.ts :: dispatchKernelTurn()
    → dispatchKernelTurnAttempt()
      → controlPlane.next() 또는 prepareHostTurn()
          → 기존 Run·Step·Task Contract
          → baseline-required 처리 (필요한 경우 Host에서 실행)
          → owner/direct vs native-subagent 분기
      → host admission / executionCapsule / route
      → adapter.dispatch()
        → src/host/kernel/adapters/codex.ts
           ├─ owner-direct: owner가 work unit 수신 후 명시적으로 report
           └─ native launcher: spawn_agent() → waitForOutcome() / wait() / result()
      → Host usage receipt 및 기존 Attempt/Review 연결
    → Kernel report 및 Trust Completion은 기존 Kernel authority
```

- `src/host/kernel/turn-dispatcher.ts`: owner-direct는 Worker가 없을 때 실패를 합성하지 않고 기존 owner session에 work unit을 반환한다. Native delegation과 review는 현재 요청의 capability·action에 따라 선택한다. Code의 fallback은 일부 pre-spawn transport 거부에 제한되지만 **spawn 후 응답 소실의 동일 실행 조회·재접속 보장은 별도 입증 필요**.
- `src/host/kernel/host-turn.ts`: `prepareHostTurn()`은 `controlPlane.next()`와 baseline-required 후속 처리를 조합한다. 독립 Worker 생존 상태를 보관하는 외부 authority는 아니다.
- `src/host/kernel/lifecycle-bridge.ts`: Review dispatch에 session-local `inFlightReviews` Map이 있다. 동일 프로세스의 중복 경감은 가능하나 Host 종료 후 지속성을 의미하지 않는다.
- `src/kernel/run/run-loop.ts` 및 `src/kernel/control-plane.ts`: 다음 실행 지시와 Report의 Work/Trust authority. Host 상태와 Completion을 동일시하지 않는다.
- 현재 `src/host/kernel` / `src/cli` 키워드 검색에서 Codex App Server thread start/status/signal 연결이나 Goals 자동 실행 소비자를 확인하지 못했다. **코드 검색 범위의 부재**이며 설치된 Codex App의 Goals capability 부재라고 결론내리지 않는다.

## 2. Provider·Session·Attempt·Owner의 서로 다른 식별자

| 현재 위치 | 관측 가능한 정보 | 복구에 부족한 정보 |
| --- | --- | --- |
| `src/host/kernel/adapters/codex.ts` | Native `spawn_agent` 주입 여부·session ID·결과·usage·model/effort 관측 | 부모 연결 종료 후 Worker handle의 영구 ID와 status/reconnect/cancel API |
| `src/host/kernel/session-affinity.ts` | 세션 affinity key, lineage reset 기준 | 진행 중 command를 실존 Thread에서 재사용할 권한 |
| `src/host/kernel/host-session.ts` | canonical Host session identity | Worker PID/Thread의 실생존 판단 |
| `src/host/kernel/codex-session-observer.ts` | terminal event·rollout의 model/effort 관측 | 공백·가공된 이벤트를 완전한 원본으로 보장하는 수단 |
| `src/host/kernel/process-observation.ts` | PID 살아 있는지 `process.kill(pid,0)` 검사 | 프로세스 group, 현재 명령 소유권·파일 변경 가능성 |
| `src/kernel/persistence/work-attempt-store.ts` | Run/Step attempt, actor session, status, receipt/identity | 중단 후 타 Host의 live Worker handle 재연결 보장 |
| `src/kernel/persistence/host-execution-store.ts` | ModelUsageReceipt, route admission 등 기존 영수증 | 영수증만으로 PID/Thread 실제 생존·취소 증명 |
| `src/host/kernel/parallel-dispatcher.ts` | workspace owner fencing/Lease 및 apply deadline | 관리 밖의 구 Worker가 실제 쓰기를 중단했다는 물리 증거 |

판정: **기존 Kernel의 Work/Trust 기록을 재사용**하되, 독립 Worker 기술을 채택하려면 Host의 실생존/상태/제어 API가 먼저 필요하다. 새 `worker_runs` 영구 DB나 스케줄러는 W0에서 허용하지 않는다.

## 3. T23 원인과 수정 범위

**재현 시점 (변경 전):**

- `src/kernel/context-build.ts`가 `stableTokenBudget` 초과 블록을 문자열 앞부분으로 제한하고, `stageTokenBudget` 초과 시 프롬프트 전체를 재차 `slice()`했다.
- 완료된 `promptBlock`과 독립적으로 `blocks.entries`로 `included` 영수증을 만들었다.
- `FORBID_REMOVE_PROJECT_DIR`가 실제 출력에서 제거돼도 `task-contract`이 잘림 표시 없이 `included`에 남고 `omitted=[]`인 반례가 확인됐다. 이 재현은 custom `contextPolicy`를 입력한 **함수 수준 fixture**다.

**최소 수정 (W0-Fix):**

- `Stable Principles` / `Task Contract`를 required block으로 취급해 문자열을 조용히 자르지 않는다.
- `stageTokenBudget` 초과 시 선택 블록부터 제외하고 `receipt.omitted`에 reason `context-budget`을 기록한다.
- 선택 블록을 모두 제외해도 필수 블록이 budget을 넘으면 `KernelContextRecordError('kernel_context_required_content_exceeds_budget')`로 명시적 실패. 부분 계약으로 진행하지 않는다.
- 새로운 schema/DB table/Host policy/Provider별 fallback 없이 기존 `buildKernelContext` 내부에서 수정.
- 기존 좁은 Budget fixture는 필수 내용 보존의 fail-closed 계약으로 조정.

**영향 경계:** `src/kernel/control-plane.ts`의 `buildStageContext`가 `buildContextReceipt()`를 호출한다. 이 수정은 실제로 Stage Context 경로의 동작을 바꾼다. 그러나 실모델 전송에서 동일 손실이 발생했다는 증거는 아직 확보되지 않았다. Host `src/host/kernel/context-segments.ts`는 별도의 segment compiler이므로 이번 패치의 수정 대상이 아니다.

## 4. 물리 Writer와 영구 Authority 구분

```text
Worker A owns mutation scope
  ├─ Active Run/Attempt / Lease/CAS
  └─ OS Process / Thread / tool subcommands
                     ↓
Main 종료 / Host 재시작 / Worker 교체 요청
                     ↓
[필수] A를 실제 종료·격리했는지 증명
        + unknown command 결과 reconcile
        + Workspace 최신 revision 관측
                     ↓
새 Worker B 동일 Run/Step 재개 허용
```

Lease 만료·CAS mismatch만으로 A가 OS level에서 파일 쓰기를 멈췄다고 가정하지 않는다. 작업 중 사용자가 외부 IDE/Git으로 직접 수정한 경우는 Kernel-managed Worker의 차단 보장 범위 밖이다.

## 5. W1 기술 선택 준비 판정

- **현재 확인:** 단일 다음 작업 경로, Native delegate wrapper와 결과 대기, owner-direct 기본값, Session/Attempt/Receipt·Mutation fence·Context 원본 소유 파일은 존재.
- **미확인:** Main/MCP 종료 후 실제 Worker 생존; Native App Server thread start/status/signal/reconnect; Compaction 원본 접근; Goals 사용·기존 자동 loop와의 이중 실행; 실제 old Writer 종료·복구.
- **권고:** Mac/Windows Native 격리 probe 및 실명세의 status/reconnect 제어가 보이기 전에는 Worker persistence 구조 구현을 시작하지 않는다. 가능한 경우 먼저 Node 프로세스 외부 Worker가 아니라 **기존 Host의 최소 launch/status handle**로 실험한다.
- **선택 유예:** 확인된 API 없이 `spawn_agent`를 감싸서 “세션 독립”이라고 표기하거나, 영수증 status를 live PID status 대신 쓰는 것은 금지.


## W0 후속 — Delivery 패치 기한과 범용 Worker 제어 구분

`src/host/kernel/parallel-dispatcher.ts`는 **Delivery 패치 적용 경로에 한정하여**, Lease 갱신 후 실행 기한을 계산하고 `git apply`에 `killSignal: 'SIGTERM'`을 전달한다. 기존 구현을 W1에서 중복해서는 안 된다.

반면 `src/host/kernel/process-observation.ts`의 `process.kill(pid, 0)`은 PID 존재 확인일 뿐이다. Native Codex Worker의 OS process group 종료, 실행 중 command 재연결, old Writer의 파일 변경 차단을 증명하지 않는다.

또한 실제 Mac Native 시험에서 `thread/shellCommand` RPC 응답 `result: {}`와 `thread/backgroundTerminals/list`의 빈 목록만 관측됐으며, App Server가 Responses WebSocket에 연결하려다 `401 Unauthorized`를 기록했다. [Native 후속 검증](W0_NATIVE_FOLLOWUP_2026-11-03.md) 참조. **G0는 PARTIAL**이며 실제 OS Writer를 관측할 수 있기 전까지 새로운 범용 Worker 관리 계층을 추가하지 않는다.
