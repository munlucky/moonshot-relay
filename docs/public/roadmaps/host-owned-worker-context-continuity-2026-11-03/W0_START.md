# W0 착수 지침 — Capability Baseline / ContextReceipt 안전성

- 작성: 2026-11-03
- **W0 미실행.** 이 파일은 다음 Moonremote 또는 로컬 Codex 세션에서 바로 실행할 단일 Wave 작업 범위다.
- 기준: [PLAN.md](PLAN.md), [VERIFICATION.md](VERIFICATION.md)
- 최초 기준선: `main / 3797c60f662d7b61e7b57b00bc41f96bf7525e94`. 작업 시작 때 실제 HEAD·dirty file 재조회. 문서 편입 커밋 이후 SHA는 변경될 수 있음.
- 진행 전략: W0.3 ContextReceipt 코드 재현과 W0.1 Host 수명 probe는 서로 독립적으로 조사할 수 있으나, 사용자 기존 작업과 계정 Runtime은 보호한다. 결과 없이 W1 기술 선택을 확정하지 않는다.

## 0. 입장 조건 — 실행 전 1회

1. Windows/Linux 쪽 `/shared/moonshot-relay`의 `get_work_context(format=full)` 먼저 호출. 동일 workspace의 활성 task가 있으면 재개, 없으면 새 task checkpoint. Kernel Run 계약을 다시 생성하지 않음. Mac도 `/shared/moonshot-relay`을 조회하지만 별도 Host/SQLite/프로세스라는 점을 유지.
2. `git status --short --branch`, `git rev-parse HEAD`, `git remote -v`로 현재 상태 확인. 현재 사용자 변경을 합치거나 리셋하지 않음. 주 실행 Host를 하나 선택, 다른 Host는 관측 전용.
3. `AGENTS.md`, `docs/public/development.md`, `package/source-layout.json` 검토. 수정은 `src/**/*.ts`, 대응 `tests/**/*.ts`를 원칙으로 하고 생성된 `scripts/**`, `dist/**` 및 테스트 wrapper `tests/*.mjs`는 수동 변경하지 않음.
4. 진행 중 사용자 Codex/Kernel Run, 사용자 DB, 실제 app-server 세션은 종료하지 않음. Native probe는 **새 테스트 전용 Thread·임시 프로젝트·격리 Runtime**을 우선 사용. 조건에 따라 실제 사용자 실행 파괴가 필요하면 해당 시험 DEFER.
5. 명령별 고정 `taskId+operationId`. `prepared/running/unknown`은 새 ID로 재시도 금지; `read_process` `nextSeq/afterSeq` 소비 후 판정.

## W0.3 — 첫 번째 독립 작업: ContextReceipt 위험 재현

**코드 위치**

- `src/kernel/context-build.ts` — `buildKernelContext()` 후반: `stageTokenBudget` 초과 시 선택 블록 제거 → 최종 `promptBlock.slice(...)` → 이전 `blocks.entries`를 기준으로 `included` 작성.
- `src/contracts/context-receipt.ts` 및 `src/host/kernel/context-segments.ts` — receipt schema와 실제 wire 소비 위치 확인.
- `tests/kernel-context-compiler.test.ts`, `tests/kernel-context-payload-redaction.test.ts` — canonical unit fixture 재사용.
- `tests/context-budget.test.mjs`는 존재하지만 대응 `tests/context-budget.test.ts`는 2026-11-03 조회에서 확인되지 않았음. **실제 테스트 owner를 확인하고 생성 wrapper나 legacy runner를 무조건 편집하지 않는다.**

**재현 절차**

1. 기존 `buildKernelContext`의 블록 우선순위, `makeContextReceipt`, Host prompt assembly 호출자를 찾아 최소 fixture를 작성한다.
2. 긴 Task Contract 마지막에 `반드시 금지하는 명령/경로`가 오도록 예제를 만든다. `stageTokenBudget`을 변경해 정상·선택적 블록 제거·최종 문자 절단이 발생하는 경계를 각각 실행한다.
3. `receipt.included`의 entry들이 실제 완성된 `promptBlock`에 완전히 표현되는지 검사한다. 일부 문자가 잘린 entry를 포함으로 보고하는 경우 실패를 재현한다.
4. **결함 재현 시 W0-Fix 별도 최소 패치:** 필수 계약을 잘라서 보낸 뒤 included로 보고하지 않는다. 계약 자체가 예산을 넘으면 fail-closed 또는 유효한 계약 보존 전략 중 실제 schema/Host 호출에 맞는 쪽 선택. Stage/Evidence 등 선택적 자료부터 제한한다.
5. redaction, ordering, context budget, receipt digest 회귀를 focused tests와 타입/빌드로 검증. "필수 제약의 실제 운영 누락"은 실모델 wire에서 재현하지 못한 경우 여전히 가설로 둔다.

**첫 검증 명령 후보 (생성물 최신일 때)**

```sh
npm run typecheck
npm run build:tests
node --test tests/kernel-context-compiler.test.mjs tests/context-budget.test.mjs tests/kernel-context-payload-redaction.test.mjs
npm run check:boundaries
npm run build:check
```

실행 전에 `package.json`에 명령이 있는지 확인한다. 패치가 없다면 failure 재현 또는 KEEP/NO-CHANGE 근거만 기록할 수 있다. 즉시 임의의 Provider별 예외를 추가하지 않는다.

## W0.1 — Host Capability Probe

1. `src/host/kernel/adapters/codex.ts`의 `createCodexNativeAgentLauncher`와 `createCodexAdapter` 실제 호출자를 추적한다. 현재 `waitForOutcome/wait/result`가 반환을 기다리는 경로임을 확인하고 **독립 start/status handle**의 존재 여부를 실험한다.
2. Codex Native `spawn_agent`, 로컬 App Server thread API의 실제 설치본/버전/권한/로그 제공 범위를 Host별 기록한다. 문서의 지원을 실제 설치본의 동작으로 대신하지 않는다.
3. 격리된 새 worker에서 (a) Main 연결 종료, (b) MCP 연결 종료, (c) App Server 종료, (d) Host 프로세스 종료를 분리 시험한다. (c)/(d)는 실제 사용자 환경에 영향이 있으면 실험하지 않고 DEFER.
4. 각 종료 직전/후 `threadId, turnId, pid, process group, attemptId, runId, stepId, workspace identity`와 command 생존/안전 정지/재개 가능성을 기록한다. 없는 항목은 null.
5. Provider가 실제로 기록한 JSONL/event의 존재·조회 가능 범위·redaction·compaction/재시작 전후 digest를 확인. 내부 reasoning 전부 보존을 주장하지 않는다.

**산출:** `W0_CAPABILITY_MATRIX.md`. Host별 `worker_alive_after_main`, `worker_alive_after_mcp`, `worker_alive_after_app_server`, `worker_alive_after_host`, `thread_resume`, `inflight_command_resume`, `status_requery`, `approval_signal`, `cancellation`, `original_transcript_access`를 PASS/PARTIAL/FAIL/DEFER/unknown과 증거 참조로 분리.

## W0.2 — Loop / Attempt / Owner 실행 그래프

- 검사 파일: `src/host/kernel/turn-dispatcher.ts`, `host-turn.ts`, `parallel-dispatcher.ts`, `session-affinity.ts`, `codex-session-observer.ts`, `src/kernel/run/run-loop.ts`, `agent-recovery.ts`, `src/kernel/persistence/host-execution-store.ts`, `work-attempt-store.ts`.
- 실제 `next→execute→report` 및 `report.next` 소비 주체(원본 함수 호출 지점)를 지도화. Codex Goals 사용 가능 여부와 동시에 루프가 돌 위험이 있는지 T24로 구분.
- `spawn succeeded / response lost`를 기존 Dispatcher가 failed로 확정하는지 T05 가상/격리 fixture로 재현. 출력을 잃은 정상 프로세스를 재호출하지 않는 실행 영수증·Attempt 조회 경계를 확인.
- `runId/stepId/attemptId/actorSessionId/route admission/lock/fencing token`이 어떤 시점에 저장되는지 저장/재시작 전후 확인.
- CAS/Lease 이후 OS Writer가 살아 있을 수 있는 상황을 `G1/G4/G5` 선행 위협 모델로 기록. 이번 W0에서 실제 사용자 프로세스로 late-write 공격을 실행하지 않는다.
- 기존 `W7_RESULT.md`의 네 Host source/isolated E2E PASS를 새 Worker feature PASS로 승격하지 않는다.

**산출:** `W0_CODE_MAP.md` (호출 그래프·단일 loop 후보·기존 재사용 경계·정확한 미지원 API·새 상태 저장 필요 여부).

## W0.4 — 실험 사전 등록 / 선택 지점

- A/B/E/C/D를 실제 동일 task, Acceptance/금지조건, 초기 Git SHA·Workspace snapshot, Host/모델/effort, sandbox/approval, tool set, 비용·시간 예산으로 고정한다.
- 최소: 긴 구현, 대량 도구출력, 반복 디버깅, 복잡한 제약, 승인 대기/중단 복구, 단순 구현. 같은 task를 다른 Arm으로 재사용할 때 독립 checkout과 순서 교차를 기록.
- 정확성·중복 mutation·false done은 절대 비열화 금지. 성능·비용 수용 상한은 실험 시작 전 기록; Provider usage 미지원은 null.
- W1 구현 기술 판단: (a) Host-owned live worker가 실제로 가능한 기술, (b) 안전 중단·재개만 가능한 기술, (c) 지원하지 않는 기술을 구분. (b)를 (a)로 분류하지 않는다.
- E(요약 없는 Resume)를 C(서술 Handoff) 앞에 두고 동일 전환 시점 비교. D는 전환 타이밍만 실험. 서술 Handoff나 Goals/MCP Tasks 도입은 capability·추가 효용 근거 없으면 채택 보류.

**산출:** `W0_BASELINE.md`. 시험 목록·채택/중단 기준·Host/모델/환경·측정 필드와 관측 불가능 필드 명시.

## W0 종료 체크리스트 (G0)

- [ ] Source/Host/Capability/Owner/Loop/Context 문제를 **관찰된 사실 vs 위험 가설**로 분류했는가?
- [ ] T23의 prompt/receipt 완전성 fixture를 실행했는가? 결함이 있다면 W0-Fix 독립 변경 및 검증 증거가 있는가?
- [ ] T24 중복 자동 loop, T26 Main/MCP/App Server/Host 수명, T18 원본 보존/미관측을 Host별로 분류했는가?
- [ ] `running/unknown` 중복 실행 금지와 old Writer 실제 생존 문제를 W1 설계에 반영했는가?
- [ ] W0 자료 4개를 만들고 `VERIFICATION.md`에 따른 G0 판정을 기록했는가? 미지원 Runtime을 PASS로 두지 않았는가?
- [ ] 불필요한 DB, Scheduler, 새 필수 도구/프롬프트, Provider별 하드코딩 또는 fallback 없이 해결 가능한가?
- [ ] 관련 테스트 실행 log/exit code, Git diff, 코드/운영 변경 범위, 후속 첫 실행을 명시했는가?
- [ ] 완료된 W0 작업을 한국어 상세 커밋/푸시했으며 `STATUS.md`와 Moonremote checkpoint를 현행화했는가?

**Stop Rule:** G0 capability가 없는 Host에서는 W1 live worker 배포를 DEFER한다. Context 결함은 별도 수정 가능. G0 미충족 상태에서 W1을 무조건 구현하거나 자동 Handoff 시스템을 확장하지 않는다.
