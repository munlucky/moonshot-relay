# Harness Improvement Loop — 리뷰 반영 최종 실행계획

기준선: `main / 6d11e06a`
작성일: 2026-10-20
상태: 구현 전 최종 계획
대체 범위: `W1_CANDIDATE_INVENTORY.md`의 우선순위와 실행 순서를 이 문서가 대체한다.

## 1. 최종 결론

현재 확인된 가장 큰 구조 문제는 **검증한 Project Knowledge가 실제 작업 단계에 다시 공급되지 않는 것**이다.

C3 canonical duplicate collapse는 필요하지만 1순위 구조 문제는 아니다.

현재 재현 결과:

| Stage | selected knowledge | unique content | prompt chars |
|---|---:|---:|---:|
| FRAME | 0 | 0 | 42 |
| EXECUTE | 0 | 0 | 44 |
| PROVE | 28 | 2 | 837 |
| CLOSE | 0 | 0 | 42 |

대표 최신 receipt에서는 freshness 제외가 다음과 같다.

- `freshness_stale`: 131
- `freshness_needs_deep_verify`: 20
- PROVE 28건 중 `unsupported-verification`: 27
- 다른 고유 내용: `delivery_materialization_recovery_required` 1

따라서 개선 목표는 다음과 같다.

> **적용 범위(scope), freshness source(sourceRefs), 검증 증거(evidenceRefs)를 다시 분리하고, 현재 source에서 다시 검증된 유용한 지식만 FRAME/EXECUTE/PROVE/CLOSE에 공급한다.**

과거 stale 지식 전체를 되살리는 것이 목표가 아니다.

---

# 2. 리뷰에서 수정된 판정

## 2.1 C1/C2/C4는 선행 플랫폼이 아니라 최소 관측 계약이다

기존 안은 C1 HistoricalWorkCase, C2 telemetry coverage, C4 generation relevance를 먼저 하나의 Host/offline corpus boundary로 구현하려 했다.

이 순서는 과하다.

현재 문제를 판별할 증거는 이미 runtime DB와 source에 있다.

2026-10-11 이후 Run 34개의 실제 상태:

- legacy `attempts`: 0
- current `run_step_attempts`: 53
- `run_step_attempts.provenance_kind`: 53/53 `owner-session`
- Kernel `model_usage_receipts`: 0

따라서 usage receipt 0은 곧바로 Host telemetry failure를 뜻하지 않는다.
owner-session 실행은 기존 소유 세션으로 실행을 반환하는 경로이므로 Kernel-owned model dispatch receipt가 없을 수 있다.

### 수정된 최소 관측 필드

분석 시 최소한 다음을 함께 본다.

- run id
- execution provenance: `owner-session | routed | kernel-owned | legacy-unattributed`
- run `contractRevision`
- run/attempt `planRevision`
- run/attempt `mutationRevision`
- source identity / workspace identity
- current ledger: `run_step_attempts`
- legacy ledger: `attempts`
- usage receipt presence
- explicit session/run binding 여부

### token attribution 규칙

한 Codex session이 여러 Run과 연결될 수 있다.

따라서 session 전체 token 사용량을 연결된 모든 Run에 복제하지 않는다.

Run 비용으로 귀속할 수 있는 경우는 explicit turn/run 또는 execution receipt binding이 있는 경우로 제한한다.

그 외 session token은 session-level observation으로만 유지한다.

---

## 2.2 C3은 유지하되 P0 구조 개선의 보조 단계로 조정한다

C3의 근거는 유효하다.

moonshot-relay committed knowledge:

- total: 179
- canonical unique: 33
- canonical duplicate occurrences: 146

PROVE에서 27개의 동일 `unsupported-verification`이 반복 렌더링된다.

canonical collapse를 적용하면 PROVE context를 크게 줄일 수 있다.

하지만 이 변경만으로 FRAME/EXECUTE/CLOSE의 0건 문제는 해결되지 않는다.

따라서 C3의 목적은:

- context noise 제거
- budget 낭비 제거
- 이후 sourceRefs/freshness 수정 효과를 깨끗하게 측정

으로 제한한다.

---

## 2.3 가장 중요한 production candidate는 scope/sourceRefs 경계 복구다

현재 `normalizeCandidate()`는 다음 의미를 섞는다.

- `scope`: 지식이 적용되는 코드 범위
- `sourceRefs`: 지식 freshness를 검증할 실제 source

현재 구현은:

1. `scope = candidate.scope || candidate.sourceRefs || candidate.relatedFiles`
2. 최종 `sourceRefs = scope`

로 정규화한다.

또한 canonical mapper와 freshness attach 경로에서 explicit sourceRefs가 없으면 scope를 sourceRefs로 사용한다.

이 때문에 `src/kernel/**` 같은 적용 범위 glob이 실제 파일 참조처럼 freshness 검사에 들어갈 수 있다.

이는 의미 경계 오류다.

---

## 2.4 C5는 두 문제를 같이 수정해야 한다

최근 explicit observation 3건은 모두:

`MISSING_VERIFICATION_EVIDENCE`

로 rejected 됐다.

세 관찰은 구체적인 Prompt Diet 결과와 fixture contract 교훈을 담고 있었다.

반면 automatic blocker candidate는 `blocker://...` structured receipt만으로 verification binding을 만들 수 있다.

따라서 현재 흐름은 다음 비대칭을 만든다.

- 구체적인 평가 교훈 → persisted verification과 ref가 정확히 연결되지 않아 rejected
- 일반 blocker 이름 → structured signal로 쉽게 verified

해결책은 verification 기준을 낮추는 것이 아니다.

다음 두 동작을 함께 고친다.

1. explicit observation이 실제 persisted verification receipt를 참조하도록 producer/binding을 수정
2. generic auto blocker가 durable `known_failure_pattern`으로 바로 승격되는 경로를 좁힘

---

# 3. 변경하지 않을 구조

이번 개선은 Kernel workflow를 확장하지 않는다.

다음 증가량을 0으로 유지한다.

- public Kernel command: +0
- workflow stage: +0
- durable DB table: +0
- 별도 evaluation service: +0
- mandatory approval gate: +0
- provider fallback: +0
- project-specific production heuristic: +0
- model-visible workflow concept: +0

기존 authority를 유지한다.

- Run/Step authority: existing Kernel SQLite
- Knowledge authority: existing Kernel SQLite
- verification authority: persisted verification receipts
- replay/eval: existing kernel-eval tooling
- Git/source identity: existing repository state

---

# 4. Wave 0 — 관측 기준 정정

## 목적

production 코드를 변경하기 전에 이후 비교에서 잘못된 결론을 내리지 않도록 evidence 해석을 고친다.

## 작업

### W0-1. 현재 ledger를 기준으로 실행을 분류

분석/테스트 helper에서 다음 우선순위를 사용한다.

1. `run_step_attempts`
2. legacy compatibility가 필요한 경우에만 `attempts`

`attempts=0`을 "실행 없음"으로 해석하지 않는다.

### W0-2. execution provenance를 필수 분류

각 attempt를 다음으로 분류한다.

- owner-session
- routed
- kernel-owned
- legacy-unattributed

usage receipt absence는 provenance와 함께 해석한다.

### W0-3. revision 경계를 함께 보존

각 case에 최소 다음 revision을 보존한다.

- contractRevision
- planRevision
- mutationRevision
- source identity 또는 source revision

서로 다른 revision의 evidence를 같은 실행 결과로 합치지 않는다.

### W0-4. token 중복 귀속 금지

session 단위 token은 explicit run/turn binding이 없으면 Run metric으로 승격하지 않는다.

## 변경 후보 경로

가능하면 기존 Host/eval helper에 작은 read-only helper만 추가한다.

- `src/host-tooling/kernel-eval/`
- 필요 시 기존 state-store read API 재사용

새 DB schema는 만들지 않는다.

## 테스트

- owner-session 53건이 usage receipt 0과 함께 "missing telemetry failure"로 잘못 분류되지 않음
- routed/kernel-owned fixture는 기존 usage receipt를 정상 사용
- 한 session이 2개 Run에 연결돼도 session token을 두 Run에 복제하지 않음
- contract/plan/mutation revision이 다른 attempt를 합치지 않음

## 완료 조건

C1/C2/C4를 위한 최소 관측 semantics가 정확해진다.

완전한 HistoricalWorkCase 플랫폼은 만들지 않는다.

---

# 5. Wave 1 — C3 안전한 context duplicate collapse

## 목적

지식 공급 경로를 고치기 전에 현재 PROVE noise를 제거한다.

## 변경 원칙

DB row는 삭제하거나 rewrite하지 않는다.

read-model/context selection에서만 canonical duplicate를 collapse한다.

canonical identity는 기존 의미와 맞춘다.

- resolved record type
- normalized statement
- normalized scope

procedure와 required_verification은 의미 필드를 추가로 고려한다.

단순 statement만 같다고 합치지 않는다.

### 보존해야 하는 차이

다음 차이가 있으면 별도 record를 유지한다.

- procedure body/metadata가 다름
- required verification command/obligation이 다름
- scope가 다름
- active supersession relation이 다름
- trust/freshness 상태가 다르고 대표 선택에 의미가 있음

## 변경 후보 경로

- `src/kernel/knowledge/context-load.ts`
- 필요 시 기존 canonical identity helper 재사용
- focused tests only

## 대표 검증

현재 PROVE fixture:

- before: 28 facts / 2 unique / 837 chars
- expected after: 의미 2종 보존, 중복 반복 제거

목표는 특정 135자를 hardcode하는 것이 아니다.
고유 의미가 한 번씩만 렌더링되는지를 검증한다.

## 완료 조건

- canonical duplicates는 한 번만 context에 노출
- procedure/verification 의미 차이는 보존
- Knowledge DB/history는 그대로
- FRAME/EXECUTE/CLOSE 0건 문제를 이 Wave에서 억지로 해결하지 않음

---

# 6. Wave 2 — scope/sourceRefs 의미 분리

## 목적

false stale의 원인이 되는 의미 경계를 수정한다.

## W2-1. candidate normalization 분리

현재:

`scope <- scope || sourceRefs || relatedFiles`
`sourceRefs <- scope`

를 제거한다.

수정 의미:

- `scope`: candidate.scope 또는 명시적 applicability 정보
- `sourceRefs`: candidate.sourceRefs만
- `relatedFiles`: 필요하면 scope discovery의 보조 입력이 될 수 있으나 freshness source로 자동 승격하지 않음

explicit sourceRefs를 scope가 덮어쓰지 않아야 한다.

## W2-2. freshness fallback 제거

`attachFreshness()`와 canonical mapping에서:

- sourceRefs가 없다는 이유로 scope를 filesystem freshness refs로 사용하지 않는다.
- sourceRefs가 없으면 `no-source-refs` 상태로 처리한다.
- scope glob은 path applicability matcher에서만 사용한다.

새 compatibility fallback을 추가하지 않는다.

## W2-3. auto candidate도 source와 applicability를 분리

현재 `autoCandidate()`의 `sourceRefs = normalized.scope`를 제거한다.

structured signal이 실제 source refs를 제공할 때만 sourceRefs로 사용한다.

changedPaths/scope는 applicability로 유지한다.

## W2-4. legacy records는 일괄 소생시키지 않음

기존 151 stale/deep records를 DB에서 일괄 수정하지 않는다.

세 그룹으로 분리한다.

1. **true stale**
   - source가 실제로 삭제/이동됐고 현재 statement도 검증되지 않음
   - 계속 제외

2. **needs deep verify**
   - source가 존재하지만 digest가 변함
   - 현재 source에서 statement를 재검증한 경우에만 새/current record로 승격

3. **false stale candidate**
   - old scope/sourceRefs conflation 때문에 wildcard/applicability가 sourceRef가 된 경우
   - current source evidence를 다시 수집해 수정된 candidate를 생성
   - 기존 record는 audit/supersession history로 보존

기존 row를 silent rewrite하지 않는다.

## 테스트

최소 fixture:

- scope: `src/kernel/**`
- sourceRefs: `src/kernel/knowledge/context-load.ts`

기대:

- scope glob은 applicability에 사용
- sourceRefs 실제 파일만 digest
- 생성 직후 false stale가 되지 않음

추가 fixture:

- explicit sourceRefs가 scope와 다를 때 sourceRefs 보존
- missing explicit sourceRef는 여전히 stale
- modified sourceRef는 needs_deep_verify
- no sourceRefs는 sourceRefs 없는 knowledge 정책을 따름
- glob을 existsSync 대상으로 검사하지 않음

## 실제 데이터 검증

수정 후 선택된 representative knowledge를 current source로 재검증한다.

성공 기준은 "151건을 모두 되살림"이 아니다.

성공 기준:

- true stale는 계속 제외
- current source로 검증된 유용한 knowledge가 적절한 stage에 다시 등장
- FRAME/EXECUTE/CLOSE가 무조건 non-zero여야 한다는 인위적 목표는 두지 않음
- 단, current applicable knowledge를 fixture에 넣었을 때 해당 stage에서 실제 선택되어야 함

---

# 7. Wave 3 — evidence binding 복구와 C5 promotion 품질 개선

## 목적

구체적인 교훈은 persisted evidence와 연결되어 수용되고,
일반 오류 문자열은 durable knowledge를 오염시키지 않게 한다.

## W3-1. explicit observation evidence binding

현재 review는 candidate evidenceRefs와 persisted verification의 다음 값을 exact match한다.

- evidenceDigest
- evidenceRef
- acceptance coverage
- obligation id

이 gate는 유지한다.

수정 대상은 producer/binding이다.

평가 결과를 durable knowledge로 만들려면 먼저 해당 결과가 persisted verification receipt로 표현되어야 한다.

관찰 candidate는:

- verification evidenceDigest/evidenceRef
- acceptanceIds
- obligationIds

중 사용 가능한 authoritative binding을 참조한다.

temp report path를 verification receipt와 무관하게 evidenceRefs로 넣고 통과시키지 않는다.

## W3-2. 평가 artifact와 verification의 연결

Prompt/retrieval/eval 결과를 knowledge evidence로 사용할 경우:

- 기존 verification receipt에 artifact digest/ref를 연결하거나
- existing evidence recording path를 통해 verification으로 기록

새 evidence DB/table을 만들지 않는다.

## W3-3. generic blocker durable promotion 억제

현재 repeated blocker는 자동으로 `known_failure_pattern` candidate가 될 수 있고,
auto candidate는 `blocker://...` structured receipt로 verified될 수 있다.

이 구조를 다음처럼 좁힌다.

- single/generic blocker observation은 episodic/audit evidence로 유지
- durable `known_failure_pattern` 승격은 기존 cross-run evidence 경로를 우선
- 반복 + current relevance + resolution/actionable mitigation + improvement pair 조건이 있는 경우에만 durable promotion

새 taxonomy는 만들지 않는다.

## 변경 후보 경로

- `src/kernel/knowledge/candidate-review.ts`
- `src/kernel/knowledge/capture.ts`
- `src/kernel/knowledge/cross-run-evidence.ts`
- observation producer/eval integration의 기존 경로
- 관련 focused tests

## 회귀 fixture

반드시 두 대비 사례를 만든다.

### Case A — 구체적 교훈

- evaluation result가 persisted verification에 연결됨
- explicit candidate가 같은 evidence digest/ref를 참조
- 결과: verified

### Case B — 일반 blocker

- generic blocker string 반복
- resolution/improvement pair 없음
- 결과: durable known_failure_pattern으로 자동 승격되지 않음

## 완료 조건

- 최근 explicit 3건과 같은 형태의 유용한 관찰을 올바른 receipt binding으로 수용 가능
- verification 없는 임의 artifact path는 계속 거절
- blocker structured receipt가 durable failure pattern의 우회 승인 경로가 되지 않음

---

# 8. Wave 4 — end-to-end Knowledge supply 검증

## 목적

Wave 1~3이 개별 함수 수준에서만 맞는 것이 아니라 실제 Kernel context 공급에서 작동하는지 검증한다.

## 시나리오

current project fixture에 다음 지식을 준비한다.

1. FRAME용 current architecture/constraint knowledge
2. EXECUTE용 relevant semantic fact/procedure
3. PROVE용 required verification/failure pattern
4. CLOSE용 current semantic/constraint knowledge
5. stale knowledge
6. changed source knowledge
7. duplicate knowledge

## 확인 항목

- current + relevant knowledge만 선택
- stale knowledge 제외
- changed source는 deep verify 전 제외
- duplicate는 대표 하나만 렌더링
- procedure/verification 의미 차이는 보존
- stage type policy 유지
- context budget 유지
- strictness/degraded behavior 유지
- context receipt가 selection/omission 이유를 설명

## 완료 조건

"지식이 있다"가 아니라:

> 검증된 current knowledge가 필요한 stage에서 선택되고, stale/irrelevant knowledge는 계속 제외된다.

---

# 9. Wave 5 — 기존 replay/eval로 비교

## 목적

구조 개선이 실제 품질에 도움이 되는지 확인한다.

새 evaluation engine은 만들지 않는다.

기존 자산을 재사용한다.

- retrieval eval
- model prompt replay
- existing comparison/receipt paths

## 비교 순서

항상:

1. quality
2. rework
3. efficiency

### Quality gate

- relevant knowledge retrieval 증가
- stale knowledge leakage 없음
- wrong-stage knowledge 없음
- verification policy 약화 없음
- blocker noise 감소

### Rework gate

- 불필요한 재탐색 감소 여부
- knowledge 때문에 잘못된 수정/재검증이 늘지 않음
- replan/repair가 악화되지 않음

### Efficiency gate

quality/rework가 통과한 뒤에만 본다.

- prompt chars/tokens
- tool/action count
- elapsed time
- model usage

owner-session session total token을 Run별로 중복 배분하지 않는다.

## single-variable 원칙

Wave별 변경을 별도로 비교한다.

- A: duplicate collapse only
- B: scope/sourceRefs semantic fix
- C: evidence/promotion fix

여러 변경을 한 candidate arm에 섞어 인과성을 잃지 않는다.

---

# 10. Wave 6 — Historical improvement loop 최소 자동화

## 시작 조건

Wave 1~5가 완료되고 실제 구조 개선 효과가 확인된 뒤 시작한다.

C1/C2/C4 전체 도구화는 이 전까지 선행 조건이 아니다.

## 범위

read-only 분석 helper만 추가한다.

최소 HistoricalWorkCase에는 다음만 포함한다.

- run identity
- explicit session binding when available
- provenance kind
- contract/plan/mutation revision
- workspace/source identity
- verification summary
- knowledge context summary
- usage receipt coverage
- session telemetry는 명시적으로 귀속 가능한 경우만
- current/resolved/stale/insufficient evidence classification

fuzzy objective matching은 authority가 아니다.

## 목적

향후 사용자가 개선 루프 실행을 요청할 때:

1. current generation 반복 문제 탐색
2. 이미 해결된 historical issue 제외
3. evidence 부족 후보 보류
4. 작은 candidate 생성
5. 기존 replay로 검증

을 반복할 수 있게 한다.

---

# 11. 후순위 후보

다음은 Knowledge supply 복구 이후 다시 판정한다.

## C7 action hotspot mining

실행 의미를 search/read/modify/verify/kernel/git/environment로 분류한다.

새 scheduler나 command cache를 만들기 전에 반복 원인을 확인한다.

## C8 replan cause mining

replan을 requirement/environment/verification/workspace/contract/operator-change로 분류한다.

현재 user intervention 0이라는 최신 상태를 고려한다.

## C9 eval asset ownership cleanup

새 경로가 실제로 사용된 뒤에만:

- active production
- active eval
- compatibility projection
- dead/historical

로 분류해 제거한다.

---

# 12. 구현 순서 요약

| Wave | 핵심 변경 | production 영향 | 완료 증거 |
|---|---|---|---|
| W0 | ledger/provenance/revision 관측 의미 정정 | 거의 없음 | owner-session을 telemetry failure로 오판하지 않음 |
| W1 | safe canonical context collapse | read model만 | PROVE duplicate 제거, 의미 차이 보존 |
| W2 | scope/sourceRefs/freshness 경계 복구 | Knowledge 생성/선택 | current valid knowledge가 stage에 공급됨 |
| W3 | verification binding + durable promotion 품질 | Knowledge review/capture | 구체적 교훈 수용, generic blocker 승격 억제 |
| W4 | end-to-end context supply 검증 | 없음 | current/relevant만 공급 |
| W5 | existing replay 비교 | 없음 | quality → rework → efficiency 통과 |
| W6 | historical loop 최소 자동화 | Host/offline only | 반복 실행 가능한 read-only candidate inventory |

---

# 13. Wave별 커밋 원칙

각 Wave는 독립 검증 후 별도 커밋한다.

권장 커밋 단위:

- W0: `refactor(eval): 실행 provenance와 revision 관측 기준 정정`
- W1: `fix(knowledge): context의 canonical 중복 선택 제거`
- W2: `fix(knowledge): scope와 freshness source 경계 분리`
- W3: `fix(knowledge): 평가 증거 연결과 failure pattern 승격 정합화`
- W4/W5: 코드 변경이 없으면 결과 문서만 별도 커밋
- W6: `feat(eval): 현재 generation 개선 후보 분석 경로 추가`

커밋 본문에는 한글로 다음을 상세히 기록한다.

- 원인
- 변경 경계
- 회귀 방지 조건
- focused test
- replay/eval 판정
- 하지 않은 변경

Wave 간 변경을 섞지 않는다.

---

# 14. 최종 완료 조건

전체 작업은 다음 조건을 모두 만족할 때 완료한다.

1. scope와 sourceRefs가 서로 다른 의미로 보존된다.
2. sourceRefs가 없는 knowledge에 scope를 freshness source로 자동 대입하지 않는다.
3. valid current knowledge가 applicable stage에 실제 공급된다.
4. true stale와 changed-unverified knowledge는 계속 제외된다.
5. context canonical duplicate가 제거된다.
6. procedure/verification의 의미 차이는 보존된다.
7. explicit useful observation이 persisted verification에 올바르게 연결될 수 있다.
8. arbitrary artifact path만으로 verification gate를 우회하지 못한다.
9. generic blocker가 durable known_failure_pattern으로 반복 오염되지 않는다.
10. owner-session 실행을 usage receipt 결함으로 오판하지 않는다.
11. session token을 여러 Run에 중복 귀속하지 않는다.
12. 기존 replay에서 quality와 rework가 baseline 이상이다.
13. efficiency 평가는 quality/rework 통과 후에만 사용한다.
14. public command/stage/table/provider fallback은 증가하지 않는다.
15. 프로젝트별 hardcoding 없이 동일 의미가 일반화된다.

최종 원칙:

> **먼저 검증된 지식이 다시 사용되는 경로를 복구한다. 그 다음 중복과 승격 품질을 정리한다. 자동화는 이 구조가 실제 작업에서 효과가 있음을 확인한 뒤 최소한으로 추가한다.**
