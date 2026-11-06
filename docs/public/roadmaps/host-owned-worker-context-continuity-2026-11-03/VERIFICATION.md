# Host-owned Worker / Context Continuity — 검증·판정 계약

- 작성: 2026-11-03 (KST)
- 입력 원칙: 2026-11-03 개선 전략 v2 및 검증 전략 v2의 G0~G6, I01~I12, T01~T27 보존
- 현재 실행 결과와 수용 판정: [STATUS.md](STATUS.md)
- 구현 범위: [PLAN.md](PLAN.md); 첫 실행: [W0_START.md](W0_START.md)

## 판정 표기

`PASS` = 해당 Host의 실제 필수 검증까지 관찰됨. `PARTIAL` = 구현 또는 fixture는 확인했으나 필수 사용자·Native·실사용 검증이 없음. `FAIL` = 불변식/Acceptance 위반. `DEFER` = 현재 Host·Provider capability 미지원으로 범위 보류. `unknown` 관측값은 `null`로 기록하고 추정값을 채우지 않는다.

세션 연결이 종료돼도 Worker가 **계속 실행**하는 것과 Worker가 **안전하게 정지 후 재개**하는 것은 다른 기능이다. Thread resume도 실행 중 command resume과 다르다. 한 측면의 통과를 다른 기능의 PASS로 사용하지 않는다.

## 불변식 I01~I12 — 모두 필수

| ID | 계약 | 반드시 실패로 볼 반례 |
| --- | --- | --- |
| I01 | Kernel Run/Step/Task Contract 단일 권위 | Handoff/Host status가 완료·새 Run 독자 결정 |
| I02 | Worker 교체 전후 Git/Workspace 동일성 | 의도치 않은 롤백·다른 worktree 수정 |
| I03 | 같은 mutation scope 실제 Writer 최대 1 | old/new 프로세스 동시 파일 쓰기 |
| I04 | `running/unknown` 실행 중복 금지 | 새 operationId로 결과 미확정 명령 재실행 |
| I05 | Kernel Evidence·Trust만 완료 판단 | Worker summary나 exit 0만으로 PASS |
| I06 | Acceptance·금지 조건 정확히 보존 | prompt budget/요약으로 필수 제약 손실 미검출 |
| I07 | 관측 가능한 원본 transcript/event 조회 가능 | Handoff만 남기고 원본 폐기 |
| I08 | 실제 model/effort/sandbox/approval 관측 | 요청한 config를 실제로 실행된 config로 보고 |
| I09 | Main/MCP 연결 종료가 Kernel 완료를 바꾸지 않음 | 연결 실패가 false done/false failed 유발 |
| I10 | cancel/change/approval 적용 경계 명시 | 과거 실행에 소급 적용했다고 주장 |
| I11 | status/handoff/log에 비밀정보 추가 노출 없음 | API key·credential이 새 산출물에 포함 |
| I12 | 미관측 원본을 lossless라고 주장하지 않음 | 잘린 JSONL/내부 추론을 완전 보존이라고 보고 |

**I03 추가 조건:** Owner CAS/Lease 획득은 DB 상태만의 증거다. OS Writer가 실질적으로 파일 변경을 못 함을 프로세스 중지·격리·능동 fencing 등으로 검증해야 한다. 판정 불가면 Fresh Resume 차단.

## 묶음 C 로컬 실행

현재 작업 트리에서 `npm run test:host-worker-product-acceptance`를 실행한다. 이 명령은 타입 검사, 제품 빌드, 테스트 빌드, 경계 검사와 아래 통합 테스트를 실행한다. 보호된 Host 경로에서 Proof를 실행할 수 없으면 해당 테스트는 실패로 기록한다. MCP 회귀는 같은 로컬 Kernel의 전송 경계를 확인한다.

| ID | 명령에 연결된 로컬 시험 | 별도 제품 증거 |
| --- | --- | --- |
| I01 | MCP 재접속의 Run/Step/Attempt 불변과 미정착 Worker의 Report 거부 | 보호된 Host의 실제 Kernel 완료 |
| I02 | Worker Git 패치, Owner Index 보존, Worktree 바인딩 및 오래된 Delivery 차단 | 실제 Native 교체 후 Git/Workspace 동일성 |
| I03 | 분리된 OS Writer의 생존 중 예약 유지, Owner Fence/CAS, 보호된 정착 | 지원 Native Host의 실제 Writer 배제 |
| I04 | 동시 시작, 연결 상실 후 중복 Worker 거부, Report 재생 및 보호된 후속 Step | 실제 Native 장기 작업과 Host 교체 |
| I05 | stale Evidence와 누락된 권위 차단, 보호된 3-Step 완료 | 지원 Native Host의 신선한 Evidence |
| I06 | 실행 중 Contract 교체 거부, Step 범위와 Capsule 예산 검사 | 실제 Fresh Thread에서 전체 계약 제약 유지 |
| I07 | 같은 로컬 Host의 원래 Thread/Turn/Attempt에 귀속한 명령 이벤트 조회와 Main 교체 후 조회 일치 | 실제 Native 원본 transcript 재조회 |
| I08 | fixture가 받은 실행 요청의 model/effort와 sandbox·approval 정책 | Provider가 실제 적용한 Native 구성 |
| I09 | 서로 다른 MCP 스트림의 읽기 전용 재접속과 같은 Attempt 유지 | 지원 Native Host의 실제 Main 교체 |
| I10 | 동일 Turn 취소, 완료 선착, ACK 유실, 미지원 승인 거부 | 인증된 사용자 승인 왕복 |
| I11 | Worker 보고서와 명령 이벤트 식별자 마스킹, 상태/재접속의 원본 패치·출력 제외, Proof/Context 비밀 제거 | 실제 사용자 transcript·로그의 노출 경계 |
| I12 | 미확정 Turn을 unknown으로 유지. 현재 Host의 명령 이벤트 응답에 관측 범위·생략 건수 표시 | Native 원본 조회 범위와 누락 확인 |

Native 수용과 A/B/E 비교 결과는 [STATUS.md](STATUS.md)에 별도로 기록한다. 비교에는 기존의 지원 조건과 사전 예산을 적용한다.

## T01~T27 반례 카탈로그

| ID | 테스트 및 주요 기대 | Gate |
| --- | --- | --- |
| T01 | 단일 파일 수정 + 실제 Proof, 올바른 완료 | G1/G3 |
| T02 | 3~5 Work Unit, 중복 없이 동일 Run 완료 | G3 |
| T03 | Main 종료 후 실제 Worker Thread/Process 생존 | G1/G2 |
| T04 | 새 Main status/signal + Run ID + 적용 시점 | G2 |
| T05 | spawn 응답 손실, 이중 spawn 없음 | G2/G5 |
| T06 | 긴 테스트 중 Host 종료, unknown reconcile | G5 |
| T07 | 같은 파일 동시 수정 시 Worker 한 명만 승인 | G1/G5 |
| T08 | Worker 성공 주장 + 검증 실패 → Kernel 미완료 | G3 |
| T09 | 동일 Step의 다른 Fresh Thread ID | G4 |
| T10 | Handoff 금지 제약 누락 → Contract 제약 유지 | G4 |
| T11 | stale Workspace Revision → 차단·재조회 | G4 |
| T12 | 원본 보존 실패 시 기존 Thread 미삭제 | G4 |
| T13 | Provider 자동 압축 선행 → 원본/Kernel 재조회 | G4 |
| T14 | 권한·사용자 입력 대기 중 자동 진행 금지 | G2/G5 |
| T15 | 취소/완료 경합에서 원인/최종 상태 일관 | G5 |
| T16 | 기능 미지원 때 무단 owner-direct fallback 금지 | G0/G1 |
| T17 | secret 포함 로그가 status/Handoff로 새로 노출되지 않음 | G4/G5 |
| T18 | compaction 전후 JSONL/event digest와 조회 범위 | G0/G4 |
| T19 | 스크린샷·검색 대량 출력을 Main/Worker 총비용으로 측정 | G6 |
| T20 | 단순 작업의 Worker 오버헤드 측정 | G6 |
| T21 | **E**: 요약 없이 Kernel/Workspace 재조회 Fresh Resume | G4 |
| T22 | **E↔C**: 동일 checkpoint/전환점에서 기각 접근 재탐색·비용 비교 | G4/G6 |
| T23 | 긴 Contract 끝 필수 금지 제약, 실제 prompt↔ContextReceipt 일치 | G0/G4 |
| T24 | Codex Goals+Host Dispatcher 중복 루프 금지 | G0/G3/G5 |
| T25 | Lease/CAS 이후 old Worker late write 물리 차단 입증 | G1/G4/G5 |
| T26 | Main/MCP/App Server/Host 각각 종료, 복구·명령 생존 별도 판정 | G0/G1/G5 |
| T27 | **B↔D** 전환 시점 비교와 E↔C 내용 비교 분리 | G4/G6 |

## Gate 순서 및 필수 수용

| Gate | 대상 | PASS에 필요한 실제 증거 |
| --- | --- | --- |
| G0 | W0 capability/baseline | Native/App Server/Goals의 실제 설치본 지원, 수명·세션·원본·ContextReceipt·루프 중복 근거, A/B/E/C/D 고정 |
| G1 | W1 worker lifecycle | 실제 start/관측/생존 또는 안전 정지·복구의 구분, 중복 worker 0, I01~I05/I08/I09 |
| G2 | W2 재접속/제어 | 새 Main 동일 Run 조회, 승인·취소 경계, 시작 idempotence, Host/Kernel 권위 동일 |
| G3 | W3 진행 | 하나의 loop, `report.next` 정확한 소비, 3개 이상 Work Unit + 검증 실패 복구/차단, false done 0 |
| G4-E | W4 authority-only resume | old Writer 차단, 같은 Run/Step/새 Thread, unknown 중복 0, 계약·Evidence 보존 |
| G4-C/D | W4 handoff/boundary | C와 E 동일 전환점, D는 트리거 효과 분리, 원본 참조·revision 검증, 추가 효과가 없으면 기본 미도입 |
| G5 | W5 적대적 복구 | T05/T06/T07/T14/T15/T17/T25/T26 포함 I01~I12 위반 0, native 미수용은 PARTIAL |
| G6 | W6 제품 채택 | A/B/E/C/D paired, 품질 비열화 없음, Main+Worker+Reviewer 총비용/캐시/지연 측정, 작업군별 채택 |

## 동일 조건 평가와 신뢰 범위

- A(owner-direct)는 기존 baseline, B(Worker)는 실행 분리 효과, E(B+Fresh Resume without summary)는 Thread 교체 자체의 비용, C(E+Handoff)는 **같은 전환 시점**에서 추가 요약의 효과, D(B+safe-boundary reset)는 별도 트리거 정책을 시험한다.
- 같은 Acceptance·금지 조건·초기 Git SHA·독립 Workspace·실제 Host/모델/effort·권한·테스트/예산을 사용한다. Arm별 초기 상태와 순서를 기록해 오염을 막는다.
- 메인 입력 토큰, Worker 입력/출력, Reviewer, cache-read/write, 도구 출력 크기, wall-clock, 재탐색, 중복 실행, Acceptance를 구분한다. 모델 입력 토큰을 도구 출력 bytes에서 추정하지 않는다.
- 사용자 계정의 실제 Thread/Runtime을 훼손하지 않고 격리된 Runtime Home과 임시 Git workspace를 사용한다. 부득이한 live 사용자 세션 종료는 이번 자동 수용 범위가 아니다.
- 새 별도 Telemetry DB나 실제 평가에 필요하지 않은 집계/점수 엔진을 만들지 않는다. 기존 Usage Receipt와 Provider 관측 사실을 활용한다.
- 품질 허용 열화와 총비용 상한, 표본, 중단 규칙은 시험 **전에** 정한다. 수치를 사후에 조정해 PASS를 만들지 않는다.
- Test fixture PASS, 원본 소스 검사 PASS, 실제 Native Host PASS, 제품 채택 PASS를 별개로 기록한다.

## 결과 기록 최소 형식

각 Wave의 `Wn_RESULT.md`에는 (1) 기준 SHA/Host/Runtime 버전, (2) 코드 변경 경계와 복잡도 리뷰, (3) 작업계약·파일과 Receipt 참조, (4) Gate/테스트별 PASS/PARTIAL/FAIL/DEFER 및 미검증 이유, (5) 명령 exit code·전체 출력 증거 위치, (6) 운영 계정 부작용 여부, (7) 다음 단계 승인/보류와 롤백 조건을 남긴다.

**검증 전 작업 계획에 어떤 PASS도 선기입하지 않는다.** 2026-11-01 기존 [W7_RESULT](../ephemeral-work-persistent-knowledge-2026-10-31/W7_RESULT.md)의 네 Host 격리 회귀 PASS는 과거 Kernel 기능 회귀이며 이번 독립 Worker 기능 G0~G6 PASS와 무관하다.

## 사용자 변경 범위의 코드 개발 종료 검증

2026-11-06 사용자가 지정한 로컬 기능 연결 개발 종료는 npm run test:host-worker-code-closeout으로 검증한다. 타입·제품 빌드·테스트 빌드·경계 검사 뒤 다음 회귀를 실행한다.

| 변경 범위 | 실행 시험 | 수용 경계 |
| --- | --- | --- |
| 로컬 제품 진입과 미지원 차단 | local-worker-control, cli-main-contract | 로컬 연결과 같은 Host 수명; 기본 Native 시작은 차단 |
| Canonical Attempt와 후보 검증 | codex-app-server-transport, parallel-dispatch | 실제 후보 Git/Proof와 거부 경계; 보호된 Owner 적용 성공 주장 없음 |
| 공통 CAS/Report 중단 복구 | parallel-fencing, parallel-recovery, report-replay | 기존 공통 복구·중복 방지 회귀; Host-owned 보호 관통과 구분 |
| Report.next·Step 선점·Main 교체/취소 | bridge-mcp, local-worker-control, codex-app-server-transport, worktree-binding | 로컬 제품 기준, MCP 추가 전송; 안전한 실제 Writer 배제는 별도 능력 |
| 범위·Evidence·비밀값 | evidence-semantics, run-step-scope, execution-capsule-budget, secret-redaction, context-payload-redaction | 변경 영향 경계 회귀 |

이 묶음은 기존 전체 제품 수용 명령을 대체하거나 그 실패를 숨기지 않는다. 보호된 A2/A3 관통, Native transcript, 승인 왕복·Fresh Resume·Host 종료 후 복원·비교 실험은 이 변경 범위에서 미수용/미지원으로 보존한다. 같은 명령의 현재 소스 실행은 Kernel의 동일 Report 내부 공유 증거로 중복 실행 없이 각 변경 범위 조건에 결합할 수 있다.

추가 공통 결함 회귀: obligation-binding에서 계약 축소 뒤 명령 카탈로그 변경과 next/report를 거쳐도 superseded 항목이 재활성화되지 않는지 확인한다.
