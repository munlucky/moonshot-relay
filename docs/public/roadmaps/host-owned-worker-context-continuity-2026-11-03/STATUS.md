# Host-owned Worker / Context Continuity 진행 현황

- 최종 갱신: 2026-11-04 (KST) — **W0 Context SOURCE PASS / G0 Native Capability PARTIAL**
- 기준 소스: `main / c35979c408da120e4827791700ccb5a4c06ab78f` (W0-Fix 커밋·푸시 확인)
- 문서: [PLAN](PLAN.md) · [W0 착수](W0_START.md) · [검증 계약](VERIFICATION.md)
- 이 파일의 상태는 **새 제품 기능의 PASS가 아니다.**

| 항목 | 상태 | 증거·다음 조치 |
| --- | --- | --- |
| v2 전략·검증 기준 분석 | 완료 (문서 검토) | 2026-11-03 제공된 v2 두 문서와 코드 기반 실행계획 사용 |
| Linux/Windows-side MCP canonical code | 읽기 전용 조사 완료 | `src/host/kernel`/`src/kernel/run`/`src/kernel/persistence` 및 `context-build.ts` |
| Mac-side MCP canonical checkout | 조회 완료 | 문서 편입 전 양쪽 `main / 3797c60f`, 별개 Runtime·DB·세션 |
| 기존 사용자 작업 간섭 | 없음 (준비 작업 범위) | 사용자 Runtime/DB·Codex 세션 종료·설치·마이그레이션 없음 |
| 프로젝트 로드맵 문서 정착 | **완료** | 2026-11-03 초기 문서와 W0-Fix를 `main`에 커밋·푸시 확인 |
| W0 — Capability/기준선 | **G0 PARTIAL** | [T27 실제 후손 Writer 생존 반례](W0_T27_NATIVE_DESCENDANT_SURVIVAL_AND_RETIREMENT_GATES_2026-11-04.md): Mac 실제 command/exec 종료·App Server 종료 뒤 분리된 OS Writer가 추가 쓰기 6/6 PASS. Linux 실제 OS detached Writer + Canonical Attempt/예약 반례 확대 95 PASS·1 Windows SKIP·0 FAIL. 종료 증거·안전 폐기/Owner CAS Delivery 미구현 |
| W0-Fix — ContextReceipt | **SOURCE PASS** | T23 재현 → 최소 수정, focused 17/17, typecheck/build/boundaries PASS. 확장 test:source-runtime timeout |
| W1 — Host-owned Worker | **DEFER / 실제 Attempt-Writer Gate 대기** | Host 소유 Native commandExecution handle과 격리 Worktree/기존 Owner CAS를 연결해 종료·격리 증거 확인 전 같은 Workspace 재할당 금지 필요 |
| W2 — status/signal/reconnect | NOT STARTED | W1 생존·Owner 경계 필요 |
| W3 — Kernel loop 결합 | NOT STARTED | 기존 Dispatcher/Goals 중복 먼저 확인 |
| W4 — E/C/D Continuity | NOT STARTED | E(요약 없는 Resume) 먼저 |
| W5 — 장애/경쟁/보안 | NOT STARTED | 각 Wave 집중 테스트 후 종합 수용 |
| W6 — A/B/E/C/D 품질·총비용 | NOT STARTED | 사전 등록된 동일 조건 평가 |

## W0 수행 결과 (2026-11-03)

- 코드/테스트 변경: `src/kernel/context-build.ts`, `tests/kernel-context-compiler.test.ts`, `tests/kernel-context-policy-authority.test.ts`. 새 public API/DB/스킬 없이 필수 Context silent truncation 방지.
- W0 결과 문서: [W0_CODE_MAP](W0_CODE_MAP.md) · [W0_CAPABILITY_MATRIX](W0_CAPABILITY_MATRIX.md) · [W0_BASELINE](W0_BASELINE.md) · [W0_RESULT](W0_RESULT.md).
- 격리 Linux TypeScript 7.0.2 빌드·타입·경계·focused 17/17 PASS. 전체 `test:source-runtime`은 16개 subtest `ok` 뒤 240초 timeout. 이후 **실행되지 않았던 세 번째 suite만 별도로 4/4 PASS**. 전체 단일 명령 종료는 미확인.
- Native Windows executor heartbeat stale. Mac Native 미인증·빈 Thread에서 `thread/resume`와 이력 읽기가 실패하고 `shellCommand` 경로가 401을 기록했던 것은 [이전 Native 실험](W0_NATIVE_FOLLOWUP_2026-11-03.md)의 결과다. **이후 사용자 승인으로 분리 CODEX_HOME 인증을 확보**, 실제 단일 Turn `completed` 및 새 클라이언트의 `thread/read(includeTurns=true)`를 PASS 확인했다. [새 인증 검증](W0_AUTH_TURN_RESULT_2026-11-03.md). 실제 in-flight 연결 교체와 프로세스 차단은 여전히 미검증. 사용자 운영 세션·DB 변경 없음.
- [Native in-flight 추가 검증](W0_INFLIGHT_CONNECTION_LIFECYCLE_2026-11-03.md): Host 역할 WebSocket 유지 시 별도 클라이언트에서 Turn 재조회·중단 PASS. App Server 재시작 뒤 중단 Turn 이력 조회 PASS. **이후 [T25 실제 OS Writer 시험](W0_T25_OS_WRITER_FENCING_2026-11-03.md)에서 중단 RPC 뒤 자식 Python Writer가 살아 있었고 1.8초 사이 추가 쓰기 9회 발생.** OS group 종료/정착 독립 fixture는 PASS. G0 PARTIAL, W1 미착수.

## 다음 세션의 정확한 재개 지점

1. `get_work_context(cwd="/shared/moonshot-relay", format="full")`를 먼저 실행해 active task/마지막 영수증/현재 Git 상태를 대조.
2. `W0_START.md`의 "0. 입장 조건" 수행. 완료된 분석·명령은 반복하지 않음.
3. **완료한 T23 수정·인증·실제 Turn 완료·Native WebSocket 수명 비교·Turn-level interrupt·재시작 이력 조회를 반복하지 않음.** 다음에는 실제 Moonshot Relay의 Main/Host 실행 연결 분리, OS Writer 물리 중단·중복 실행 금지, Windows Native executor heartbeat 복구부터 시작. 기존 사용자 세션 종료 금지.
4. [T25 추가 음성 검증](W0_T25_ADDITIONAL_NEGATIVE_VERIFICATION_2026-11-03.md)에서 실제 A Writer가 살아 있는 상태로 동일 Workspace Lock 재획득/추가 쓰기 5회와 별도 Worktree A/B 물리 격리 PASS를 확보. **Main/Host 연결 해제 중 Native Handle 회수는 이번 모델 시험에서 Writer 미생성으로 미검증.** 다음은 Attempt↔Native 실행 스트림 결합, 같은 Workspace Writer 재허가 Gate 및 실제 Delivery CAS 통합 검증. 완료된 시험 반복·새 DB/Queue/Provider별 하드코딩 금지.
5. [T27 Native 후손 생존·폐기 보류 검증](W0_T27_NATIVE_DESCENDANT_SURVIVAL_AND_RETIREMENT_GATES_2026-11-04.md): **실제 Mac command/exec exit 0 및 App Server 종료 뒤에도 OS Writer가 추가 기록**하는 반례 재현(6/6). Linux의 실제 detached Writer/Kernel Attempt 회귀 확대 96건 중 95 PASS·1 Windows SKIP. **단순 Turn 완료·App Server PID/Process Group 종료를 Worktree 폐기 증거로 사용하지 않는다.** 다음은 OS 강제 containment·종료 후 재관측·안전 폐기 조건 및 Worker Report→Owner CAS Delivery 통합이다. 기본 Dispatcher/DB는 미변경, G0 PARTIAL / W1 DEFER 유지.

## 변경 범위 원칙

초기 준비 커밋은 문서만 변경했다. 후속 W0-Fix는 `src/kernel/context-build.ts` 및 2개 canonical 테스트를 수정했다. T25 후속에서는 기존 Owner CAS 회귀 테스트, **Native 이벤트↔Attempt 관측 경계**, 내부 선택형 **Host-owned App Server 읽기 전용 stdio 연결** 및 **Host 외부 single-use Writer 예약 + 선택형 Native Writable Turn 시작 전 Gate**를 추가했다. 예약은 Host가 명시적으로 사용하는 보조 경계이며 제품 기본 실행기·Parallel Dispatcher에는 자동 적용되지 않는다. 제품 기본 실행 경로·생성 Runtime·계정 설치·사용자 앱 서버·DB 스키마는 수정하지 않는다.

기존 [Ephemeral Work W7 결과](../ephemeral-work-persistent-knowledge-2026-10-31/W7_RESULT.md)는 실제 Codex in-flight 사용자 세션 재시작 및 Host 간 인계가 미수용임을 명시한다. 이 미검증을 다음 Worker 기능의 PASS로 옮기지 않는다.
