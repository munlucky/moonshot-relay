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
| W0 — Capability/기준선 | **G0 PARTIAL** | [T31 Native Host 실제 중단·복구](W0_T31_NATIVE_HOST_DISCONNECT_AND_ATTEMPT_RECOVERY_2026-11-04.md): Mac Native command/exec 진행 중 Host SIGKILL 후 독립 Writer 생존, 재접속 Kernel Attempt·Host 외부 예약 확인, 중복 실행 0건, 새 물리 B Worktree 허용 1/1 PASS. Linux 96 PASS·6 OS SKIP. **기존 Native RPC 결과·임의 후손 종료/안전 폐기·기본 Dispatcher 적용 미검증** |
| T24 — Goals·Dispatcher 중복 진입 | **Linux 정상 Owner CAS·교차 선점 충돌 차단 PASS / Mac Native 후속 3 PASS·초기 1 FAIL 미분류 / Goals 미검증** | [정상 두 Host 경쟁·약한 Proof 반례 및 최소 수정](W0_T24_POSITIVE_OWNER_CAS_CROSS_HOST_2026-11-04.md): 전체 정상 배치 Owner Rev 0→1, 2 Report/Proof PASS; 분할 선점/약한 Proof도 Rev 0·Worktree 보존. [기존 Native 부정 경로](W0_T24_FULL_DISPATCH_NATIVE_TWO_HOST_CONFORMANCE_2026-11-04.md). 최초 Mac Native `worker-report-missing` 원인 미확정, Goals·RPC·OS 후손·성공 결과 자동 회수 미검증. G0 PARTIAL/W1 DEFER [분할 Host 결과 재시작 재조회](W0_T24_POSITIVE_OWNER_CAS_CROSS_HOST_2026-11-04.md#재시작-후-canonical-결과-재조회-검증-t24-후속): Canonical Step/Attempt·Git SHA·패치·보고서 불변 PASS, 새 Worker 0건. 자동 합류는 OS Writer 종료·단일 fence 증명 전 DEFER [기존 Owner Fence에 대한 독립 복구 Host 실제 경쟁](W0_T24_POSITIVE_OWNER_CAS_CROSS_HOST_2026-11-04.md#서로-다른-복구-host의-owner-fence-실제-경쟁-t24-후속): Linux 동시 1 획득·1 거부, epoch 증가, stale token 거부. 자동 통합 전 Writer 종료·Proof 전 Fence 수명 보호 미검증으로 G0 PARTIAL/W1 DEFER Mac Native 복구 Fence 동시 경쟁 및 정상 Owner 경로 후속 3 PASS/0 FAIL, 초기 1 Native `app_server_connection_lost` FAIL 근본 원인 미확정. G0 PARTIAL/W1 DEFER |
| T32 — Host-owned App Server 종료 정착 | **Linux·Mac Native OS 프로세스 회귀 PASS / Writer 후손 종료 미검증** | [초기화 실패·중복 close 종료](W0_T32_HOST_OWNED_APP_SERVER_SHUTDOWN_2026-11-04.md): Host가 직접 시작한 App Server 종료 대기 보완, SIGTERM 무시 후 SIGKILL 종료 이벤트 확인. 임의 Writer 후손은 계속 `writerExitVerified=false`, G0 PARTIAL/W1 DEFER |
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
5. [T31 Native Host 실제 중단·복구](W0_T31_NATIVE_HOST_DISCONNECT_AND_ATTEMPT_RECOVERY_2026-11-04.md): Mac의 실제 Codex App Server `command/exec` 실행 중 별도 Host 프로세스 SIGKILL, 이후 App Server 종료에도 A Writer가 기록을 지속했다. 신규 Kernel이 Canonical A Attempt/Workspace ID와 외부 예약을 재조회했고, 동일 Workspace 재예약 및 Provider 재실행이 거부됐다(원래 Launcher 1건, 재실행 0건). 별도 Canonical B 물리 Worktree·Host 예약에서 Native B 명령은 성공했지만 Owner Mutation Revision 0 및 Report 미승인을 유지했다. 유한 Writer 240회 기록·PID 부재를 확인한 뒤 **테스트 전용 Worktree만** 정리했다. Mac 1/1, Linux 102건 중 96 PASS·6 OS SKIP. **기존 Native RPC/Handle의 실제 재연결이나 임의 OS 후손 종료·운영 예약 안전 폐기는 미증명**. G0 PARTIAL / W1 DEFER 유지.

## 변경 범위 원칙

초기 준비 커밋은 문서만 변경했다. 후속 W0-Fix는 `src/kernel/context-build.ts` 및 2개 canonical 테스트를 수정했다. T25 후속에서는 기존 Owner CAS 회귀 테스트, **Native 이벤트↔Attempt 관측 경계**, 내부 선택형 **Host-owned App Server 읽기 전용 stdio 연결** 및 **Host 외부 single-use Writer 예약 + 선택형 Native Writable Turn 시작 전 Gate**를 추가했다. 예약은 Host가 명시적으로 사용하는 보조 경계이며 제품 기본 실행기·Parallel Dispatcher에는 자동 적용되지 않는다. 제품 기본 실행 경로·생성 Runtime·계정 설치·사용자 앱 서버·DB 스키마는 수정하지 않는다.

기존 [Ephemeral Work W7 결과](../ephemeral-work-persistent-knowledge-2026-10-31/W7_RESULT.md)는 실제 Codex in-flight 사용자 세션 재시작 및 Host 간 인계가 미수용임을 명시한다. 이 미검증을 다음 Worker 기능의 PASS로 옮기지 않는다.
