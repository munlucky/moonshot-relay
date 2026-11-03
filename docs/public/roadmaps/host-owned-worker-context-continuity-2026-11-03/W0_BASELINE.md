# W0 실험 기준선 / A·B·E·C·D 사전 등록

- 작성: 2026-11-03, **성능 실험 전**
- 고정 Source 기준: `main/77b55f52` (W0 진입 기준). 코드 수정 평가에는 W0-Fix 커밋을 모든 실험군에 동일 적용할 것
- 현재: **평가 계획만 확정. Native Agent/사용자 계정 실험 미실행**
- 관련: [PLAN.md](PLAN.md) · [VERIFICATION.md](VERIFICATION.md) · [W0_CAPABILITY_MATRIX.md](W0_CAPABILITY_MATRIX.md)

## 비교군과 독립 변수

| Arm | Worker 수명 | Context 전환 | 검증할 유일한 추가 효과 |
| --- | --- | --- | --- |
| **A — Baseline** | 기존 owner-direct / 일반 메인 연결 | Provider 기본 압축 | 현행 품질·총비용·진행 중단 기준 |
| **B — Host-owned** | 실제 독립 실존 Worker | Provider 기본 압축 | Main session 실행 분리만의 효과 |
| **E — Authority-only** | B의 Worker | 동일한 안전 전환 시점에 새 Thread, **서술형 요약 없음** | 기존 Kernel/Workspace/Evidence만으로 정확히 재개 가능한가 |
| **C — Structured Handoff** | B의 Worker | E와 같은 전환 시점 + 출처 있는 구조화 Handoff | 요약 자료 **자체**의 재탐색·품질·비용 추가 효과 |
| **D — Boundary Reset** | B의 Worker | 안전한 Work Unit 경계에서만 새 Thread | 전환 **시점** 정책의 효과 (C vs E에 섞지 않음) |

순서: A와 B가 기술적으로 실행 가능한 뒤 E → 동일 전환의 C → 별도 D. B의 Worker 수명 미지원이면 E/C/D의 기술적인 평가를 시작하지 않는다.

## 고정 시험 과제와 통제 변수

초기 Pilot은 최소 6개 **사용자 실제 작업을 복제한 격리 fixture**에서 각 Arm을 실행한다. 사용자 계정의 진행 중 프로젝트나 Run을 실험군으로 변경하지 않는다.

1. T01 단순 행동 변경/단일 파일 수정과 Proof
2. T02 3~5 독립 Work Unit의 장기 구현
3. 대량 도구 결과·로그와 필수 계약 제약
4. 반복 오류 조사 및 다음 Step 재개
5. 승인 대기/취소/변경 경쟁
6. Compaction/Thread 교체가 필요한 장기 작업

각 비교군에서 **동일 objective·acceptance·constraints·non-goals·초기 Git SHA·독립 Checkout·동일 model/effort/sandbox/approval/tool manifest**를 사용한다. 서로 다른 Provider를 한 비교군에 섞지 않는다. 관측 가능한 start/end 이벤트/turn 상태가 다르면 별도 분석으로 구분한다.

Pilot 순서는 Task/Arm 순서 편향을 줄이도록 교차(AB vs BA, E↔C 시점 고정)한다. 먼저 단일 성공 사례로 제품 기본 경로를 바꾸지 않는다. Pilot 뒤 표본 확장은 실제 변동성과 예산을 보고 별도 승인해 진행한다.

## 사전 고정 측정 항목

- 정확성: Acceptance 충족 여부, 제약 위반, false done, 중복 파일 변경, required verification/review.
- 실행 연속성: Main disconnect 후 Worker 생존 또는 안전 정지, 새 Main reconnect, unknown 명령 중복, 취소·승인 반영 지연.
- 분리 효과: Main prompt input/output token, Worker input/output token, Reviewer token, tool result byte/모델 토큰, compaction 횟수.
- 전체 비용: 실제 Provider 사용량 `inputTokens/cacheReadInputTokens/cacheWriteInputTokens/outputTokens/reasoningTokens` 및 단가·요청 수·wall clock. 토큰 미제공이면 null; 단순 문자열 길이로 비용 절감 주장을 하지 않는다.
- Handoff 순효과: 기존 조사 반복 횟수, 거절된 접근 재실행 횟수, Evidence 재탐색 지연, 분실된 제약/범위.
- 통제: source revision, test revision, Host OS/CLI version, Workspace identity, thread ID, attempt/operation ID, model/effort·approval, provider capability/status.

## 채택·중단 기준 (결과 수집 전에 고정)

**모든 Arm의 절대 안전 조건:** I01~I12 위반 0, 허위 Completion 0, 승인 우회 0, 같은 mutation scope 동시 Writer 0, 중복 실행 0, 관련 Acceptance/필수 Proof 실패 0. 하나라도 위반하면 해당 Arm은 채택 불가하며 실행 경로를 조사한다.

**품질 비열화:** 동일 Task의 A 대비 합격 판정이 떨어지지 않아야 한다. 원인 불명/미관측은 PASS가 아니다. Provider가 다르게 응답했거나 환경이 달라진 경우 paired 결과에서 제외하고 재실험한다.

**성능:** 우선 안전/정확성 PASS 후 동일 조건에서 Main context 부담, 전체 토큰/비용, 종료까지 시간과 회복 성공률을 비교한다. 단순 작업은 추가 Worker overhead가 유의미하면 A 유지. 장기 작업은 실제 성공률/전후 cost 개선이 관측된 조건에서만 B/E 제한 채택. 기계적인 전 작업 강제 Worker는 기본 금지.

**Handoff C 채택:** E보다 새로운 안전 이점이나 충분히 재현되는 재탐색·시간·비용 절감이 있어야 한다. E와 품질이 같으면서 Handoff 생성·유지비만 추가되면 C 기각. 원본 transcript가 불완전하면 "lossless" 평가 금지.

**D 채택:** B의 세션 유지와 E의 자유 전환 대비 경계 전환 자체가 회복/비용을 개선하는 경우에만 검토. 사전 Compaction 신호를 얻을 수 없으면 자동 사전 전환 기능은 DEFER.

**종료:** Native in-flight Worker 생존·취소를 실증하지 못하면 G0/G1부터 PARTIAL. 단위 테스트와 Source 기반 검증만으로 제품 전환을 선언하지 않는다.

## 비용·리스크 한도

- Native Worker 실험 전 실측되는 Provider 요금과 잔여 예산에 기반한 **금액 상한과 표본 수를 문서에 확정**한다. 현재 단가/계정 과금 정보 미관측이므로 금액을 임의로 기록하거나 무제한 실험을 승인하지 않는다.
- 격리 로컬 fixture와 무파괴 read-only probe는 진행. 실제 사용자 Codex App 서버 재시작, 사용자 DB 삭제/마이그레이션, Git reset/force push는 금지.
- 새로운 상시 Worker DB/Queue/Score 엔진, Provider별 임시 fallback, Prompt 중복 지침, Hot SQLite writer의 cross-host 공유는 성능시험을 위한 선행 작업으로 도입하지 않는다.

## W0 고정 사실과 미확인

- 코드의 단일 `buildKernelContext` 예산·Receipt 결함 T23은 함수 fixture에서 재현. W0-Fix 이후 모든 Arm에 동일하게 반영해야 A/B 평가 왜곡이 없다.
- `createCodexNativeAgentLauncher`는 현재 결과를 기다리는 형태. 단독 start와 독립 status/stop이 실제 설치 Native Host에서 가능한지 미확인.
- Source만으로 Goals 자동 루프의 실제 존재 여부·충돌 여부를 확정하지 못했다.
- Windows Native executor는 heartbeat stale. Mac Native는 Codex path만 관측됐고 버전/help/Thread API 결과는 확보되지 않았다. 현재 A/B/E/C/D의 실사용 비교 측정은 미시작이다.
