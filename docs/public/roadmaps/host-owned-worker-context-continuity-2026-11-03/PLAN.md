# Host-owned Worker · Context Continuity — 코드 구현 실행계획

- 작성/편입: 2026-11-03 (KST)
- 계획 기준 HEAD: `3797c60f662d7b61e7b57b00bc41f96bf7525e94` / `main`
- Canonical 작업 경로: Windows `C:\dev\moonshot-relay`, MCP `/shared/moonshot-relay`
- 목적: 메인 에이전트의 개발 실행 컨텍스트를 Host-owned Worker와 분리하고, 압축·교체·장애 후에도 같은 Kernel Run/Step을 안전하게 재개
- 현재 (2026-11-06): **제품 PARTIAL / 구현 진행 중**. W0 결과 및 A·B·C 실행 묶음의 실제 수용 상태는 [STATUS.md](STATUS.md)를 기준으로 판단한다. 아래 W0 준비 기록은 최초 설계 당시의 이력이다.
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

## 작업 Wave (각 Wave = 분석·최소 수정·검증·한국어 상세 커밋/푸시 단위)

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
5. 매 Wave **수정 범위·실행 증거·미확인 조건·새 복잡도·rollback**을 기록. 완료 조건 충족된 Wave만 한국어 상세 커밋·푸시. Gate 미충족이면 PASS로 포장하지 않고 PARTIAL/FAIL/DEFER로 남긴다.
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
2. **개발 먼저 → 전체 기능 묶음 구현 → 영향 범위 TypeScript/Build 및 통합 테스트 → 실제 MCP/Kernel 경로 확인 → 기능 묶음 단위 PASS/PARTIAL 판정 → 한글 상세 커밋·푸시 → 다음 묶음.** 1~7번은 작업 진행 및 근거를 찾기 위한 세부 기준이며 각각 독립된 중단·커밋 조건이 아니다. 계획 작성이나 PASS 테스트 개수, 작은 오류 수정은 기능 완료로 계산하지 않는다.
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

## 2026-11-06 잔여 개발 완료 실행 기준 — 기존 A/B/C 묶음의 재개 조건과 구현 경계

> **이 절은 기존 W0~W6·G0~G6·I01~I12·T01~T27을 대체하지 않는다.** 위 실행 단위와 검증 조건을 `main/1258ca08`의 현재 구현·[STATUS.md](STATUS.md)·[T49 최종 수용](T49_FINAL_ACCEPTANCE.md)·[T50 Native 격리 결정](T50_NATIVE_OS_ISOLATION_FEASIBILITY_AND_FINAL_DECISION_2026-11-05.md)에 대조한 **남은 작업만의 실행 절차**다. 기존 1~7과 A/B/C 묶음을 유지하며 별도 Wave·Master Plan·필수 Gate를 만들지 않는다. 본 절 작성은 신규 제품 코드 구현이나 Native Gate PASS가 아니다.

### 1. 이미 완료된 범위와 재구현 금지

- **W0:** T23 ContextReceipt 계약 절단 수정과 Source 검증은 [W0_RESULT](W0_RESULT.md) 재사용. Native 전 플랫폼 G0 PASS와 동일하지 않다.
- **W1/W2:** Canonical Attempt·별도 Worktree/Reservation, Host-local Turn start/status/interrupt, 조기 취소 큐잉, 중복 시작 차단, `failed/interrupted/unknown` preflight 차단을 재사용한다. 다른 MCP 프로세스의 `kernel_attach`는 같은 Run/Step과 `resume`·`workAuthority`·`trustAuthority`를 **읽기 전용**으로 복구한다. 실제 살아 있는 다른 Host의 Worker 제어를 이미 지원하는 것으로 주장하지 않는다.
- **W3:** Git 후보 캡처·범위 검사·격리 Proof preflight와 기존 `integrateParallelResults`·Owner Fence/CAS·`settleParallelResult`·`reportUnderLease`·`report.next`를 재사용한다. Owner-direct MCP 3-Step/실패 수정/Proof stale 재검증 및 Report replay는 통과했지만 **Host-owned Native Owner 정착은 미구현**이다.
- **W5:** 2026-11-06 영향 범위 MCP/App Server/Host loop/Report replay/Step resume **66/66 PASS**, Boundary·TypeScript·Build PASS. 동일 조건에서 재실행하지 않는다. 독립 MCP 프로세스 테스트도 Native Worker·Host Writer 격리 수용은 아니다.
- **W6:** [W0_BASELINE](W0_BASELINE.md)의 A/B/E/C/D 비교군·6개 Pilot·통제 변수는 유효한 사전 기준이다. B/E/C/D는 여전히 NOT_RUN.

### 2. 남은 범위·선행 조건·최종 산출물

| 기존 묶음 / Gate | 실질 미완료 | 필요한 선행 증거 | 완료 조건 및 산출물 |
| --- | --- | --- | --- |
| **A / W0·G0, W1·G1** | 실제 Native App Server + Tool + 분리 후손의 쓰기 경계, Host 생존/퇴장·재연결 및 실행 권위 판정 | 동일 mutation scope에 **두 Writer가 실제로 동시에 쓰지 못한다는 OS/Host 증거**. PID/Turn 종료·Lease·CAS·시험용 boolean은 불충분 | 지원 Native Host에서 Worker 1회 실행·종료/보호·재조회, 외부 Main 종료와 Host 종료 구분, Worker 중복 0. 미지원 플랫폼 DEFER |
| **A / W3·G3** | Host-owned 결과 후보 → 기존 Owner Fence/CAS → Canonical Report → `report.next` 연속 소비 | A의 Writer 보호와 불변 결과/Workspace Identity·Proof 유효성 | 지원 Native에서 단일 Step 실제 Owner 파일 변경·정착·Proof/Report, 이후 3~5 Step·실패 후 같은 Step 수정·중복 실행/Report 0·최종 completed |
| **B / W2·G2** | 실제 Native Host 생존 상태에서 Main 교체, 권한 요청/승인·거부 왕복, 취소·완료 경합 | 실제 Host 원본 이벤트와 사용자 인증 승인 채널. 채널이 없으면 자동 승인 금지 | 원래 Turn/Attempt를 다시 관측, 승인 대기 시 진행 0, 사용자 명시 결정만 원래 요청에 적용, 취소 경합 정합. 미지원 승인 기능은 DEFER |
| **B / W4-E·G4-E** | 요약 없는 **새 Native Thread**에서 동일 Run/Step의 후속 작업 재개 | A의 old Writer 쓰기 배제 + B의 동일 Run/Contract/Evidence 원본 재조회 + 기존 실행 결말 | Thread ID는 바뀌고 Run/Step/계약·Proof 출처는 보존, running/unknown 신규 Writer 0, 실제 Host 호출에서 안전한 재개 |
| **B / W4-C/D·G4-C/D** | E 대비 Handoff 순효과·경계 전환 트리거 비교 | E 제품 경로 수용 후 기존 [W0_BASELINE](W0_BASELINE.md) 비교에서 추가 이점 증거 | 추가 효과가 없으면 **미도입** 결정으로 종결. 자동 압축 전 신호를 관측할 수 없으면 해당 트리거 DEFER |
| **C / W5·G5** | 지원 Native Host의 I01~I12 실제 수용과 종료·경쟁·Writer late-write 공격 | 변경한 A/B 기능이 실제 실행 가능해야 함 | T05/T06/T07/T14/T15/T17/T25/T26의 영향 범위와 G5 필수 불변식 위반 0; 미관측 항목 PARTIAL/DEFER |
| **C / W6·G6** | 동일 조건 A↔B, E↔C, B↔D의 비용·품질·복구·컨텍스트 비교/채택 | B·E 등 각 Arm의 기술 수용, 실측 요금·예산/표본 승인 | 기존 6개 Pilot, 원본 Acceptance·전 환경 조건 고정. 실측 Receipt 기반 채택·LIMITED·기각, 미지원 Arm NOT_RUN |

### 3. 묶음 A — Native 안전 경계 확보 후 실제 개발 루프 연결

**A-선행 판단 (코드 변경 없이 기존 증거부터):**

1. [T49](T49_FINAL_ACCEPTANCE.md)·[T50](T50_NATIVE_OS_ISOLATION_FEASIBILITY_AND_FINAL_DECISION_2026-11-05.md)의 실패 원인을 그대로 사용한다. 현재 WSL checkout/동일 UID·분리 손자·공유 inode에선 Writer 퇴장을 입증할 수 없고, macOS/Windows Native 검증도 확보되지 않았다. **동일 환경·동일 반례의 재실험을 새 작업으로 만들지 않는다.**
2. 실제 Native Host에 이미 *실행 가능한* OS 권한/쓰기 격리 능력이 생겼다는 새 증거가 있을 때만 해당 Host에서 최소 지원 모드를 검증한다. T50 §3의 Owner 보호 경계·별도 Worker 파일 객체·App Server/Tool/후손 권한 상속·검증 가능한 결과 취득을 만족해야 한다. 단순한 `verifiedNativeWriterIsolation=true` 또는 `writerExitVerified=true` 주입을 제품 근거로 쓰지 않는다.
3. **현재 승인된 범위에는 신규 OS 사용자·DACL/ACL·Job Object·권한 상승 서비스·범용 Sandbox 구축이 없다.** 기존 Host 능력만으로 2번을 충족할 수 없으면 **A의 Native Writable 자동 실행/정착을 HOLD_SAFE/DEFER로 유지**한다. 원래 요구를 완성하려면 격리 실행 권한 또는 설계 범위 변경에 대한 **사용자의 별도 결정이 필요**하다. 이를 이유로 임의로 I03을 약화하거나 Owner-direct를 B로 위장하지 않는다.

**A-실제 구현 (위 조건을 충족한 지원 Host에서만 실행):**

1. 기존 `mcp.ts → host-worker-sessions.ts → host-owned-writable-attempt.ts → codex-app-server-transport.ts`의 실제 Host 시작/관측 지점을 쓰기 격리 능력과 연결한다. Owner 권위·Workspace Reservation·Canonical Attempt는 기존 경계를 그대로 사용한다. 요청 중단과 Worker 실행 중단/쓰기 배제를 별개의 결과로 유지한다.
2. `resultCandidate`의 Commit SHA·Base SHA·Workspace Identity·Allowed/Forbidden Paths·Proof Receipt가 현재 Run/Attempt에 속하는지 재조회한 후, **Writer 배제 증거가 존재할 때에만** 기존 `parallel-dispatcher.ts`의 검증·Owner Fence/CAS 정착 코드를 호출한다. 병렬 두 Worker 전제를 단일 Worker에 강제로 복제하거나 새 Completion Authority를 만들지 않는다.
3. `control-plane.ts`의 기존 `settleParallelResult`·`reportUnderLease`·Report replay/recovery를 사용해 **정착된 동일 결과**를 정확히 한 번 기록한다. CAS 직후 종료·Report 반복에도 새 Worker 시작/중복 파일 적용이 없도록 기존 Receipt를 재사용한다.
4. 기존 `turn-dispatcher.ts`·`host-turn.ts`·Kernel `run-loop.ts`에서 `report.next`의 실행 지시를 **단일 소비자**가 받게 연결한다. 3~5 Step·의도적 실제 Proof 실패→같은 Run/Step 수정·증거 재검증·최종 Kernel completed를 관통 확인한다. Owner-direct 경로는 변경하지 않는다.
5. Native 실제 경로를 통과해야 G1/G3 PASS. Fixture에서 CAS/Report를 성공시킨 경우는 CODE/FIXTURE PASS로만 기록한다. 미지원 Native Owner 정착은 계속 비활성화한다.

### 4. 묶음 B — 승인·취소와 요약 없는 Fresh Resume

1. **G2:** 기존 `kernel_attach/status`의 읽기 전용 재연결, Host-local live Turn 이벤트와 영속 Attempt 구분, 조기 취소를 재사용한다. 사용자 인증된 승인 입력을 전달하는 **기존 Host 호출 경로가 실제로 제공될 때만** App Server의 서버발 승인 이벤트와 응답을 원래 `threadId/turnId/requestId/attemptId`에 결합한다. 사용자 결정을 받기 전 자동 진행·자동 승인·가상 승인 응답은 금지한다. 연결이 없다면 현재 비인가 요청 실패 차단을 유지하고 승인 왕복만 DEFER한다.
2. **G2 경쟁 수용:** 동일 Run의 Main 교체·동시 Start·시작 전 취소·Turn 완료 직후 취소·승인 대기 중 연결 상실을 함께 검증한다. 신호가 이전 실행에 소급 적용됐다는 상태를 반환하지 않으며, Host 종료 뒤 다른 Host가 live handle을 가진 것처럼 표시하지 않는다.
3. **G4-E:** A의 old Writer 배제 및 원본 Kernel Contract/Evidence가 확인된 후에만 현재 Run/Step과 새 Thread를 연결한다. `agent-recovery.ts`, `work-cursor.ts`, 기존 Session Binding/Receipt를 우선 재사용한다. 연결하는 Thread ID는 권위가 아니며, `running/unknown`은 같은 Attempt를 먼저 조회하고 임의 재실행하지 않는다.
4. **G4-C/D:** E가 실제 동작한 뒤 기존 사전 등록 비교를 통해 **추가 효용이 입증된 기능만** 채택한다. 새로운 Handoff DB·강제 압축 Proxy·규칙 기반 사전 전환은 만들지 않는다. 효과 없으면 명시적 미채택으로 종료한다.

### 5. 묶음 C — 최종 Native 수용·A/B/E 실측·채택

1. **G5:** [VERIFICATION](VERIFICATION.md)의 I01~I12를 그대로 적용한다. 이미 PASS한 TypeScript/빌드·66건 영향 회귀·T49/T50 부정 증거는 재사용한다. 새 A/B 코드를 수정한 경우의 실제 Native start, Main/MCP/App Server/Host 각각 종료, 두 Writer 경쟁, 늦은 OS 쓰기, 승인·취소, secret 노출과 CAS/Report 복구에 한정해 추가 수용한다. 실제 Native 미관측이면 PASS가 아니라 PARTIAL/DEFER.
2. **G6:** [W0_BASELINE](W0_BASELINE.md)에 있는 동일 objective/acceptance/constraints/non-goals, Git 초기 SHA, model/effort, sandbox/approval, 6개 Pilot 과제를 재사용한다. **A↔B 안전·품질 선행 비교 → B 수용 후 E → E와 동일 전환 시점 C → B와 별도 전환 경계 D** 순서다. Provider 실제 Usage Receipt/비용/캐시·Reviewer·Main/Worker·wall clock·재탐색·복구 성공을 측정한다. 입력 토큰/요금이 없으면 null이지 추정치가 아니다.
3. 실제 Native 사용량 과금과 실험 예산·표본 한도는 **시험 실행 전** 승인된 값으로 기록한다. 사용자 진행 중 계정/프로세스/DB를 건드리지 않고 격리 작업 공간에서 평가한다. 위반 1건이라도 있으면 해당 Arm의 채택을 중지하며, 성능이 좋아도 품질·단일 Writer 조건을 완화하지 않는다.
4. 최종 판정은 `PASS`(지원 Native Gate/실측 채택), `LIMITED`(개선이 입증된 작업군만), `DEFER`(지원 능력 부재), `FAIL`(실제 불변식 위반), `NOT_RUN`(선행 조건 미충족)을 구분한다. G1 미지원이면 **B/E/C/D 기술·성능 채택은 미실행으로 종결**하고 기존 A를 유지한다. G6 수치나 완료율을 인위적으로 채우지 않는다.

### 6. 구현 진행·중단·커밋/수용 절차

- 기존 Moonremote `taskId`와 원본 Git 작업을 재사용한다. 매 착수 시 정확한 cwd의 체크포인트·`git status`·HEAD·실행 중 명령을 확인한다. 사용자 변경이나 실행 중 Writer를 건드리지 않는다.
- **큰 기능 묶음 단위**로 `실제 연결 구현 → TypeScript/Build → 영향 범위 테스트 → 독립 MCP/Native 제품 수용 → Gate 판정 → STATUS.md 갱신 → 한글 상세 커밋·푸시`한다. 새 T번호·마스터플랜·작은 테스트마다 커밋을 만들지 않는다.
- A의 Writer 경계가 미지원이면 **조건이 달라질 때까지 A Native 적용을 중지**하고, B 중 독립적으로 지원되는 제어·조회 기능만 진행한다. B 승인 채널이 미지원이면 승인 왕복만 DEFER한다. C의 미지원 Arm 비교는 수행하지 않는다. 이미 완료된 부분을 반복 개발해 진행률을 포장하지 않는다.
- 필요 조건을 충족시키려면 신규 OS 격리/실행 권한을 도입해야 하는 경우, **사용자가 기존 범위 확장을 승인하기 전에는 구현하지 않는다.** 범위가 바뀌지 않는 한 원래 계획의 해당 Native 목표는 DEFER이며 완료로 선언하지 않는다.
- 코드/테스트/문서 외 추가 영속 상태·DB·Queue·Scheduler·상시 Supervisor·Provider 전용 폴백 금지. 긴 작업도 추가 Worker 후손/프로세스가 기존 Owner 파일에 쓸 수 없는 조건을 통과해야 한다.
- 모든 Gate의 현재 판정과 실제 증거는 **기존 [STATUS.md](STATUS.md)**에 계속 갱신한다. 이번 문서 보완만으로 완료되지 않은 제품 기능이나 검증 결과를 PASS로 바꾸지 않는다.
