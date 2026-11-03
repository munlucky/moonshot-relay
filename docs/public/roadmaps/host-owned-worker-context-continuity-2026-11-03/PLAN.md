# Host-owned Worker · Context Continuity — 코드 구현 실행계획

- 작성/편입: 2026-11-03 (KST)
- 계획 기준 HEAD: `3797c60f662d7b61e7b57b00bc41f96bf7525e94` / `main`
- Canonical 작업 경로: Windows `C:\dev\moonshot-relay`, MCP `/shared/moonshot-relay`
- 목적: 메인 에이전트의 개발 실행 컨텍스트를 Host-owned Worker와 분리하고, 압축·교체·장애 후에도 같은 Kernel Run/Step을 안전하게 재개
- 현재: **READY FOR W0 / G0 미검증 / 생산 코드 미변경**
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
