# Host-owned Worker / Context Continuity 진행 현황

- 최종 갱신: 2026-11-05 (KST) — **Windows Native Host 실행기 실측 PASS / 별도 OS 권한 격리 DEFER / HOLD_SAFE**
- Windows Host 후속: [Native MCP 실행 연결 확인](WINDOWS_NATIVE_HOST_EXECUTOR_FOLLOWUP_2026-11-05.md). `executionTarget=host`에서 Windows 10.0.19045, `C:\\dev\\moonshot-relay`, 실제 출력/exit 0 관측. 보안 토큰·권한 조사 요청은 도구 안전 검사로 차단됨. 실제 별도 토큰 프로세스/Owner 쓰기 배제 미증명으로 제품 자동 합류 미승인.
- Windows Native 로컬 인계: [MCP 인계 증거·해시·판정](LOCAL_NATIVE_VERIFICATION_MCP_HANDOFF_2026-11-05.md). ZIP 28개 파일 무결성 및 11개 evidence SHA 일치. L0 PASS, L1 PARTIAL(동일 SID 직접·하드링크 쓰기 허용), L2~L5 DEFER, Kernel blocked/external-dependency. 실제 보안 주체·Native Tool 권한 상속 미검증으로 자동 합류 미승인.
- T50 후속: [Native OS 격리 실행 가능성·최종 판정](T50_NATIVE_OS_ISOLATION_FEASIBILITY_AND_FINAL_DECISION_2026-11-05.md). WSL2 namespace EPERM/cgroup 비쓰기, checkout 777 확인. 별도 UID 아래 Owner 직접·symlink·사전 hardlink 및 분리 후손 늦은 쓰기 차단 관측. 실제 Native App Server/Tool 전체 보안 경계와 macOS·Windows Native 미검증으로 자동 합류 계속 비활성.
- T49 실행 결과: [A–E 증거 매트릭스](T49_PARALLEL_EVIDENCE_MATRIX.md) · [P2 기술 결정](T49_DECISION.md) · [G0–G6 수용 판정](T49_FINAL_ACCEPTANCE.md). **후속 Linux Kernel 집중 회귀 12 PASS / 0 FAIL / 2 macOS SKIP**, 타입·모듈 경계 검사 PASS. OS Native 쓰기 배제 미증명으로 P2 HOLD_SAFE 및 W1 DEFER 유지.
- 기준 소스: `main / c35979c408da120e4827791700ccb5a4c06ab78f` (W0-Fix 커밋·푸시 확인)
- 문서: [PLAN](PLAN.md) · [W0 착수](W0_START.md) · [검증 계약](VERIFICATION.md) · [T49 이후 병렬 통합 실행계획](T49_END_TO_END_PARALLEL_VERIFICATION_EXECUTION_PLAN_2026-11-05.md)
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
| T33 — Native OS 후손 group 종료 반례 | **Mac 실제 1 PASS / G0 PARTIAL** | [T33 선택형 Native 실측](W0_T33_NATIVE_OS_GROUP_CONTAINMENT_NEGATIVE_2026-11-04.md): 소유한 App Server 그룹 전체 종료와 분리된 Writer의 별도 PGID 생존을 구분. 새 자동 폐기·killpg 도입 없음. |
| T34 — Proof 이전 Owner Fence 수명 | **Linux·Mac OS 실제 음성 반례 PASS / 자동 복구 DEFER** | [T34](W0_T34_PRE_PROOF_FENCE_LIFETIME_2026-11-04.md): 정상 Proof 중 기존 Fence의 경쟁 차단 확인. Trusted Proof Timeout 후 분리 OS Writer가 새 Host Fence 획득 뒤에도 통합 시험 경로에 쓰는 반례 재현. 제품 Fence 이동·자동 합류 금지. |
| T35 — Trusted Proof OS 쓰기 격리 | **Mac 실제 선택형 실행 PASS / 자동 결과 합류 DEFER** | [T35](W0_T35_TRUSTED_PROOF_WRITE_CONTAINMENT_2026-11-04.md): `realpath` 정규화된 macOS Seatbelt writeScope 선택형 경계. Linux·Windows OS 수단 없으면 실행 거부, 기존 Proof 기본값 미변경. 자동 합류 G0 PARTIAL/W1 DEFER. |
| T36 — 복구별 물리 통합 Worktree | **Linux·Mac 실측 PASS / 자동 복구 DEFER** | [T36](W0_T36_RECOVERY_INTEGRATION_WORKTREE_ISOLATION_2026-11-04.md): 별도 Runtime 영역에 매 복구 시도마다 새로운 물리 Git Worktree를 생성해 기존 Proof 후손이 수정하던 경로를 다시 사용하지 않도록 준비. OS 쓰기 격리 및 Owner Fence는 별도로 검증. |
| T37 — 통합 전 구간 Owner Fence 수명 | **Linux 36 PASS·Mac 직렬 7 PASS / 기본 Dispatcher 전환 DEFER** | [T37](W0_T37_PREPROOF_OWNER_FENCE_LIFECYCLE_2026-11-04.md): 최초 cherry-pick 전에 Fence 획득, Proof·Owner CAS·정착 시도 내내 타 Host 차단, 만료 Token 거부. 정상 Canonical Report 승인과 자동 회수는 아직 미검증. |
| T38 — CAS 후 독립 Host 복구 경계 | **Linux 38 PASS·Mac 4 PASS / 자동 합류 DEFER** | [T38](W0_T38_POST_CAS_CROSS_HOST_RECOVERY_2026-11-04.md): 별도 OS Host A/B/C가 정상 Worker 정착과 CAS 직후 Host 비정상 종료 후 blocked 재조회·중복 Worker 없음 검증. Native 물리 Writer 종료 및 자동 회수는 미증명. |
| T39 — Native Grandchild OS Writer 수명 | **Mac Native 실물 1 PASS / 임의 Writer 종료 DEFER** | [T39](W0_T39_NATIVE_WRITER_DESCENDANT_LIFETIME_2026-11-04.md): 기존 Mac Native direct command/exec 후 Supervisor 종료·별도 PGID 손자 Writer 생존 및 Sandbox 상속 반례. 모든 후손 종료 미증명, 예약 자동 해제 금지. |
| T40 — Native Crash 후 세대별 쓰기 격리 | **Mac Native 1 PASS / 자동 정착 DEFER** | [T40](W0_T40_NATIVE_GENERATION_FENCE_OS_WRITE_ISOLATION_2026-11-04.md): T31에 T36의 복구 Integration Worktree와 Owner Fence 만료·재획득 및 이전 Native Writer의 새 세대·Owner OS 쓰기 거부 실증 추가. |
| T41 — 선택형 전 구간 Owner Fence + OS Scoped Proof | **Linux 37 PASS·Mac 9 PASS / 기본 경로·Native 자동 재회수 DEFER** | [T41](W0_T41_GUARDED_DISPATCH_INTEGRATION_FENCE_2026-11-04.md): macOS 명시적 보호 모드에서 첫 cherry-pick 전 Fence, 새 복구 Worktree, OS 제한 Proof, CAS 및 Report 정착 후 Fence 해제. |
| T42-A — Cross-Host Canonical Result readback | **Linux 37 PASS·Mac Native 6 PASS / Owner 자동 합류 DEFER** | [T42-A](W0_T42_SPLIT_HOST_CANONICAL_READBACK_2026-11-04.md): Git·Attempt 무결성 재조회, Native Writer 종료/Delivery 미승인. |
| T42-B1 — 분리 Host Canonical Result 보호된 사전 Proof | **Linux 37 PASS·Mac Native 3 PASS / Owner Delivery DEFER** | [T42-B1](W0_T42B_GUARDED_CANONICAL_RECOVERY_PREFLIGHT_2026-11-04.md): 기존 Fence·새 Integration Worktree·Scoped Proof, 실제 CAS 및 Report 자동 회수 없음. |
| T42-B2-A — 종료 증명이 있는 두 Host 결과의 Owner CAS·Report 검증 | **Linux 37 PASS·Mac 동기식 실증 3 PASS / Native 자동 합류 DEFER** | [T42-B2-A](W0_T42B2_FINITE_SPLIT_OWNER_CAS_SETTLEMENT_2026-11-04.md): 동기식 Fixture 기존 Kernel Fence·CAS 1회·Report 2회 테스트. 제품 자동 합류 미구현. |
| T42-B2-B — 과거 Host 결과 Owner CAS 직후 복구 Host 종료 | **Linux 38 PASS·Mac 4 PASS / Native 자동 합류 DEFER** | [T42-B2-B](W0_T42B2_POST_CAS_CRASH_2026-11-04.md): 실제 Recovery Host CAS 중단 후 다른 Host fail-closed Recovery. |
| T42-B2-C — 첫 Cherry-pick 전 두 복구 Host 경쟁·Proof 중 TTL 만료 | **Linux 집중 6 PASS·확대 27 PASS/2 SKIP·Mac 6 PASS / Native 자동 합류 DEFER** | [T42-B2-C](W0_T42B2C_RECOVERY_CONTENTION_TTL_2026-11-05.md): 실제 복구 Host 경합에서 1 CAS·2 Report, Proof 중 TTL 만료 후 새 Epoch·Worktree, 이전 Token 갱신·적용·CAS 차단. |
| T43 — Proof 중 이전 Writer 지연 쓰기·Receipt 재검증 | **Linux 집중 7 PASS·확대 28 PASS/2 SKIP·Mac 신규 1 PASS·전체 6 PASS/1 FAIL / Native 자동 합류 DEFER** | [T43](W0_T43_PROOF_TIME_STALE_WRITER_RECEIPT_DRIFT_2026-11-05.md): 기존 Step Worktree 지연 쓰기를 Proof 중 재현하고 재조회 차단 확인. |
| T43-A — Mac split-weak-proof 간헐 종료 원인 추적 | **기준선 전체 7 PASS·관측 개선 후 전체 7 PASS·Linux 15 PASS/2 OS SKIP; 기존 단발 FAIL 원인 미확정** | [T43-A](W0_T43A_WEAK_PROOF_HOST_EXIT_DIAGNOSTICS_2026-11-05.md): Host signal/PID 기록 및 조기 실패 시 자식 Promise 정착 보강, 제품 코드 미변경. |
| T44 — Native Sandbox 하드링크·경로 별칭 격리 | **Mac Native 1 PASS·Linux 7 PASS/2 OS SKIP; 사전 존재 하드링크 외부 쓰기 100회 확인 / 자동 합류 DEFER** | [T44](W0_T44_NATIVE_HARDLINK_ALIAS_WRITE_ISOLATION_2026-11-05.md): 새로운 외부 하드링크 생성과 심볼릭 링크 쓰기 거부, 사전 존재 외부 inode 하드링크 우회 발견. |
| T45 — Git clean Worktree의 외부 inode 별칭·Native 재사용 | **Linux 5 PASS·Mac 5 PASS / Git clean으로 하드링크 비존재 증명 불가 / Native 자동 합류 DEFER** | [T45](W0_T45_CLEAN_WORKTREE_HARDLINK_ADMISSION_2026-11-05.md): 추적 파일을 동일 내용 외부 하드링크로 교체해도 Git clean과 같은 Attempt 재사용 통과, 이후 Owner inode 변경. 기존 Reservation은 별개. |
| T46 — 동일 OS 계정 외부 Writer의 Worktree 생성 후·실행 중 변경 | **Linux 6 PASS·확대 11 PASS/1 SKIP·Mac 6 PASS / 자동 합류 DEFER** | [T46](W0_T46_SAME_ACCOUNT_EXTERNAL_WORKTREE_MUTATION_2026-11-05.md): 외부 OS 프로세스가 생성 직후와 Writer 실행 중 Worktree를 변경하지만 중복 Host 예약은 거부됨. |
| T47 — OS 사용자 권한·Sandbox 지속 격리 비교 | **Linux 비특권 다른 UID DAC 쓰기 거부·Mac chmod 동일 UID 복구·Seatbelt 비참여 형제 쓰기 허용 / Native 자동 합류 DEFER** | [T47](W0_T47_OS_WRITER_OWNERSHIP_ISOLATION_FEASIBILITY_2026-11-05.md): 현재 Native 실행 계약에 지속 OS 쓰기 배타성 미증명. |
| T48 — Native Codex App Server OS 격리 도메인 초기화 | **Mac 격리 CODEX_HOME + canonical Seatbelt initialize PASS / 모델 Turn·전체 후손 종료 미증명, 자동 합류 DEFER** | [T48](W0_T48_NATIVE_APP_SERVER_SECURITY_DOMAIN_2026-11-05.md): App Server 초기화 전역 쓰기 Scope 실측. Turn Sandbox는 별개이며 외부 비참여 Writer는 제한하지 못함. |
| W0-Fix — ContextReceipt | **SOURCE PASS** | T23 재현 → 최소 수정, focused 17/17, typecheck/build/boundaries PASS. 확장 test:source-runtime timeout |
| W1 — Host-owned Worker | **CODE/WIRED PARTIAL · G1 Native DEFER** | 기존 MCP `kernel_next`에 Host-검증 Capability로 제한한 단일 Writable Attempt 시작 경로 연결, Owner 범위 단일 예약·Canonical Attempt 유지. Main 호출 후 Turn 지속·중복 시작은 격리 Fixture 통과. 일반 제품 Host에서는 OS 격리 미증명으로 시작 차단. 실제 Main 종료 후 독립 Host 생존, OS Writer 후손 차단·자동 Owner 합류는 미검증/보류 |
| W2 — status/signal/reconnect | **CODE/WIRED PARTIAL · G2 Native PARTIAL** | 기존 `kernel_status`로 영속 Attempt와 동일 Host 실시간 Turn 조회, 기존 `kernel_attach`에서 Turn interrupt 요청 연결. 다른 Main 호출의 조회·중단, 다른 Host의 미보유 핸들 거부 Fixture 통과. 실제 Native Main 교체·승인 전달·Host 비정상 종료 후 재연결은 미완료 |
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
