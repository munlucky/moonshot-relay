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
| T24 Goals/loop 이중 실행 위험 | **PARTIAL / 코드 관찰만** | 앱/Host 실제 실행 경로 검증 |
| T26 Main/MCP/App Server/Host 종료 후 상태 | **PARTIAL (Native 모의 클라이언트 및 이력 재조회)** | 시작 WS 해제 시 interrupted, Host WS 유지 시 다른 클라이언트 종료·재조회 가능, 새 App Server에서 기록 조회. 실제 Main/MCP/OS command 연속성은 미검증 |
| T25 OS Writer 실질 차단 | **NOT TESTED** | G1/G4 선행. CAS/Lease만으로 PASS 금지 |
| G0 전체 | **PARTIAL** | **W1 live worker 구현 중단**, 미완료 Native 실험부터 계속 |

**다음 단계 (이미 결정된 경로):** 정상 동작하는 Native Host에서 격리 프로세스/Thread를 만들어 (1) start handle (2) 상태 재조회 (3) Main 독립성 (4) cancel/approval (5) old writer 안전 정지를 입증한다. Live Worker가 안 되지만 안전 중단·새 Thread 재개만 가능하다면 원래 계획의 B가 아니라 **degraded-safe-resume 별도 제한 채택**으로 분류한다. 원래 `E` authority-only resume을 먼저 검증하고, `C` Handoff는 추가 효용 입증 전 도입하지 않는다.

W0 범위를 넘어서는 새 DB/큐/폴백 및 사용자 계정 app-server/DB 강제 변경은 승인하지 않는다. G0 PARTIAL을 PASS로 바꾸지 않고 같은 작업 체크포인트에 미완료 단계로 남긴다.
