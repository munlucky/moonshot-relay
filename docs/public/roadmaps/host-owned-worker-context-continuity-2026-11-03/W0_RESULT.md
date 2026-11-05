# W0 결과 — ContextReceipt T23 보완 및 Host Capability 사전 조사

- 작성: 2026-11-03
- 시작 소스: `main / 77b55f52c7035f570532078424bf28c1567625fe`, 초기 작업 트리 clean
- **T23 함수-level 수정: SOURCE PASS**
- **G0 통합 수용: PARTIAL** — Native App Server에서 Host 연결 유지 조건의 in-flight Turn 재조회·다른 연결의 interrupt는 확인했으나, 실제 Moonshot Relay Main/Host 통합·OS Writer 중단·명령 재개는 미검증
- W1: **DEFER / 미착수**. Host capability 검증 전 Controller·Worker DB·새 Scheduler를 구현하지 않음.
- 세부: [W0_CODE_MAP](W0_CODE_MAP.md) · [W0_CAPABILITY_MATRIX](W0_CAPABILITY_MATRIX.md) · [W0_BASELINE](W0_BASELINE.md) · [인증 및 완료 Turn 검증](W0_AUTH_TURN_RESULT_2026-11-03.md) · [in-flight 수명 검증](W0_INFLIGHT_CONNECTION_LIFECYCLE_2026-11-03.md) · [VERIFICATION](VERIFICATION.md)

## 1. 확인된 문제 (관측)와 불명확한 문제 (가설)

**관측된 T23 결함:** `src/kernel/context-build.ts`의 `promptBlock` 직렬화 후 budget 초과 문자열 자르기 단계에서, 긴 Task Contract의 마지막 `FORBID_REMOVE_PROJECT_DIR` 제약이 실제 반환 프롬프트에서 사라졌다. 반면 Receipt에는 `task-contract`이 여전히 `included`로 기록됐고 `omitted=[]`이었다. 좁은 `contextPolicy` fixture를 지정한 **함수 수준 재현**이다. 실제 코딩 모델의 오류로 발생했다는 실증은 없다.

**관측된 실행 구조:** 현재 Codex Native launcher는 `spawn_agent`를 호출한 다음 `waitForOutcome/wait/result`를 `await`한다. 따라서 지금의 함수 호출 수명만으로 독립적인 Worker service/재연결이 보장된다고 주장할 수 없다.

**미확인:** 실제 Codex 앱 서버의 독립 Thread/Turn status/reconnect/approval/cancel; Main 연결·MCP 연결·App Server·Host 프로세스 종료 이후 Worker 상태; Goals와 Host loop의 중복 실증; 실제 old Worker late write 물리 차단; 원본 terminal event 완전성.

## 2. T23 최소 코드 수정

| 소유 원본 | 변경 |
| --- | --- |
| `src/kernel/context-build.ts` | `Stable Principles`/`Task Contract`의 silent truncation 제거, stage budget 초과 시 선택 block부터 제외, 필수 내용이 여전히 초과하면 `kernel_context_required_content_exceeds_budget`로 fail-closed |
| `tests/kernel-context-compiler.test.ts` | T23: 마지막 금지 제약 보존, 예산 초과 명시적 실패, 선택 context 제거 후 Receipt omitted 일치 |
| `tests/kernel-context-policy-authority.test.ts` | 과거의 “필수 Context도 자동 잘라서 성공” fixture를 보존 우선 계약으로 갱신 |

추가 public Kernel 명령, DB table/column, Provider별 fallback, 새 skill/상시 Worker, Schema 변경, 설치 Runtime 수정 없음. `src/host/kernel/context-segments.ts`는 별도 Host segment compiler라 이번 패치 대상이 아님.

**의도한 동작 변화:** 필요한 원칙·계약을 budget 안에 담을 수 없으면 기존처럼 불완전한 prompt를 보내지 않고 명시적으로 실패한다. 이는 의도된 안전 차단이지만, 실사용에서 긴 Contract가 많을 경우 추가 측정이 필요하다. W1에서 무조건 budget을 확대하거나 조용히 기본값으로 전환하지 않는다.

## 3. 테스트 실행 증거

| 검증 | 환경 / 상태 | 확인 |
| --- | --- | --- |
| 변경 전 T23 RED | 기존 생성 Runtime, custom fixture | 금지 제약 삭제+Receipt included/omitted 불일치. 신규 테스트 2건 실패(의도한 RED) |
| TypeScript 7.0.2 원본 typecheck | `/tmp/moon-relay-w0-ctx-*` 격리 Git archive + 수정한 TS 원본 + 개발 의존성 | **PASS** |
| 테스트 Runtime 빌드 | 동일 격리 checkout | **PASS** |
| 5개 Context 집중 suite | 동일 격리 checkout | **17/17 PASS**, fail 0, skipped 0 |
| `check:boundaries` | 동일 격리 checkout | **PASS** |
| `build:check` | 동일 격리 checkout | **PASS** |
| `test:source-runtime` | 동일 격리 checkout | **단일 명령 PARTIAL / TIMEOUT (240초, SIGTERM)**. 앞의 두 suite 16/16 `ok` 기록. 세 번째 suite만 별도 실행 **4/4 PASS**. 세 suite를 합친 단일 Runner 완료는 미확인 |
| Windows/Mac native 실제 Worker E2E | 실제 사용자 세션 영향 방지 | **NOT VERIFIED / DEFER** |

**환경 장애는 별도 분류:** Windows-side Linux MCP 본 작업 트리의 `NODE_ENV=production` 때문에 `npm config get omit=dev`이고, 개발용 `typescript` 플랫폼 패키지가 없어 일반 `npm run typecheck`가 시작 전 실패했다. 소스 결함이라고 분류하지 않는다. **격리된 Git archive 테스트 사본에서만** `env -u NODE_ENV npm ci --include=dev`를 수행하여 통과했다. 소스 저장소 `node_modules`/사용자 전역 npm 설정은 수정하지 않았다.

**증거:** Moonremote tracked `operationId`
- 함수 수준 버그 재현: `748d32c3-4b0d-4cb2-923c-4cd5f30c7946`
- 신규 T23 RED 시험: `3af4a866-ddf4-4a28-9648-3f73a2e5ca21`
- 불완전 Linux MCP 설치 실패: `3de5daa8-822b-4c39-a67c-5c4ee7ad5911`
- 격리 npm 개발 의존성/타입/테스트/경계/빌드 PASS: `279b0776-e83e-4f3f-9d43-bc3fd7cf61d6`
- 확장 source-runtime 시험: `4666f22a-2320-4ec1-a1fd-46a4f58c5f1b`

확장 회귀 `test:source-runtime`은 **세 파일을 `--test-concurrency=1`로 직렬 실행**하며, 앞의 두 suite 16개 테스트가 완료되는 동안 240초 예산을 거의 소진했다. 실행되지 못했던 `tests/typed-owner-change-scenarios.test.mjs`만 독립 실행해 4/4 PASS(약 219초)를 얻었다. 따라서 두 실행의 분리된 증거는 16+4개 테스트 성공을 보이지만, 전체 단일 Runner의 정상 종료와 동일한 판정은 아니다. 새로운 타임아웃 폴백이나 코드 규칙은 추가하지 않았다.

격리 개발 테스트는 W0 판단을 위한 실행 증거이며 사용자 계정의 실제 설치/Native 경로 PASS와 구분한다.

## 4. W0.1 Capability / W0.2 실행 중복 조사

- Windows Native Moonremote executor는 stale heartbeat (`persistence_unavailable`)로 읽기 전용 Host probe가 시작되지 않았다.
- Mac Native의 **초기 미인증·빈 Thread** 실험에서는 이력 읽기/`thread/resume` 실패와 격리 `shellCommand` 시 PID 미관측·Responses WebSocket `401 Unauthorized`가 있었다([기존 Native 결과](W0_NATIVE_FOLLOWUP_2026-11-03.md)). **후속 격리 기기 인증** 후 실제 단일 Turn `completed`와 새로운 WebSocket 연결에서 `thread/read(includeTurns=true)`가 성공했다([인증·Turn 검증](W0_AUTH_TURN_RESULT_2026-11-03.md)). 이후 [in-flight 수명 검증](W0_INFLIGHT_CONNECTION_LIFECYCLE_2026-11-03.md)에서 실제 Turn을 시작한 WebSocket을 닫으면 중단된 상태로 재조회됐으나, 시작 연결을 Host 역할로 유지하면 다른 클라이언트 종료 후 새 연결에서 inProgress 조회·interrupt→interrupted가 가능했다. 새 App Server 프로세스에서도 중단된 Turn의 이력 조회가 성공했다. **실제 Moonshot Relay Main/Host 수명 분리·실행 중 command 재개·old Writer 물리 차단은 미검증**이다.
- Linux MCP 표면에는 `codex` CLI가 없다. Linux 측에서 Codex Native Worker 생존을 시험할 수 없는 것이지 사용자 Native Host의 기능 부재를 뜻하지 않는다.
- Mac MCP checkout은 초기 기준보다 한 커밋 뒤처져 있으므로 같은 소스 E2E가 아니며 변경하지 않았다.
- Source 검색에서 자동 Goals loop 구현 및 실제 App Server thread-control API를 확인하지 못했다. 모델/Tool 기능은 설치된 Native에서 별도로 측정해야 한다.
- 기존 `work-attempt-store.ts`의 Attempt/Receipt와 `process-observation.ts`의 PID 존재 여부는 재연결된 Thread/Turn/OS writer 안전성의 독립 증거가 아니다.

## 5. G0 판정 및 이어갈 수 있는 범위

| G0 항목 | 판정 | 다음 행동 |
| --- | --- | --- |
| ContextReceipt T23 원인·수정·focused test | **SOURCE PASS** | 수정 유지·회귀 테스트 보호 |
| W0 코드 호출 그래프 및 소유권 | **SOURCE PASS** | W1 재사용 경계 보존 |
| W0.4 A/B/E/C/D 사전 등록 | **PLAN COMPLETE** | Native 기술 가능성 입증 후 실험 |
| Mac/Windows Native Worker life/status/reconnect | **Mac Turn-level PARTIAL / Windows DEFER** | Host 연결 유지 시 inProgress 재조회·원격 interrupt PASS; 실제 Main/Host lifecycle·OS Writer·Windows executor 미검증 |
| T24 Goals/loop 이중 실행 위험 | **Linux 실제 두 Host 정상 Proof·Owner CAS 1회 PASS, 약한 Proof 부분 Delivery 재현·차단 PASS / Mac Native 후속 3 PASS·초기 1 FAIL 미분류** | [T24 정상 경쟁 결과](W0_T24_POSITIVE_OWNER_CAS_CROSS_HOST_2026-11-04.md): 전체 배치 소유 시 Rev 1/Report·Proof 2건, Step 분할 시 Rev 0·Worktree 보존. [기존 Native 부정 경로](W0_T24_FULL_DISPATCH_NATIVE_TWO_HOST_CONFORMANCE_2026-11-04.md). 앱 Goals·Writer 물리 종료·실패 원인·분할 결과 재회수 미증명. G0 PARTIAL/W1 DEFER [분할 Host 결과 재시작 재조회](W0_T24_POSITIVE_OWNER_CAS_CROSS_HOST_2026-11-04.md#재시작-후-canonical-결과-재조회-검증-t24-후속): Canonical Step/Attempt·Git SHA·패치·보고서 불변 PASS, 새 Worker 0건. 자동 합류는 OS Writer 종료·단일 fence 증명 전 DEFER [기존 Owner Fence에 대한 독립 복구 Host 실제 경쟁](W0_T24_POSITIVE_OWNER_CAS_CROSS_HOST_2026-11-04.md#서로-다른-복구-host의-owner-fence-실제-경쟁-t24-후속): Linux 동시 1 획득·1 거부, epoch 증가, stale token 거부. 자동 통합 전 Writer 종료·Proof 전 Fence 수명 보호 미검증으로 G0 PARTIAL/W1 DEFER Mac Native 복구 Fence 동시 경쟁 및 정상 Owner 경로 후속 3 PASS/0 FAIL, 초기 1 Native `app_server_connection_lost` FAIL 근본 원인 미확정. G0 PARTIAL/W1 DEFER |
| T26 Main/MCP/App Server/Host 종료 후 상태 | **PARTIAL (Native 모의 클라이언트 및 이력 재조회)** | 시작 WS 해제 시 interrupted, Host WS 유지 시 다른 클라이언트 종료·재조회 가능, 새 App Server에서 기록 조회. 실제 Main/MCP/OS command 연속성은 미검증 |
| T25~T31 Native Writer·Report/Proof·Host 복구 | **Mac 실제 Native Host 중단 뒤 Attempt/예약 재조회·동일 Workspace 중복 실행 거부 PASS / 기존 RPC 결과·임의 후손 종료·안전 폐기 미검증** | [T31 실제 Host 중단·복구](W0_T31_NATIVE_HOST_DISCONNECT_AND_ATTEMPT_RECOVERY_2026-11-04.md): Host SIGKILL·App Server 종료 후 A OS Writer 생존, 재접속 Kernel이 A Canonical Attempt와 Host 외부 예약을 보존, 같은 Workspace 재실행 0회 및 새 B 물리 Worktree Native 명령 PASS (Mac 1/1). T30의 실제 Report/Proof·Owner CAS PASS 유지, Linux 확대 102건 중 96 PASS·6 OS SKIP·0 FAIL. **원래 RPC/Tool handle 재연결·임의 OS 후손 전체 종료·기본 Dispatcher 전환 미검증** |
| T32 Host-owned App Server 초기화 실패 수명 | **Linux·Mac 실제 OS Node App Server 프로세스 종료 PASS / Native Writer 후손 미검증** | [T32](W0_T32_HOST_OWNED_APP_SERVER_SHUTDOWN_2026-11-04.md): 초기화 실패 시 SIGTERM만 보내고 반환하던 경계 수정. 중복 `close()` 종료 대기·강제 SIGKILL 후 실제 Exit 관측. 계속 Writer 완료/후손 종료/자동 Worktree 폐기 권위 없음. |
| T33 App Server 전체 Process Group 종료 | **Mac 실제 음성 반례 PASS / Native Writer 전체 종료 미증명** | [T33](W0_T33_NATIVE_OS_GROUP_CONTAINMENT_NEGATIVE_2026-11-04.md): Mac 실제 PGID 26167 전체 SIGTERM 종료 후 별도 PGID 26173 Writer가 기록을 지속, B/Host 외부 쓰기 각 100/100 거부. killpg 방식 전체 종료 주장 금지. |
| T34 통합 Proof 이전 Owner Fence | **Linux·Mac Proof 후손 이탈 실측 / 전 구간 Owner Fence 보호 NOT VERIFIED** | [T34](W0_T34_PRE_PROOF_FENCE_LIFETIME_2026-11-04.md): 실제 Trusted Proof Timeout과 Fence 만료 이후 두 번째 Owner가 획득해도 첫 Proof의 분리 Writer가 살아 있음을 재현. 자동 통합 정착은 DEFER. |
| T35 Trusted Proof `writeScope` | **macOS 선택형 OS 쓰기 격리 PASS / Native 전체 복구 DEFER** | [T35](W0_T35_TRUSTED_PROOF_WRITE_CONTAINMENT_2026-11-04.md): Canonical `realpath` 기반 Seatbelt가 분리 후손의 Owner·형제·symlink 우회 쓰기를 `EPERM`으로 차단. Linux/Windows 미지원 시 typed fail-closed. 기존 Dispatcher 기본 Proof·자동 합류는 미변경. |
| T37 통합 전 구간 Owner Fence | **Linux·Mac 실제 Kernel 순서 및 만료 PASS / 자동 합류 DEFER** | [T37](W0_T37_PREPROOF_OWNER_FENCE_LIFECYCLE_2026-11-04.md): 처음 쓰기 전부터 Report 정착 시도까지 단일 기존 Fence를 보유하는 테스트, 만료시 stale 거부. 실제 Dispatcher 기본 경로·Canonical 정상 Settlement는 미변경. |
| T38 CAS 후 Cross-Host 복구 | **Linux·Mac 실제 Host 정상 2 Report 승인 / CAS 중단 blocked 재조회 PASS — 자동 복구 DEFER** | [T38](W0_T38_POST_CAS_CROSS_HOST_RECOVERY_2026-11-04.md): 실제 독립 OS 프로세스로 검증했으나 동기식 시험 Worker의 결과이며 Native Writer 종료 증거는 아님. |
| T39 Native Writer 물리 종료 증거 | **Mac 실제 Codex direct RPC Grandchild 실측 1 PASS / 일반 Native 완전 종료 미증명** | [T39](W0_T39_NATIVE_WRITER_DESCENDANT_LIFETIME_2026-11-04.md): macOS 독립 PGID 다단계 Grandchild 검증. `writerExitVerified:false` 및 자동 합류 DEFER 유지. |
| T40 Native Crash·Fence·격리 | **Mac Native Crash·TTL·새 복구 Worktree 쓰기 375회 전부 거부 PASS / 자동 합류 DEFER** | [T40](W0_T40_NATIVE_GENERATION_FENCE_OS_WRITE_ISOLATION_2026-11-04.md): 살아 있는 이전 Native Writer의 OS 쓰기 격리와 새 Host 복구 경계 실증. |
| T41 보호된 Dispatcher 통합 | **선택형 Mac OS Scoped Proof + 단일 Owner Fence·정상 Report/중단 복구 9 PASS / Native 자동 합류 DEFER** | [T41](W0_T41_GUARDED_DISPATCH_INTEGRATION_FENCE_2026-11-04.md): 최초 쓰기부터 Canonical Report 정착까지 하나의 기존 Owner Fence 사용, macOS OS 강제 Proof와 독립 통합 Worktree. |
| T42-A Cross-Host Receipt Readback | **Linux 37 PASS·Mac Native 실물 6 PASS / 자동 Delivery DEFER** | [T42-A](W0_T42_SPLIT_HOST_CANONICAL_READBACK_2026-11-04.md): 이전 Host 결과 SHA·Digest·Workspace Identity 대조. |
| T42-B1 OS Scoped Canonical Recovery Preflight | **Linux 37 PASS·Mac Native 3 PASS / 실제 Delivery 미적용** | [T42-B1](W0_T42B_GUARDED_CANONICAL_RECOVERY_PREFLIGHT_2026-11-04.md): 다른 Host의 Canonical Result를 새 OS Scoped Worktree에서 Proof만 실행. |
| T42-B2-A Controlled Cross-Host Settlement | **Linux 37 PASS·Mac 동기식 3 PASS / 실제 Native 자동 Delivery 미승인** | [T42-B2-A](W0_T42B2_FINITE_SPLIT_OWNER_CAS_SETTLEMENT_2026-11-04.md): 기존 Kernel API의 CAS·Report 정확히 한 번, Writer 종료 증명이 있는 동기식 Fixture. |
| T42-B2-B Historical Split-Host Post-CAS Crash | **Linux 38 PASS·Mac 4 PASS / Native Delivery 불승인** | [T42-B2-B](W0_T42B2_POST_CAS_CRASH_2026-11-04.md): 역사적 두 Host Result로 CAS 직후 물리 Host 종료, 재진입 차단. |
| T42-B2-C Historical Recovery Contention + Proof TTL | **Linux 6 PASS·확대 27 PASS/2 OS SKIP·Mac 6 PASS / Native Delivery 불승인** | [T42-B2-C](W0_T42B2C_RECOVERY_CONTENTION_TTL_2026-11-05.md): 실제 복구 Host 경합에서 1 CAS·2 Report, Proof 중 TTL 만료 뒤 오래된 Epoch의 CAS 차단과 새 물리 Worktree 확인. |
| T43 Proof-time stale Worker receipt drift | **Linux 집중 7 PASS·확대 28 PASS/2 OS SKIP·Mac 신규 1 PASS·전체 6 PASS/1 FAIL / Native Delivery 불승인** | [T43](W0_T43_PROOF_TIME_STALE_WRITER_RECEIPT_DRIFT_2026-11-05.md): Proof 중 원래 Step Worktree 지연 쓰기 발견 후 CAS·Report 차단. |
| T43-A macOS intermittent weak-proof Host exit follow-up | **Mac 기준선 전체 7 PASS·수정 후 전체 7 PASS, Linux 15 PASS/2 OS SKIP / 기존 실패 원인 미확정** | [T43-A](W0_T43A_WEAK_PROOF_HOST_EXIT_DIAGNOSTICS_2026-11-05.md): 조기 종료 signal/PID 관측 및 테스트 OS 자식 정착 개선, G0 PARTIAL 유지. |
| T44 Native hardlink alias boundary | **Mac Native 1 PASS·Linux 7 PASS/2 OS SKIP, 사전 생성 외부 하드링크 100회 우회 확인 / Native Delivery 불승인** | [T44](W0_T44_NATIVE_HARDLINK_ALIAS_WRITE_ISOLATION_2026-11-05.md): 경로 격리와 외부 inode 보호 차이, 새 Git Worktree 파일은 독립 inode. |
| T45 clean Worktree hardlink reuse trust boundary | **Linux 5 PASS·Mac 5 PASS / 재사용 Git 검사만으로 외부 inode 안전성 불충분** | [T45](W0_T45_CLEAN_WORKTREE_HARDLINK_ADMISSION_2026-11-05.md): 새 Git Worktree는 별도 inode, 외부 Host의 동일 내용 하드링크 치환 후 clean 재사용 허용. Native 자동 합류 DEFER. |
| T46 same-account external process Worktree mutation | **Linux 6 PASS·확대 11 PASS/1 OS SKIP·Mac 6 PASS / Native Delivery 불승인** | [T46](W0_T46_SAME_ACCOUNT_EXTERNAL_WORKTREE_MUTATION_2026-11-05.md): OS 파일 쓰기와 Kernel Writer 예약의 독립 신뢰 경계 실측. |
| G0 전체 | **PARTIAL** | **W1 live worker 구현 중단**, 미완료 Native 실험부터 계속 |

**다음 단계 (이미 결정된 경로):** 정상 동작하는 Native Host에서 격리 프로세스/Thread를 만들어 (1) start handle (2) 상태 재조회 (3) Main 독립성 (4) cancel/approval (5) old writer 안전 정지를 입증한다. Live Worker가 안 되지만 안전 중단·새 Thread 재개만 가능하다면 원래 계획의 B가 아니라 **degraded-safe-resume 별도 제한 채택**으로 분류한다. 원래 `E` authority-only resume을 먼저 검증하고, `C` Handoff는 추가 효용 입증 전 도입하지 않는다.

W0 범위를 넘어서는 새 DB/큐/폴백 및 사용자 계정 app-server/DB 강제 변경은 승인하지 않는다. G0 PARTIAL을 PASS로 바꾸지 않고 같은 작업 체크포인트에 미완료 단계로 남긴다.
