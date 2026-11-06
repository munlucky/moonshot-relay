# Host-owned Worker · Context Continuity — 코드 구현 실행계획

- 작성/편입: 2026-11-03 (KST)
- 계획 기준 HEAD: `3797c60f662d7b61e7b57b00bc41f96bf7525e94` / `main`
- 판정 기준: 현재 로컬 Git 작업 트리와 그 작업 트리에 바인딩된 Kernel Run. 원격 `/shared/moonshot-relay`와 MCP 관측은 별도 환경·전송 검증으로 기록한다.
- 목적: 메인 에이전트의 개발 실행 컨텍스트를 Host-owned Worker와 분리하고, 압축·교체·장애 후에도 같은 Kernel Run/Step을 안전하게 재개
- 현재 (2026-11-06): **사용자 변경 범위의 로컬 기능 연결 코드 개발 완료 / 전체 Native 제품 수용 PARTIAL**. 같은 Run의 Contract Revision 4에서 변경 범위를 기록했다. 이전 A2/A3 전체 수용은 통과로 바꾸지 않는다. 아래 W0 준비 기록과 이전 완료조건은 범위 변경 전 이력이며, 최신 종료 범위는 [사용자 변경 범위](#사용자-변경-범위와-종료-조건)를 따른다.
- 기반 자료: `moonshot-relay-host-worker-handoff-improvement-strategy-2026-11-03-v2.md`, `moonshot-relay-host-worker-handoff-verification-strategy-2026-11-03-v2.md`, `moonshot-relay-host-worker-code-level-execution-plan-2026-11-03.md` (2026-11-03 사용자 제공·코드 조사 기반). 이 계획서는 실행에 필요한 결정과 검증 조건을 저장소 안에서 자체 참조 가능하도록 정착한 버전이다.
- 진입점: [W0_START.md](W0_START.md), [VERIFICATION.md](VERIFICATION.md), [STATUS.md](STATUS.md)
- 관련 기존 수용 기준: [Ephemeral Work W7](../ephemeral-work-persistent-knowledge-2026-10-31/W7_RESULT.md) (실제 in-flight Host 재시작·인계는 PARTIAL)

## 제품 경계와 변경 원칙

1. **Kernel 권위 유지:** Work(Contract/Run/Step/Attempt/Owner), Trust(Evidence/Review/Completion), Knowledge만 기존 권위. Worker summary·Host status·Handoff가 새로운 완료 권위를 가지지 않는다.
2. **실행과 연결 수명 분리:** Main/MCP는 요청·승인·조회·결과 전달. Host는 실제 Worker Thread/Process의 생성·생존·취소·재접속을 담당. Native `spawn_agent`가 실사용 독립 수명을 보장하는지는 아직 미확인이다.
3. **모델-visible 표면 유지:** `kernel next/report`와 기존 Task Contract를 유지. 별도 Worker 모델 지침, 필수 스킬, 계획·스코어·클리어 명령을 추가하지 않는다.
4. **재시작은 재실행이 아님:** `runId/stepId`는 작업 권위, `attemptId/operationId`는 실행 식별, `threadId/turnId/PID`는 관측 사실. `running/unknown`은 원래 영수증과 프로세스 확인 전 새 ID로 재실행하지 않는다.
5. **실제 single writer:** Lease/CAS 변경만으로 OS Writer가 멈추지 않는다. old Worker의 파일 쓰기 능력을 중지·차단하지 못하면 Owner 이전과 Fresh Resume을 막는다.
6. **Ephemeral Work 유지:** Host-local SQLite를 유지하고 완료 작업의 영구 저널 확장을 막는다. 자동 Cleanup은 켜지 않는다. 서로 다른 Host가 동일 WAL 파일을 동시 사용하지 않는다.
7. **복잡도 상한:** 범용 Scheduler/Job Queue/Worker DB/새 Completion Authority/무조건 fallback/Provider 버전별 하드코딩/자동 compaction 예측 Proxy를 기본 설계에서 제외. 신규 상태/추상화는 기존 경계로 재현 불가능한 반례가 입증돼야만 허용.
8. **사용자 환경 보호:** 모든 Capability Probe와 fault injection은 격리된 테스트 Workspace·Runtime Home에서만. 실제 사용자의 Codex 프로세스/계정 DB/파일을 임의 종료·마이그레이션·정리하지 않는다.

### 기존 코드 경계와 재사용할 기능

| 현재 canonical source | 존재하는 기능·관찰 | 이번 개선의 경계 |
| --- | --- | --- |
| `src/host/kernel/adapters/codex.ts` | `createCodexNativeAgentLauncher`가 `spawn_agent` 호출 후 `waitForOutcome/wait/result`를 기다림; 기본 경로 `owner-direct` | 독립 worker 생존·재조회 여부 G0 실측 후 새 수명 방식 확정. 동기 await 경로를 독립 서비스로 오인 금지 |
| `src/host/kernel/turn-dispatcher.ts` | Admission→Adapter→UsageReceipt/Review; pre-spawn 조건의 owner-direct fallback 경로 | B Worker에서 silent fallback 금지; spawn 후 응답 소실을 실패 확정 처리하지 않도록 조사 |
| `src/host/kernel/host-turn.ts` | `next`, baseline, capsule, mutation lock 조립 | `report.next`와 자동 loop 중복 호출 방지 |
| `src/host/kernel/parallel-dispatcher.ts` | Workspace owner fence, renewal, apply timeout | CAS와 OS Writer 종료·격리를 구분 |
| `src/host/kernel/session-affinity.ts`, `host-session.ts`, `codex-session-observer.ts` | 세션 lineage·Codex terminal 이벤트/rollout 관측 | Thread/Turn/PID와 Attempt의 재시작 후 연결 확인 |
| `src/host/kernel/process-observation.ts` | 얇은 인터페이스와 observation factory | 실생존 조회를 보장하는 구현인지 확인 |
| `src/kernel/persistence/host-execution-store.ts`, `work-attempt-store.ts` | 모델 usage·admission·attempt 저장 | 활성 Worker handle이 재조회 가능한지 입증 후 최소 연결만 추가 |
| `src/kernel/run/agent-recovery.ts`, `work-cursor.ts` | Session/Run 복구 진단 | Fresh Resume 전 running/unknown reconciler 및 old Writer 증명 |
| `src/kernel/context-build.ts` | budget 초과 시 `promptBlock.slice(...)`; included entry는 블록 기준 | **실제 prompt와 ContextReceipt 불일치 위험**을 T23로 재현·최소 수정 |
| `src/host/kernel/mcp-composition.ts` | Host MCP composition | 기존 Moonremote 작업 추적과 제품 Worker 수명을 혼동하지 않음 |

**코드 관찰 ≠ 운영 장애 재현.** 위는 2026-11-03 코드 레벨 후보이고, 독립 Worker 수명 실패·필수 제약 실사용 누락은 아직 PASS/FAIL 실증을 거치지 않았다.

## 권장 아키텍처 및 선택 실험

```text
User/Main (요구·결정·승인·진행/최종 결과)
    ↓ 최소 CLI/MCP/Host 호출 경계
Host-owned worker control (idempotent start / real status / signal / reconcile)
    ↓ 기존 Host adapter · dispatcher
Codex Worker Thread/Process (실제 하나의 mutation writer)
    ↓ 기존 kernel next → 실행 → kernel report
Kernel Work / Trust / Knowledge Authority
    ↕ Workspace · Git · 실행 Receipt · 관측 가능한 Provider transcript
```

A(기존 owner-direct + 기본 압축)는 계속 기준선으로 유지한다. B(Host-owned worker + 기본 압축)가 먼저 기술적으로 성립해야 한다. E(B + **서술형 요약 없이** Fresh Thread에서 Kernel/Workspace/Receipt 재조회)를 필수 대조군으로 검증한다. C(E + 출처 있는 구조화 Handoff)는 **같은 checkpoint/전환 시점**에서 E 대비 이점이 있을 때만 도입한다. D(B + 안전한 Work Unit 경계 새 Thread)는 전환 트리거 효과만 별도로 본다.

## 작업 Wave (기존 범위·Gate 분류, 실제 개발·커밋은 A/B/C 기능 묶음 단위)

| 순서 | 범위 | 핵심 소유 파일 | 필수 Exit Gate |
| --- | --- | --- | --- |
| **W0** | 실제 Host capability·원본 보존·기존 loop 조사, T23 ContextReceipt 재현·필요시 독립 수정, A/B/E/C/D 평가 조건 고정 | `codex.ts`, `turn-dispatcher.ts`, `context-build.ts`, `host-execution-store.ts` | **G0**: 지원/미지원/미관측 분리, 기술 선택 보류 가능. Context 손실 재현 시 최소 수정 증거 |
| **W1** | Host-owned Worker 수명, spawn idempotency, real thread/process observation 및 single writer | `codex.ts`, `host-session.ts`, `process-observation.ts`, 기존 attempt store(필요시) | **G1**: Main 종료와 Worker 생존/안전정지 판정 분리, 이중 Writer 0 |
| **W2** | 기존 호출 경계로 start/status/signal 의미 구현, 다른 Main에서 재연결, 승인/취소 전달 | `host-boundary.ts`, `control-plane-runtime.ts`, Dispatcher, MCP/CLI composition | **G2**: Run 상태와 live 상태 구분, request 중복 없음, 승인 우회 없음 |
| **W3** | 기존 Kernel next→execute→report loop에 결합, Goals와 자동 실행 주체 하나만 선택 | `turn-dispatcher.ts`, `host-turn.ts`, `src/kernel/run/run-loop.ts` | **G3**: 3개 이상 Step·검증 실패 수정·차단 정확성, `report.next` 중복 소비 0 |
| **W4-E** | summary 없는 Fresh Resume; old Writer 종료/보호 후 같은 Run/Step에서 새 Thread | `agent-recovery.ts`, `work-cursor.ts`, `session-binding.ts`, `parallel-dispatcher.ts` | **G4-E**: 같은 Run/Step, 다른 Thread, unknown 중복 실행 0, freshness 보존 |
| **W4-C/D** | C: 구조화 Handoff의 순수 추가 효과; D: Work Unit 안전 경계 전환 효과 | `session-affinity.ts`, `context-segments.ts`, Provider 원본/Receipt 참조 | **G4-C/D**: E보다 필요한 이득이 입증될 때만 C 채택. 압축 전 신호 미지원이면 자동 사전 전환 DEFER |
| **W5** | spawn 응답 소실, Host crash, late writer, 부분 Handoff, 승인 경쟁, Git mutation, secret 공격 | W1~W4 실제 수정 경계만 | **G5**: I01~I12 위반 0, 운영 실증 미수행은 PARTIAL |
| **W6** | A/B/E/C/D 동일 조건 paired 실측, 전체 비용·품질·지연·Main 컨텍스트 평가 | 기존 usage receipt/cache replay/eval fixture 우선 | **G6**: 품질 비열화 및 의미 있는 이점 입증된 작업군만 제한 도입 |

### W0 상세 실행 계약

세부 순서·측정 형식·작업 시작 전 검사는 [W0_START.md](W0_START.md). W0는 **W1 구현 기술 선택의 필수 선행**, W0-T23 defect는 실증되면 다른 Wave와 독립 수정·검증·커밋할 수 있다.

- **W0.1 Runtime 수명:** Linux MCP와 Mac MCP는 소스/격리 fixture, Windows Native와 Mac Native는 실제 Host capability 관측. Main 종료, MCP 종료, App Server 종료, Host 종료를 **서로 다른 반례**로 기록. PID/process group/Thread/Turn/중간 command의 관측가능성과 프로세스 생존·복구를 분리.
- **W0.2 Loop/실행 provenance:** `report.next` 소비자, `running/unknown`, attempt/operation, lock/fence, 승인 중지, Codex Goals 사용 가능성과 Dispatcher 경쟁, spawn 후 응답 소실 분류를 추적.
- **W0.3 Context safety:** `src/kernel/context-build.ts`의 비권위 블록 제거 후 최종 문자 절단 경로를 T23 fixture로 재현. ContextReceipt의 included/omitted가 실제 wire prompt와 같은지 확인. 필수 계약 손실이면 fail-closed 또는 계약 보존 + 선택 자료 제한 중 **기존 계약에 맞는 최소 수정**만 선택.
- **W0.4 사전 등록:** 동일 Git 초기 상태·독립 워크스페이스·Acceptance·모델/effort·권한·검증/비용/중단 조건과 A/B/E/C/D 실험군 고정. 근거 없는 성능 수치 목표를 조작하지 않는다.

**W0 산출물:** `W0_CODE_MAP.md`, `W0_CAPABILITY_MATRIX.md`, `W0_BASELINE.md`, `W0_RESULT.md`. 실제 수행 후 작성한다. 이번 준비 커밋에는 검증 결과를 선기입하지 않는다.

### 주요 테스트 소유권과 명령

**canonical 수정:** `src/**/*.ts`와 `tests/**/*.ts`. 테스트 실행 엔트리 `tests/*.test.mjs`는 생성 wrapper이므로 그 자체를 수정하지 않는다. 변경 전 [개발 가이드](../../development.md)와 `package/source-layout.json`을 우선 확인한다.

| Wave | 기존 테스트 우선 재사용 (Node 실행 wrapper) |
| --- | --- |
| W0 | `tests/kernel-context-compiler.test.mjs`, `tests/context-budget.test.mjs`, `tests/kernel-context-payload-redaction.test.mjs` |
| W1 | `tests/kernel-codex-model-adapter.test.mjs`, `tests/kernel-host-model-dispatch.test.mjs`, `tests/kernel-resume-lease.test.mjs`, `tests/kernel-mutation-fencing-remediation.test.mjs` |
| W2 | `tests/kernel-report-replay.test.mjs`, `tests/kernel-run-step-resume.test.mjs`, `tests/kernel-route-admission-e2e.test.mjs` |
| W3 | `tests/kernel-host-loop-e2e.test.mjs`, `tests/kernel-run-step-ledger.test.mjs`, `tests/kernel-review-receipt-completion.test.mjs` |
| W4 | `tests/kernel-session-lineage-reset.test.mjs`, `tests/kernel-mutation-fencing-remediation.test.mjs`, `tests/kernel-run-step-resume.test.mjs` |
| W5/W6 | 변경 범위에 대응하는 기존 focused tests + 실제 native fault injection / paired 평가 |

필요시 새 canonical 테스트 `tests/kernel-host-worker-lifecycle.test.ts`, `tests/kernel-host-worker-reconnect.test.ts`만 추가 후보. 테스트 이름·파일 개수를 고정된 의무로 만들지 않는다. build 산출물과 테스트 wrapper 정합성부터 확인한다.

```sh
npm run typecheck
npm run check:boundaries
npm run build
npm run build:check
npm run build:tests
npm run build:tests:check
node --test tests/kernel-context-compiler.test.mjs tests/context-budget.test.mjs
```

Wave별 focused tests를 먼저 실행하고, 범위에 따라 `npm run test:source-runtime`, `npm run test:kernel`, `npm test`로 확장한다. 실제 명령 존재 여부와 exit/output을 확인하며 **이 문서에 적힌 명령은 실행 성공을 주장하지 않는다**.

## 개발 작업 운영 계약

1. 매 세션 `get_work_context(cwd="/shared/moonshot-relay")`를 먼저 확인. 같은 작업이 활성화돼 있으면 그 taskId를 유지하고, 없을 때만 작업 체크포인트 생성. 이전 Kernel 작업 계약을 재발급하지 않는다.
2. 명령은 같은 실행에 동일 `taskId+operationId`. `prepared/running/unknown`은 새 ID로 재시도하지 않고 `read_process`의 `nextSeq→afterSeq`로 결과를 끝까지 조회한다.
3. Main 하나의 Writer만 문서를 수정·커밋·푸시한다. Mac MCP는 비교/Native 관측 전용. 서로 다른 Host가 동일 SQLite WAL이나 Git checkout의 동일 mutation scope를 동시에 수정하지 않는다.
4. 착수 Wave의 코드 변경 전 다시 `git status`/HEAD/관련 사용 중 프로세스 확인. 기존 사용자 변경을 덮어쓰지 않는다.
5. 기존 Wave/Gate별로 **수정 범위·실행 증거·미확인 조건·새 복잡도·rollback**을 기록한다. 실제 구현·커밋·푸시는 아래 A/B/C의 작동하는 기능 묶음 단위로 진행하고, 미충족 Gate는 PARTIAL/FAIL/DEFER로 유지한다.
6. W0 외 새 public Kernel 명령·DB 테이블·항상 켜진 agent/skill·특정 프로젝트 분기·자동 fallback이 추가되면 필수 반례와 제거 대안을 문서화한다.
7. 기존 Ephemeral Work의 자동 Cleanup 비활성, Knowledge 영속/Work ephemeral 경계를 변경하지 않는다. 운영 계정 sync/DB 삭제/진행 중 세션 종료는 별도 검증과 승인 없이 하지 않는다.

## 채택·롤백·종료

- **기술 PASS**: 해당 Runtime에서 필수 I01~I12와 G0~G5, 실제 실행/복구가 입증된 상태. fixture만 PASS면 Native E2E는 PARTIAL.
- **제품 채택 PASS**: 기술 PASS + G6 동일 조건 평가에서 Acceptance/제약/완료 비열화 없이 Main 부담·복구·총비용 중 의미 있는 이점. 비용 상한·품질 비열등성 허용치·중단 규칙은 실험 전에 고정.
- **LIMITED**: 장기·대량 작업만 B/E 적용, 짧은 작업 owner-direct 유지. E 충분하면 C 기본 미도입.
- **FAIL / DEFER**: 이중 Writer, 반복 명령, 무단 승인, 계약 손실, 거짓 완료, 유출 등은 FAIL. 실제 Runtime capability 미지원은 DEFER(지원으로 위장 금지). Host 실행이 사라진 경우 stale state를 성공으로 만들지 않는다.
- **롤백**: 기존 A owner-direct 경로를 유지. Worker 전환 실패 시 실제 old Worker와 mutation 상태부터 reconcile 후 경로 복귀. 장애 중 코드·DB·사용자 Runtime을 임의로 복원/삭제하지 않는다.


## 2026-11-06 잔여 구현 우선순위 — 원본 W0~W6/G0~G6 실행 구체화

> 이 절은 **새로운 계획·Wave·Gate가 아니다.** 위 제품 경계·아키텍처, [VERIFICATION.md](VERIFICATION.md)의 I01~I12/G0~G6 및 [W0_BASELINE.md](W0_BASELINE.md)의 A/B/E/C/D 조건을 **변경하지 않고**, 현재 [STATUS.md](STATUS.md)의 미완료 항목을 구현 순서로만 구체화한다. 기존 코드/테스트/Native 증거는 재사용한다. 아래의 실행 번호는 커밋·검증 구분을 위한 식별자이지 추가 필수 기능이 아니다.

### 현행 기준과 완료 판정

- 기준 소스: `main / 359d2a1b` (2026-11-06 조회). 다음 구현 시작 시 `git status`, HEAD, 현재 테스트 산출물을 다시 확인하며 이 SHA를 코드에 고정하지 않는다.
- **이미 연결된 경로:** Host-owned Attempt와 App Server Turn, `kernel_status` 재조회·중단·중복 시작 제어, 격리 Worktree 실제 Git 결과 → 분리 Commit/패치 → 기존 `integrateParallelResults`의 검증 전용 preflight. 완료·정착 권위는 여전히 Kernel만 갖는다.
- **미연결 핵심:** 실제 지원 가능한 Host-owned 실행 수명 → 검증된 Owner 결과 정착 → Canonical `kernel report` → `report.next`로 3개 이상 Step 실행·실패 수정·최종 완료. 기존 owner-direct 3-Step 회귀 PASS를 Host-owned G3 PASS로 간주하지 않는다.
- **기술 선택:** 별도 OS 사용자/UID·SID·ACL·Job Object·프로세스 트리 보안 엔진·범용 Sandbox 개발을 이 작업의 선행 단계로 만들지 않는다. 기존 Host 실행 수명/Workspace/Kernel 단일 Writer 계약에서 **입증된 지원 모드**만 사용한다. 기존 `verifiedNativeWriterIsolation=false`를 임의로 켜거나 테스트 Fixture의 `true`를 운영 승인으로 승격하지 않는다.
- **안전한 중단:** I03의 실제 동시 Writer 금지와 I04/I05/I10은 유지한다. old Writer 종료·쓰기 배제가 미관측이면 해당 Owner CAS·자동 Fresh Resume만 `HOLD_SAFE`/`DEFER`; 독립적인 Host 조회/제어·단일 루프·증거 경로 개발을 멈추지 않는다. 지원 가능한 실행 모드가 끝내 없으면 G1/G3 전체를 억지로 PASS 처리하지 않고 지원 범위 결정을 요청한다.

### 우선순위·선행 관계 (완료된 부분 재구현 금지)

| 순위 | 원래 Wave/Gate | 구현 단위 및 목표 | 선행 관계 | 검증 단위/커밋 경계 |
| --- | --- | --- | --- | --- |
| **1 — 실행 경계** | W1/G1 + W3/G3 | 기존 Host가 소유하는 단일 Worker 실행/결과 소유권을 정리하고 지원 모드와 미지원 모드를 구분. 불명확한 Writer의 Delivery 차단 유지 | 현행 `359d2a1b` 코드 | 실제 호출 경계와 한 번의 Worker 실행·종료·상태 테스트가 PASS일 때 한국어 커밋 |
| **2 — 정착/Report** | W3/G3 | 기존 검증 결과를 **한 번만** Owner Delivery/CAS·Kernel Report에 소비; 미확정 결과는 정착하지 않음 | 1의 지원된 안전 경계 | 단일 Step의 실제 파일 변경·Proof·Owner 정착·Report 결과 PASS일 때 커밋 |
| **3 — 3-Step 개발 루프** | W3/G3 | 기존 `kernel next → execute → report.next`를 단일 소비자가 반복, 실패 검증 후 같은 Run 수정 | 2의 동작 가능한 제품 경로 | 3~5 Step·한 번의 실패/수정·중복 Report/실행 0을 관통 테스트하고 커밋 |
| **4 — Main 재연결** | W2/G2 + W1/G1 | Main 교체 후 동일 Run/Attempt/Turn 조회, 시작 idempotence, 승인·취소 적용 시점 | 1의 Host 생존/안전 정지 의미 | 다른 Main 연결에서 status/signal/승인 정합성 검증 후 커밋 |
| **5 — Fresh Resume** | W4-E/G4-E | 기존 Kernel/Workspace/Evidence만으로 같은 Run/Step을 새 Thread에 연결 | 1·3·4의 확인된 모드 | 이전 Writer 종료/보호 뒤 새 Thread·중복 0·계약/증거 보존 PASS일 때 커밋 |
| **6 — 필수 수용** | W5/G5 | 변경 영향 범위 중심 I01~I12와 실제 장애·경쟁·권한 경계 수용, 기존 검증 증거 재사용 | 1~5 | Native 미확인은 PARTIAL/DEFER, 실제 PASS 조건은 원본 G5 그대로 |
| **7 — 비교/채택** | W6/G6 | [W0_BASELINE.md](W0_BASELINE.md)의 A/B/E 동일 조건 비교, C/D는 추가 효과가 있는 때만 | B 구현·G1/G3/G5 지원 범위 확인 | paired 품질/전체 비용/지연/복구 자료와 제한 채택·기각 판정 |

### 실행 단위 1 — W1/G1: 실제 Host 실행 수명과 단일 Writer 경계

- **재사용/수정 대상:** `src/host/kernel/host-worker-sessions.ts`, `host-owned-writable-attempt.ts`, `codex-app-server-transport.ts`, 기존 `src/kernel/bridge/mcp.ts`, `src/kernel/control-plane.ts`. 기존 Worktree Reservation·Canonical Attempt·Owner Fence 외 새 Authority를 만들지 않는다.
- **최소 구현:** Host/MCP 서버의 수명에 결부된 `start/status/signal` 경로에서 Main 호출이 끊겨도 **동일 실행**의 상태를 재조회; `running/unknown`은 기존 Attempt로만 확인한다. Worker의 결과/출력 종료와 실제 파일 Writer 퇴장 관측을 구분한다. 지원되는 실행 형태에서만 결과 정착 전 단일 Writer 조건을 만족시킨다. 기존 A owner-direct는 보존한다.
- **검증:** `tests/kernel-codex-app-server-transport.test.ts`, `tests/kernel-bridge-mcp.test.ts`의 실제 App Server/Turn·중복 start·취소·Host 소유권 테스트를 재사용. Main 연결 종료 뒤 Host가 살아 있을 때 동일 Worker를 계속 조회하거나 안전 정지로 확인; Host 종료·old Writer 불명확 시 새 Writer를 시작하지 않는다. Fixture와 Native 판정은 분리.
- **완료/차단:** G1은 실제 지원 모드의 Worker 수명/중복 Writer 0 관측이 있어야 PASS. 미증명 Native 범위는 정확히 DEFER. 지원 모드가 없는 경우 단위 2·3의 CODE/WIRED 개발과 owner-direct 검증은 계속하되 Host-owned Native G3를 통과로 취급하지 않는다.

### 실행 단위 2 — W3/G3: 검증 결과에서 Kernel 정착으로 연결

- **입력:** 이미 존재하는 `resultCandidate`(`resultCommitSha`, `patchDigest`, `changedPaths`, Workspace Identity)와 `preflight`. **모델 응답·Host status를 Completion 영수증으로 사용하지 않는다.**
- **재사용/수정 대상:** `src/host/kernel/parallel-dispatcher.ts`의 `verifyHostOwnedWorkerCandidate`/`integrateParallelResults`와 기존 Owner CAS·Delivery 경로, `src/kernel/control-plane.ts`의 `settleParallelResult`/`reportUnderLease`, `host-worker-sessions.ts`. 단일 Host-owned Attempt를 병렬 두 Worker 계약에 억지로 맞추지 말고 기존 검증·정착 권위를 공유하는 최소 어댑터만 만든다.
- **구현 순서:** (1) Canonical Run/Step/Attempt·provenance·기반 SHA/Identity·Proof를 재조회, (2) 현재 지원 모드에서 Writer 퇴장/쓰기가 중복되지 않는다는 증거가 있을 때만 기존 Owner Fence로 변경 적용·CAS, (3) 기존 Kernel Report/Review/Evidence로 정확히 한 번 정착, (4) Report가 반환한 `next`를 그대로 소비. CAS 뒤 Report 실패·재접속은 기존 결과 영수증과 Report Replay/Recovery로 처리하고 새 Worker로 재실행하지 않는다.
- **집중 검증:** `tests/kernel-bridge-mcp.test.ts`, `tests/kernel-codex-app-server-transport.test.ts`, 기존 `tests/kernel-parallel-positive-two-hosts.test.ts`, `tests/kernel-report-replay.test.ts`, `tests/kernel-host-loop-e2e.test.ts`에서 1개 Step의 실제 파일 변경 → Proof → Owner 파일 반영 → Kernel 정착을 확인. **Proof 실패 / 위조·stale Commit / 범위 위반 / Writer 불명확**이면 Owner Mutation Revision·Report·다음 Step은 증가하지 않아야 한다.
- **완료/차단:** Fixture의 결정적 Writer 종료에서 전체 흐름 CODE PASS가 되더라도 Native G3는 별도. 지원 불가 Native에 `writerExitVerified=true`를 주입하지 않으며, 미지원 Owner 자동 정착만 HOLD_SAFE한다.

### 실행 단위 3 — W3/G3: 실사용 3-Step과 검증 실패 수정

- **재사용/수정 대상:** `src/host/kernel/turn-dispatcher.ts`, `host-turn.ts`, 기존 `src/kernel/run/run-loop.ts` 및 MCP bridge의 현재 `kernel next/report` 계약. 이미 존재하는 루프를 연결하고 범용 Scheduler나 Worker Queue를 만들지 않는다.
- **동작:** Host가 받은 최초 `next`로 한 Step만 실행. Report/Settlement 결과의 `next`가 실행 지시이면 **단일 주체가 한 번만 소비**; 그 시점에 별도 `kernel_next` 중복 호출·Codex Goals 자동 루프를 동시에 실행하지 않는다. 실패 Proof는 성공으로 진행하지 않고 기존 Kernel Step/Contract/Evidence에 따라 수정 후 재검증한다.
- **수용 시나리오:** 같은 Run에서 3개 이상의 Work Unit 완료(T02), 필수 Proof가 한 번 실패한 뒤 같은 Step의 수정·재검증(T08), 충돌/중단 중 Writer 이중 생성 0, 중복 `report.next` 소비 0, false done 0. 사용자 기능에서 실행되지 않는 독립 Test Helper만 추가하면 G3 완료가 아니다.
- **커밋 경계:** 단일 루프 실제 동작과 집중 회귀가 PASS인 구현 단위로만 묶는다. 결정적 Fixture E2E·실제 지원 Native E2E 판정을 각각 기록한다.

### 실행 단위 4 — W2/G2: Main 교체·승인·취소 경계

- **재사용/수정 대상:** `src/kernel/bridge/mcp.ts`, 기존 Host/MCP composition, `host-worker-sessions.ts`, `src/kernel/run/agent-recovery.ts`. 다른 Main은 새로운 Run/Attempt를 만들지 않고 기존 Kernel 상태와 동일 Host의 Live Turn/원본 이벤트를 조회한다.
- **검증:** 다른 Main에서 Run/Step/Attempt/Turn 조회(T03/T04), 동시 시작 1회(T05), 승인 대기 중 자동 진행 금지(T14), 취소 직후와 Turn 종료의 경합(T15). `kernel_attach` signal이 Run을 생성하거나 `next`를 소비하지 않음을 확인한다. 재연결된 Main에 승인 우회를 허용하지 않고 원본 이벤트의 관측 가능 범위를 정확히 보고한다.
- **완료:** 요청과 실행 상태가 분리되고 승인/취소 적용 시점을 관측한 경우에만 G2 PASS. Host 자체가 죽은 경우 같은 live Turn handle 재연결을 보장하는 것으로 표현하지 않는다.

### 실행 단위 5 — W4-E/G4-E: 권위 기반 Fresh Resume만 우선

- **재사용/수정 대상:** `src/kernel/run/agent-recovery.ts`, `work-cursor.ts`, 기존 Session Binding·Workspace/Receipt. `Run/Step/Contract/Evidence`를 Source of Truth로 삼고 새 Thread는 **실행 권위가 아닌** 연결 정보로 저장한다.
- **검증:** 같은 Run/Step에서 새 Thread(T09/T21), 이전 Writer가 실제 중단/보호됐거나 미지원 범위가 차단됨(I03/I04), revision·금지 조건·원본 증거/Transcript 보존(T10~T13/T18). `running/unknown`이면 Fresh Resume 명목으로 새 실행하지 않는다.
- **선택 기능:** W4-C의 구조화 Handoff는 E보다 뚜렷한 추가 효과가 입증된 경우만, W4-D의 경계 Reset은 별도 트리거 효과가 있을 때만 도입한다. 지원되지 않는 Provider 압축 사전 신호는 DEFER.

### 실행 단위 6·7 — W5/G5와 W6/G6: 기존 증거 재사용 및 채택

- **W5:** [VERIFICATION.md](VERIFICATION.md) I01~I12와 T05/T06/T07/T14/T15/T17/T25/T26의 **실제 수정 영향 범위**만 검증한다. 원인/코드/환경 변화가 없는 과거 T번호 실험을 다시 확장하지 않는다. Source PASS, Fixture PASS, Native PARTIAL/DEFER와 제품 수용을 혼동하지 않는다. 실패하면 해당 구현에 직접 필요한 최소 수정만 한다.
- **W6:** [W0_BASELINE.md](W0_BASELINE.md)의 고정 Task/Arm/Acceptance/모델/effort/권한/초기 SHA와 기존 Usage Receipt를 재사용한다. 지원 모드에서 A↔B를 먼저 확인하고 B 기술 수용이 없으면 E/C/D는 NOT_RUN으로 둔다. E는 요약 없이 Kernel 권위만 사용하며, C는 E와 동일 시점 비교, D는 경계 전환 효과만 별도로 측정. 토큰·비용·지연·재탐색·완료/품질 지표를 실제 관측값으로 기록한다.
- **채택 조건:** 품질·안전 비열화 없이 장기 작업의 실질 이점이 확인된 작업군만 B/E 적용. 이점 없는 단순 작업에는 A 유지. 새로운 Telemetry DB/평가 플랫폼은 만들지 않는다.

### 공통 실행·커밋·중단 규칙

1. 작업 시작 전 **기존** Moonremote `get_work_context(cwd="/shared/moonshot-relay")`, `main` HEAD·Git 변경·기존 코드·증거 조회. 활성 `taskId` 재사용, 각 명령 별 `operationId` 사용; 미확정 실행의 중복 재시도 금지.
2. **개발 먼저 → 전체 기능 묶음 구현 → 영향 범위 TypeScript/Build 및 통합 테스트 → 현재 로컬 Host/Kernel 경로 확인 및 MCP 전송 검증 → 기능 묶음 단위 PASS/PARTIAL 판정 → 한글 상세 커밋·푸시 → 다음 묶음.** 1~7번은 작업 진행 및 근거를 찾기 위한 세부 기준이며 각각 독립된 중단·커밋 조건이 아니다. 계획 작성이나 PASS 테스트 개수, 작은 오류 수정은 기능 완료로 계산하지 않는다.
3. 테스트 원본은 `tests/**/*.ts`; 빌드 생성 `tests/*.test.mjs` 직접 편집 금지. `npm run typecheck`, `npm run build`, `npm run build:tests`, `npm run check:boundaries`와 각 단위 Focused Test를 우선하고, `build:check`/`build:tests:check`는 필요한 변경에 대해 확인. 기존 PASS 로그는 변경 영향이 없으면 재사용.
4. 커밋 경계는 위 실행 단위의 **작동하는 기능**이며 모든 하위 작업마다 문서/커밋을 생성하지 않는다. 각 커밋 메시지에는 실제 기능, 수정 이유, 회귀 결과, 미검증 Native 범위와 롤백 조건을 한국어로 상세히 기록한다. 기존 [STATUS.md](STATUS.md)만 진행 상황에 맞춰 갱신하고 새 대체 마스터플랜/T번호를 만들지 않는다.
5. 중단 판단: I01~I12 위반이 실제 발생하면 해당 위험 기능만 HOLD_SAFE. 외부 Capability가 없어 필수 G1/G3/G4를 실증할 수 없으면 지원되지 않는 경로를 **DEFER**로 닫고 안전한 독립 기능은 계속 진행한다. 별도 OS 보안 계층이나 필수 Gate 축소가 필요해지는 순간에는 임의 구현하지 않고 범위 결정을 요청한다.
6. **최종 완료**는 원본 G0~G6 중 지원 범위의 실제 제품 수용과 G6 실측 채택 판단에 따라 결정한다. Native 미관측 기능이 남아 있으면 전체를 PASS로 표현하지 않으며, 기능 완료/부분 완료/미지원/NOT_RUN을 명확히 구분한다.

### 개발 실행·커밋 묶음 (2026-11-06 운영 방식 변경)

위 1~7번은 **원래 W0~W6/G0~G6의 세부 수용 기준**으로 보존한다. 실제 개발은 아래 세 묶음으로 연속 진행한다. 각 세부 수정, 테스트 PASS, 문서 변경 시점마다 멈추거나 별도 커밋하지 않는다.

| 실행 묶음 | 포함하는 기존 단위 | 하나의 결과로 판정할 제품 경로 |
| --- | --- | --- |
| **A — 핵심 Host-owned 개발 루프** | 1·2·3 (W1/W3) | Host Worker 실행/소유권 → 검증 → 안전한 Owner Delivery/CAS → Canonical Report → `report.next` 단일 소비 → 3-Step/실패 수정 |
| **B — 세션 연속성** | 4·5 (W2/W4-E) | Main 교체·기존 Run 재연결·승인/취소의 정확한 경계 → 기존 Kernel 증거로 Fresh Resume (기존 Writer 보호 확인 시만) |
| **C — 실제 검증·채택** | 6·7 (W5/W6) | 변경 영향 I01~I12 수용, 지원되는 A/B/E의 조건 고정 비교 및 기술/제품 채택 판단 |

- A·B·C **기능 묶음의 실제 제품 수용**을 커밋/완료 기준으로 삼는다. 단, 특정 Native 기능이 외부 능력 부재로 안전하게 구현될 수 없고 I03을 위반하게 된다면 **해당 기능만 HOLD_SAFE/DEFER**하고 같은 묶음의 독립 기능을 계속 구현한다. 코드 변경은 실제로 검증한 기능 단위로 함께 커밋하되, 미구현 기능을 완료로 표시하지 않는다.
- 기존 `verifiedNativeWriterIsolation`, `writerExitVerified` 값은 근거 없는 Native 지원으로 올리지 않는다. OS 사용자·ACL·Job Object 등 별도 안전 아키텍처를 선행 과제로 만들지 않는다.
- 각 묶음에서 **실제 사용자가 호출하는 경로를 관통하는 테스트**를 우선한다. 이미 PASS한 증거와 기존 코드를 재사용하고 무의미한 반례 증식, 새 Plan, 새 DB·Queue·Scheduler, 세부 단계별 문서/커밋을 만들지 않는다.
- 변경된 운영 묶음은 원래 Gate를 완화하지 않는다. A 기술 수용이 불가능하면 B의 안전한 읽기/세션 제어는 독립적으로 진행할 수 있지만 W6의 미지원 B/E Arm을 실행한 것으로 간주하지 않는다.

## 2026-11-06 잔여 개발 실행 기준 — Host/Kernel 중심, OS 관리 기능 제외 (개정)

> 이 절은 기존 A/B/C 실행 묶음과 W0~W6·G0~G6·I01~I12·T01~T27을 유지하면서, 이전의 **“Native OS 격리 확보 → 나머지 전체 개발 착수”** 순서를 교정한다. 신규 OS 사용자·ACL/DACL·Job Object·권한 상승·전용 Sandbox·후손 프로세스 감시 플랫폼은 **구현 목표가 아니다**. 기존 [T49](T49_FINAL_ACCEPTANCE.md)·[T50](T50_NATIVE_OS_ISOLATION_FEASIBILITY_AND_FINAL_DECISION_2026-11-05.md)의 실패 증거는 보존하며 I03을 완화하지 않는다. 기준 구현은 `main/1258ca08`까지의 검증 완료 코드다. 새 제품 구현은 본 계획 변경과 별개로 판정한다.

### 목표와 지원 모드

**실제 목표:** Main의 컨텍스트/연결과 실행 소유권을 분리하고, 이미 존재하는 Host/Kernel이 같은 Run·Step·Attempt를 재조회·검증·계속 진행하게 한다. 완료 권위는 Kernel의 Work/Trust에만 있다. **OS 보안 시스템을 새로 만드는 것이 목표가 아니다.**

| 모드 | 이번 계획에서 개발·검증할 동작 | Writer 안전 조건 / 제품 판정 |
| --- | --- | --- |
| **A 기존 owner-direct** | 기존 `kernel next → 변경 → report.next`의 실제 작업 재연결·실패 수정·최종 완료. 이미 통과한 3-Step 증거 재사용 | 기존 사용자 지원 경로로 유지. Host-owned B로 바꿔 부르지 않음 |
| **B Host-owned 제어·검증** | Host 생존 중 start/status/signal, Canonical Attempt, 분리 Worktree Git 후보, Manifest Proof, 다른 Main의 읽기 전용 재조회, 검증 실패/unknown 차단 | **OS 관리 계층 없이 구현·통합 테스트 가능.** 후보 관측·Proof 성공 자체는 Owner Delivery 허가가 아님 |
| **B Host-owned 자동 정착** | 검증된 후보 → 기존 Owner Fence/CAS → Kernel Report → 다음 Step 자동 소비 | **실제 Writer 겹침/후속 쓰기 배제가 증명된 지원 Runtime에서만 활성화.** 현재 Native는 HOLD_SAFE/DEFER; fixture PASS를 Native PASS로 주장하지 않음 |
| **E 요약 없는 새 Thread** | 동일 Run/Step/Contract/Evidence를 새 Thread가 재조회하고 후속 작업 | 이전 Writer가 종료·보호됐고 unknown 재실행이 아닌 경우만. 현재 자동 Writable Fresh Resume DEFER |
| **C/D 선택 실험** | E 대비 출처 있는 Handoff / 안전한 전환 시점의 순효과 측정 | E 미지원·효과 없음이면 미도입 / NOT_RUN |

**I03의 의미:** 동일 mutation scope에서 실제 Writer가 동시에 유효해선 안 된다. Worktree 구분·DB Attempt·Lease/CAS·Turn 완료만으로, 동등 권한의 분리 후손이 Owner 파일에 늦게 쓰지 못한다는 보장이 생기지는 않는다. 그렇다고 이를 위해 새 OS 권한 관리 시스템을 선행 구현하지 않는다. **증명되지 않은 자동 적용만 차단**하고, 독립적인 실행 관리·재연결·Proof·Owner-direct 흐름은 계속 개발한다. 안전성 없는 “신뢰된 단일 Writer” 가정이나 테스트 옵션 `verifiedNativeWriterIsolation=true`로 제품 Gate를 열지 않는다.

### 묶음 A — A1 재사용, A2/A3 실제 연결 구현 (W1/W3, G1/G3)

**기준선:** `main/b0dc153e`. A1의 Host 소유 `HostWorkerSessions`·두 MCP Main 스트림 연결·Runtime Home 격리는 **CODE/MCP PASS**다. 다시 구현하지 않는다. 기존 Host-owned Proof-only 검증과 Owner-direct 3-Step PASS도 유지한다. **남은 목표는 A2/A3를 실사용 코드에서 같은 경로로 관통시키는 것**이며, OS 격리 구축을 선행하지 않는다.

| 순서 | 파일·기존 계약 | 반드시 구현할 최소 기능 | 완료·반례 |
| --- | --- | --- | --- |
| **A2-1 결과 인계** | `host-worker-sessions.ts`, `host-owned-writable-attempt.ts`, `parallel-dispatcher.ts` | 완료된 Worker의 `resultCommitSha/patchDigest/changedPaths`, 원본 `Run/Step/Attempt/Workspace Identity/Revision`, 검증된 `workerReport`를 기존 Canonical Attempt에 귀속. 현재 `verifyHostOwnedWorkerCandidate`의 `verifyOnly`는 완료 영수증이 아니다. `settleParallelResult`가 요구하는 `workerReport`·provenance가 실제로 존재하는지 먼저 대조해 빈 필드/임의 Host 요약을 채워 넣지 않는다 | 올바른 Worker 후보만 접수. 누락·stale·위조·scope 위반·`failed/interrupted/unknown`·기존 Attempt 불일치는 **Owner 변경 0, Report 0, 다음 Step 0** |
| **A2-2 공통 검증·정착 접합** | `parallel-dispatcher.ts`의 기존 `integrateParallelResults`(`verifyOnly`/ `materializeDelivery`), `control-plane.ts`의 Owner Fence/CAS·`settleParallelResult`·`reportUnderLease` | 단일 Worker 후보도 기존 병렬 엔진의 **검증·Mutation Receipt·정착 권위**를 재사용할 수 있도록 공유 진입점을 최소 정리. Git Commit/패치 동일성 확인 → 격리 Workspace cherry-pick → 프로젝트 Manifest Proof → staged patch·경로 재확인 → **실제 Writer 배제 증거가 확인된 경우에만** 기존 Owner mutation/CAS 호출 → 같은 Attempt의 Report 정착. 별도 완료 엔진·임시 패치 적용·새 DB·두 Worker 강제 구성 없음 | 지원된 통제 환경에서 실제 Owner 파일 변경 1회, Mutation Revision 1회, 검증된 동일 Attempt Report 1회. Proof 실패·CAS 충돌·늦은 쓰기 미증명은 Fail-closed |
| **A2-3 중단·중복 복구** | `settleParallelResult`, 기존 materialization recovery·Report replay·mutation provenance | CAS 이전/직후·Report 직전 중단을 **기존 기록으로 재조회**. 정착 재실행과 새 Worker 재시작을 구별. 동일 결과 재요청 시 기존 완료 기록 재사용; 불확실하면 Hold | 중복 파일 적용 0, 중복 Report 0, 미확인 상태의 새 Writer 0. 장애 시 원래 실패 근거 보존 |
| **A3-1 단일 후속 실행자** | `turn-dispatcher.ts`, `host-turn.ts`, 기존 Kernel `run-loop.ts`, Canonical Report의 `next` | A2의 **실제 정착 Report 결과**에 있는 `next`만 한 실행 주체가 소비한다. 이전 Main·다른 Host의 별도 `kernel_next` 중복 소비 방지. `fix`는 같은 Step의 다음 Attempt, `done`은 Kernel 최종 증거로만 판정 | 보고 결과의 Step/Attempt/Revision 일치, 중복 실행·완료 위조 0 |
| **A3-2 관통 수용** | 현재 로컬 Host/Kernel·실제 Git/Manifest Proof 격리 fixture | 같은 Run의 3~5 Step에서 실제 파일 변경, 의도한 신뢰된 Proof 실패 1회, 수정·재검증, stale Evidence 갱신, 최종 `completed`를 **Host-owned 후보→정착→Report→`next` 경로**로 확인 | Owner-direct 테스트를 재사용한 척하지 않고 별도 Host-owned 증거로 판정 |

**코드와 제품 활성화의 분리:** 검증 코드는 기존 **동일한 제품 진입점**으로 작성하고, 통제된 테스트에서는 실제 종료·쓰기 가능 범위를 관측한 격리 Worker만 사용한다. 허위 `writerExitVerified=true`·`verifiedNativeWriterIsolation=true`, 모의 Owner Delivery Receipt, 테스트 전용 자동 적용 루틴으로 PASS를 만들어서는 안 된다. 제품의 Native Worker 후손 쓰기 배제가 미확인인 동안 **Native 자동 Owner CAS/Report/새 Writer 시작은 HOLD_SAFE**이며 CODE/Fixture PASS도 그 안전 Gate를 열지 않는다. 실제 안전한 격리 fixture를 구성할 수 없으면 A2/A3의 해당 단계도 **미수용**으로 남기고, 이미 검증된 Proof-only 기능과 B의 독립 기능을 진행한다.

**실행·커밋 원칙:** A2-1~A3-2는 하나의 기능 완성 묶음이다. 구현 도중 개별 테스트/예외 처리만으로 종료하지 않는다. 다만 Native 수용 불가 상태에서 비활성화된 접합 코드만 추가하는 방식은 완료로 간주하지 않는다. 실제 호출 관계와 영향·유지 비용을 점검하고, 테스트·검증된 연결만 기능 단위 한글 상세 커밋에 포함한다.

### 묶음 B — Main 연속성·승인·Fresh Resume (W2/W4, G2/G4)

1. 기존 `kernel_attach/status`의 읽기 전용 `resume/workAuthority/trustAuthority`, 기존 Host live 상태 및 조기 취소를 재사용한다. **Main 교체와 Host 프로세스 종료를 분리**하여 실제 사용 표면에서 동일 Run/Step/Attempt 조회, start 중복 0, signal 적용 시점을 확인한다. Host가 죽었다면 존재하지 않는 live handle을 생성하지 않는다.
2. **승인 요청/응답**은 기존 Host에 실제 인증된 사용자 승인 채널과 원본 App Server 요청 이벤트를 주고받는 경로가 확인된 경우에만 원래 `requestId/threadId/turnId/attemptId`에 결합한다. 그 채널이 없다면 기존 거부→Turn 실패 처리를 유지하고 해당 승인 왕복만 DEFER한다. 사용자 입력 없는 자동 승인, 모의 응답, 사용자 승인 UI/서비스 신설은 포함하지 않는다.
3. **E Fresh Resume**은 현재 Run/Step의 Contract/Evidence 원본과 Workspace Revision을 재조회하고, 옛 Writer의 결과가 이미 정착·종료/보호됨을 확인한 경우에만 새 Thread를 시작한다. `running/unknown`·쓰기 배제 미확정이면 차단한다. **완료된 Step 이후 기존 owner-direct Main의 재개는 수행 가능하지만 이를 B의 새로운 Native Thread 성공으로 위장하지 않는다.**
4. E Native 수용 후에만 C의 동일 시점 Handoff 추가 효과와 D의 Work Unit 경계 전환 효과를 평가한다. E 대비 실익 없으면 C/D 미도입으로 종료. 전용 Handoff DB, 압축 Proxy, 자동 Thread 리셋 규칙 없음.

### 묶음 C — 안전·실측·채택 (W5/W6, G5/G6)

1. 기존 [VERIFICATION.md](VERIFICATION.md) I01~I12·T01~T27, [T49](T49_FINAL_ACCEPTANCE.md)/[T50](T50_NATIVE_OS_ISOLATION_FEASIBILITY_AND_FINAL_DECISION_2026-11-05.md)의 음성 증거와 2026-11-06 관련 회귀 **66/66 PASS**를 재사용한다. A/B가 변경한 실제 경계만 집중 검증한다. 특히 **동시 Writer·늦은 쓰기(T25), 승인 우회(T14), 취소 경쟁(T15), 중복 시작(T05), Host 종료(T26), false done**은 영향이 있을 때만 검증한다. 미관측 Native는 PARTIAL/DEFER.
2. [W0_BASELINE.md](W0_BASELINE.md)의 6개 Pilot과 A/B/E/C/D 독립 변수를 유지한다. **안전한 B Native 기술 수용 후** 동일 모델·effort·Acceptance·초기 Git·샌드박스·승인 조건에서 A↔B → E↔C → B↔D를 순차 비교한다. 사용자 계정/DB/진행 중 세션은 시험 대상으로 사용하지 않는다.
3. 실측 Usage Receipt의 Main+Worker+Reviewer 토큰/Cache/시간/완료율을 합산하고 성능·품질을 함께 판정한다. 비용 상한·표본·요금은 실험 전 승인. B/E 미지원이면 B/E/C/D **NOT_RUN**이며 기존 A를 유지한다. Fixture의 상대 성능을 제품 비용 절감 수치로 발표하지 않는다.

### 완료 조건 정정 — 다음 개발에 적용할 필수 기준 (2026-11-06)

**이번 요청의 개발 범위는 A2-1~A3-2 전체와 B/C의 지원 범위다. A2-1 구현만으로 묶음 A를 종료하지 않는다.** 아래 기준은 위 실행 순서를 구체화한다. 이전 문장의 “미수용 근거를 남긴다”, “지원 범위를 마무리한다”를 구현 Acceptance의 대체 조건으로 사용하지 않는다. Native 자동 적용 보류는 해당 위험 실행에 적용하며, 나머지 코드 통합 개발의 종료 사유로 확대하지 않는다.

**판정 기준은 현재 로컬 작업 트리와 그 작업 트리에 바인딩된 Kernel Run이다.** 로컬 Host 호출로 실제 Git 변경, Proof, CAS, Report와 후속 실행을 검증한다. MCP는 같은 Host 경로를 사용하는 추가 호출 표면이다. MCP에서는 Main 교체, 중복 요청, 취소 등 전송 경계를 별도로 검증한다. 원격 체크포인트는 로컬 Git 상태나 Kernel 수용 증거를 대신하지 않는다.

**로컬 우선 수용 규칙:** MCP 연결 없이 로컬 Host 진입점에서 A2-1~A3-2와 B의 지원 기능이 동작해야 한다. MCP 요청은 동일한 Worktree/Run/Step/Attempt 바인딩과 검증·정착·후속 실행 경로를 사용해야 한다. MCP 전용 성공 경로, 별도 완료 판정, 완화된 Writer 보호 조건을 두지 않는다. 로컬 수용과 MCP 전송 회귀를 각각 기록하며, MCP PASS로 로컬 미수용을 대체하지 않는다. 현재 로컬 환경에서 필수 보호 기능을 사용할 수 없으면 해당 로컬 수용은 미완료다.

정정 시 확인한 구현 기준은 `codex/host-worker-result-handoff / e419fa09`다. `main / a9576033`에는 이 구현이 아직 없다. 다음 작업은 실제 Git 상태와 변경 내용을 다시 확인하고 이 구현을 기준으로 이어간다. A1·A2-1 및 과거 증거는 재사용하되 아래 관통 수용을 대신하지 않는다.

#### 1. 묶음 A — 아래 다섯 행을 모두 충족해야 코드·통합 완료

| 필수 항목 | 실제 완료 조건 | 필요한 관측·실패 조건 |
| --- | --- | --- |
| **A2-1 결과 인계** | 실제 Worker의 보고서와 Git Commit·패치 Digest·경로·Workspace Identity를 원래 Run/Step/Attempt 및 Contract/Plan/Mutation Revision에 결합. 같은 결과의 재접수는 기존 기록 재사용 | 누락·위조·stale·범위 위반·다른 Attempt·미완료 Turn을 각각 차단. 실패한 후보의 **Owner 적용 0, Mutation Revision 증가 0, Report 0, 후속 실행 0**. 모델 요약이나 Turn 완료는 Delivery 권한이 아님 |
| **A2-2 검증→Owner 정착→Report** | 단일 Host-owned 후보가 기존 `integrateParallelResults`의 Manifest Proof, Owner Fence/CAS, `settleParallelResult`/`reportUnderLease`를 실제 호출. 같은 Attempt에 실제 Owner 파일 변경과 Canonical Report가 귀속 | 지원되는 통제 환경에서 **정착 1회당 Owner 패치 적용 1회·Mutation Revision 증가 1회·Canonical Report 1회**. Proof 실패·CAS 충돌·stale 결과·Writer 배제 미확인 시 Owner 적용과 다음 Step 진행을 차단. 정상 종료한 Manifest 명령의 실패가 입증되면 Kernel이 같은 Step의 수정 Attempt를 지정할 수 있음. Proof-only나 호출자 없는 어댑터는 미완료 |
| **A2-3 중단·재요청 복구** | Proof 후 CAS 전, 파일 적용 후 CAS 기록 전, CAS 후 Report 전, Step 통과 후 Report 결과 저장 전, Report 저장 후 응답 전달 전의 각 중단을 기존 기록으로 복구. 이전 결과 정착의 재개와 Worker 재실행을 구분 | 실제 중단/재접속·동시 재요청에서 **중복 파일 적용 0·중복 Canonical Report 0·불명확한 상태의 새 Writer 0**. CAS 후에는 기록된 같은 결과의 Report를 재개. CAS 기록 없는 파일 적용 등 모호한 구간은 원인·기존 Attempt를 보존하고 차단. 정상 재실행으로 위장하지 않음 |
| **A3-1 `report.next` 단일 소비** | A2-2의 실제 정착 Report가 반환한 `next`를 기존 Host/Kernel 루프의 한 실행 주체만 소비. 같은 Step 수정은 Kernel이 지정한 다음 Attempt로 수행 | 동일 `next` 재전달, 두 Main/Host의 경쟁, 응답 유실 후 재접속에서도 **같은 실행 지시의 Worker 생성 최대 1회**. 별도 `kernel_next`로 중복 진행하지 않음. Step/Attempt/Revision 불일치는 차단. `done`은 원래 계약의 Kernel 최종 증거에 귀속 |
| **A3-2 Host-owned 3~5-Step 관통 수용** | 같은 Run에서 실제 Host-owned Worker가 파일 변경→후보 인계→Proof→Owner CAS→Report→`report.next`를 3~5 Step 연속 수행. 실제 Manifest Proof 실패 1회 이상을 수정하고 stale Evidence를 최종 Workspace에서 재검증한 뒤 Kernel 완료 | 원본 Git 변경, Step/Attempt, Proof 실행·실패·수정, Owner Mutation, Report 및 최종 수용 증거를 연결해 제시. **최종 파일/계약 일치·중복 실행 0·중복 정착 0·false done 0**. 기존 Owner-direct 3-Step이나 두 병렬 Worker 성공으로 대체하지 않음 |

**통제된 관통 검증의 조건:** 실제 격리 Git/Runtime과 실행 Writer를 사용하고, Writer의 종료·쓰기 가능 범위를 근거로 확인한다. 제품에서 사용하는 동일한 결과 검증·Owner CAS·Report·후속 실행 경로를 통과해야 한다. 테스트가 Owner 파일을 직접 적용하거나 Canonical 성공 Receipt를 만들어 넣는 별도 정착 루틴은 인정하지 않는다. Proof는 프로젝트 Manifest에 묶인 실제 명령을 실행하며, 통과 값을 반환하는 모의 runner로 관통 수용을 대체하지 않는다. `writerExitVerified=true`·`verifiedNativeWriterIsolation=true`를 근거 없이 주입하지 않는다.

안전한 통제 환경을 구성할 수 없으면 해당 행은 **BLOCKED/미수용**, 묶음 A는 **미완료**다. 그 사실을 문서화해도 해당 Acceptance는 충족되지 않는다. 가능한 독립 개발은 계속하고, 끝까지 남은 차단 원인·필요한 외부 능력·재개 조건을 보고한다. 새 OS 보안 플랫폼 구축이나 안전 Gate 축소로 임의 전환하지 않는다.

#### 2. 묶음 B — Main 연속성과 외부 능력의 판정을 분리

| 항목 | 완료 조건 | 지원되지 않을 때 |
| --- | --- | --- |
| **Main 교체·중복 시작** | 로컬 Host에서 Main 교체 후 같은 Run/Step/Attempt와 지원되는 live Turn을 재조회. 동시/재전달 start는 동일 실행 재사용, 다른 Runtime/Run 접근은 거부. MCP 연결 교체에서도 같은 결과를 별도 검증 | Host 프로세스 종료 후 실행 핸들 복원을 관측하지 못하면 그 범위는 미수용. 새 핸들을 만들어 복구했다고 주장하지 않음 |
| **취소 경쟁** | Turn 시작 전 취소는 원래 실행에 큐잉하고, 주소 지정 가능 시 정확한 Turn에 신호를 전달. 취소/완료/연결 종료 경쟁의 결과와 적용 시점을 관측 | ACK나 연결 종료를 Writer 종료로 간주하지 않음. 취소 요청과 실제 중단 판정을 구분 |
| **승인 왕복** | 기존 인증된 Host 사용자 채널이 있을 때 원래 requestId/threadId/turnId/attemptId에 응답을 결합하고, 승인 전 실행 차단·다른 실행의 응답 거부를 검증 | 실제 채널이 없으면 **이 항목만 DEFER**. 기존 거부 경로를 유지. DEFER는 승인 기능 완료가 아님 |
| **E Fresh Resume** | 원래 Run/Step의 Contract·Workspace Revision·Evidence를 유지하고 이전 Writer의 정착·종료/쓰기 배제를 확인한 뒤 실제 새 Thread를 시작. 중복 새 Writer 0 | old Writer `running/unknown` 또는 배제 미확인이면 **E만 HOLD_SAFE/DEFER**. Owner-direct Main 재개로 대체하지 않음 |

B의 완료 보고는 각 행의 CODE/통제 통합/Native 관측을 구분한다. 승인 왕복·E의 DEFER는 묶음 A의 필수 구현을 제외하는 근거가 아니다.

#### 3. 묶음 C — 안전 검증과 제품 채택

- **검증:** [VERIFICATION.md](VERIFICATION.md)의 I01~I12에 각 기존/신규 증거와 미관측 범위를 대응한다. 변경 영향이 있는 실제 경계만 재검증하며, 원인·코드·환경이 같은 기존 증거는 재사용한다. 필수 경계의 실패를 “기존 실패”라는 이유만으로 통과 처리하지 않는다.
- **기본 검사:** `npm run typecheck`, `npm run build`, `npm run build:tests`, `npm run check:boundaries` 및 위 A/B의 실제 통합 시나리오를 검증한다. 정적 검사·빌드·일반 recovery 테스트만으로 A2-2/A3-2 구현 증거를 대신하지 않는다.
- **Native 수용:** 실제 지원 Host에서 Writer 보호, Owner 정착, 다단계 실행, Main 교체/Fresh Resume의 해당 Gate를 관측해야 Native PASS다. 미관측·미지원이면 해당 Gate는 PARTIAL/DEFER이며, 통제 환경 PASS로 자동 활성화하지 않는다.
- **비교·채택:** 지원되는 Arm에만 [W0_BASELINE.md](W0_BASELINE.md)의 동일 조건·사전 고정 예산/표본으로 A↔B, 이후 E↔C와 B↔D를 비교한다. 실제 Main+Worker+Reviewer Usage, 품질, 시간, 복구 결과로 채택·LIMITED·기각을 결정한다. B/E가 미지원이면 B/E/C/D는 NOT_RUN이고 비교·채택 완료가 아니다. 비용이 드는 실험의 기존 사전 승인 조건은 유지한다.

#### 4. Kernel 등록·보고·완료 규칙

1. **목표:** “Host-owned Worker의 A2-1~A3-2 전체를 기존 제품 경로로 구현하고 통제된 3~5-Step 관통 수용을 통과한다. B의 독립 기능을 검증하고, Native/승인/Fresh Resume/비교 평가는 실제 지원 조건에 따라 별도 판정한다.”라고 등록한다. “A2-1 검증·커밋 및 나머지 PARTIAL 보존”으로 원래 목표를 바꾸지 않는다.
2. **Acceptance:** 위 A의 다섯 행과 B/C의 실제 수행 대상을 각각 명시한다. Kernel이 생성한 AC/Obligation 식별자를 사용한다. 각 필수 조건에 실제 통합 테스트명·프로젝트 Manifest `commandRef`·실행 환경·관측할 Receipt/상태를 연결한다. 아직 테스트/경로가 없으면 개발할 대상으로 남긴다. 요약 문장 하나와 일반 `default` 테스트 하나로 서로 다른 필수 기능을 모두 충족했다고 주장하지 않는다.
3. **증거 범위:** `acceptanceCoverage`에는 해당 실행이 실제 검증한 조건만 제출한다. 타입/빌드, 후보 인계, 병렬 복구 증거를 Host-owned 정착·다단계 수용의 증거로 확대하지 않는다. 동일 Workspace/Revision의 신선한 증거만 사용한다.
4. **미완료 처리:** 필수 구현·관통 수용이 하나라도 남으면 구현을 계속한다. 실제 외부 능력 때문에 더 진행할 수 없으면 Kernel이 제공하는 blocker/recovery 경로로 남기고, 미충족 AC를 충족으로 보고하지 않는다. blocker/미수용 사유 기록은 성공 조건이 아니다.
5. **Run과 원래 작업의 구분:** 문서 정리·커밋 복구 등 별도 하위 Run의 `done`은 그 하위 범위의 결과만 뜻한다. 원래 A2/A3 완료로 사용하지 않는다. 완료 조건을 줄이려면 사용자에게 변경할 조건과 영향을 명시하고 승인을 받아야 한다. 과거 완료 Receipt/DB를 수정해 현재 범위에 맞추지 않는다.
6. **완료 보고:** A의 필수 행이 모두 충족되고 그 원래 계약의 Kernel 최종 continuation이 `done`일 때만 **“묶음 A 코드·통합 완료”**라고 쓴다. Native/B/C에 미수용·DEFER·NOT_RUN이 남으면 **“잔여 개발 전체 완료” 또는 “전체 제품 PASS”라고 쓰지 않는다.** 원래 범위 전체의 필수 수용·실측 채택까지 충족하거나 사용자가 범위 변경을 승인한 경우에만 전체 완료를 판정한다.
7. **커밋·푸시:** 구현 완료, Kernel 수락, Git 전달, Native 제품 수용은 각각 기록한다. 부분 결과의 보존 커밋이나 푸시 성공은 원래 기능 완료가 아니다. 메시지는 실제 포함한 구현·수정 이유·검증·제한을 한국어로 작성한다.

**다음 실행 시작점:** A2-1은 실제 구현·회귀 근거를 재사용하고, **A2-2→A2-3→A3-1→A3-2를 같은 기능 묶음으로 계속 구현**한다. B의 Main 연속성·취소 등 독립 기능을 병행할 수 있다. Native HOLD_SAFE만을 이유로 A2-1에서 종료하거나, 문서/테스트 개수만으로 Kernel 전체 완료를 요청하지 않는다. 새 DB·Queue·Scheduler·상시 Supervisor·OS 보안 플랫폼, 프로젝트 전용 정책, 안전 실패 폴백은 추가하지 않는다.

## 사용자 변경 범위와 종료 조건

2026-11-06 사용자가 이전 목표를 해제하고 로컬 기능 연결 개발을 새 목표로 지정했다. 이어 같은 Kernel Run의 완료와 커밋·푸시를 요청했다. 원래 Run run-917b3dd5-f41c-4127-8283-395859b379dd의 Contract Revision 4에 다음 범위를 기록한다. Run의 최초 objective 문구와 이전 Revision 2의 미수용 기록은 이력으로 남긴다.

1. MCP 없이 로컬 Worker 제품 진입점과 기존 Host 세션을 연결한다. 보호 기능이 없으면 시작 전에 미지원으로 차단한다.
2. Canonical Attempt 인계와 기존 Proof→Owner Fence/CAS→Report 연결 코드를 완성한다. 후보 검증 회귀와 실제 Native 적용 성공은 별도로 판정한다.
3. 기존 중단 복구를 연결하고 공통 CAS/Report 회귀로 중복 적용·Report 차단을 검증한다.
4. 원본 Report.next를 소비하고 후속 시작 실패와 응답 유실 시 같은 지시를 재사용한다. 기존 Step 선점·Revision·중복 요청 회귀를 검증한다.
5. 같은 Host에서 Main 교체·상태 조회·정확한 Turn 취소를 로컬 연결과 추가 MCP 전송으로 검증한다.
6. 타입·제품 빌드·테스트 빌드·경계·관련 회귀를 현재 작업 트리에서 Kernel이 실행한다. 최신 Canonical Report.next가 done일 때 이 변경 범위의 Run을 종료한다.

검증 명령은 npm run test:host-worker-code-closeout이다. 이 명령은 위 코드 개발 범위의 회귀다. 기존 test:host-worker-product-acceptance와 보호된 A2/A3 명령은 그대로 보존한다. 보호된 Host-owned 3~5-Step, Windows Proof 보호 신설, 승인 채널, Fresh Resume, Host 프로세스 종료 후 복원, 성능 비교는 이번 종료 조건에서 제외한다. 기본 Native 자동 Owner 적용은 여전히 미지원이다. 제외 항목을 PASS로 표시하지 않는다.
