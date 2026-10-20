# Harness Improvement Loop — 상세 구현 작업계획

기준선: `main / 1e5ba8f4`
상위 계획: `W2_REVIEWED_EXECUTION_PLAN.md`
작성일: 2026-10-20
목적: Moonremote에서 Wave 단위로 실제 구현할 수 있도록 변경 경계, 파일, 테스트, 중단 조건, 커밋 기준을 고정한다.

---

# 1. 실행 원칙

이 계획은 기능을 추가하는 계획이 아니라 **기존 Knowledge lifecycle의 의미 경계를 복구하고 검증된 지식의 재사용률을 높이는 계획**이다.

다음 원칙을 모든 Wave에 적용한다.

1. 한 Wave에서 하나의 구조 문제만 해결한다.
2. 각 Wave는 focused test를 통과한 뒤 별도 커밋한다.
3. 전체 테스트는 각 Wave마다 돌리지 않는다.
4. 전체 Kernel 회귀 테스트는 W5 최종 비교 전에 한 번 수행한다.
5. 기존 SQLite authority를 교체하지 않는다.
6. 새 durable table, public command, workflow stage를 만들지 않는다.
7. 새 compatibility fallback을 추가해서 오래된 잘못된 의미를 보존하지 않는다.
8. 현재 source와 receipt로 재검증되지 않은 legacy Knowledge는 자동 복구하지 않는다.
9. 프로젝트명, 특정 path, 특정 commit SHA를 production 조건으로 하드코딩하지 않는다.
10. 실행 중 새 구조 문제가 발견되면 해당 Wave 범위를 확장하지 말고 checkpoint에 별도 후보로 기록한다.

Moonremote 실행 규칙:

- 매 Wave 시작 시 현재 task의 `get_work_context`부터 확인한다.
- 이전 Wave가 완료됐으면 해당 변경과 검증을 반복하지 않는다.
- 한 사용자 요청에서 기본적으로 한 Wave만 구현한다.
- Wave 완료 시:
  1. focused 검증
  2. `git diff --check`
  3. checkpoint update
  4. 한글 상세 커밋
  5. 가능하면 push
  6. 최종 응답 후 다음 Wave 대기
- push 인증이 없으면 커밋까지 완료하고 push 실패 원인만 기록한다.

---

# 2. 현재 기준선과 반드시 보존할 사실

현재 local/runtime evidence에서 다음은 확정됐다.

## 2.1 Knowledge 공급 상태

대표 최신 completed Run의 context receipt:

| Stage | selected facts | unique content | prompt chars |
|---|---:|---:|---:|
| FRAME | 0 | 0 | 42 |
| EXECUTE | 0 | 0 | 44 |
| PROVE | 28 | 2 | 837 |
| CLOSE | 0 | 0 | 42 |

PROVE 내용:

- `unsupported-verification`: 27
- `delivery_materialization_recovery_required`: 1

freshness 제외:

- `freshness_stale`: 131
- `freshness_needs_deep_verify`: 20

## 2.2 Knowledge canonical duplication

moonshot-relay committed Knowledge:

- total: 179
- canonical unique: 33
- duplicate occurrences: 146

이 수치는 DB 정리 대상 수가 아니다.
read-model에서 중복 의미가 반복 공급되는 문제를 나타낸다.

## 2.3 최신 실행 ledger

2026-10-11 이후 Run 34개:

- legacy `attempts`: 0
- `run_step_attempts`: 53
- provenance `owner-session`: 53/53
- `model_usage_receipts`: 0

따라서 usage receipt absence를 telemetry failure로 단정하지 않는다.

## 2.4 Explicit Knowledge evidence 실패

최근 explicit observation 3건:

- status: rejected
- rejection: `MISSING_VERIFICATION_EVIDENCE`

반면 generic automatic blocker는 `blocker://...` structured receipt를 사용할 수 있다.

## 2.5 현재 코드에서 확인된 경계 오류

`src/kernel/knowledge-ingestion/normalize.ts`

현재:

- `scope = candidate.scope || candidate.sourceRefs || candidate.relatedFiles`
- `sourceRefs = scope`

즉 applicability와 freshness source가 하나로 합쳐진다.

`src/kernel/knowledge/freshness.ts`

현재:

- explicit sourceRefs가 없으면 `record.scope`를 freshness refs로 사용한다.

`src/kernel/knowledge/canonical-record-mapper.ts`

현재:

- candidate sourceRefs가 없으면 scope를 attachFreshness에 넘긴다.

`src/kernel/knowledge/capture.ts`

현재:

- automatic candidate의 `sourceRefs = normalized.scope`

이 네 경계가 W2의 핵심 변경 대상이다.

---

# 3. 변경 소유권

| 영역 | 현재 authority | 이번 계획의 역할 |
|---|---|---|
| Run/Step 실행 | `run_step_attempts` + Run state | 변경하지 않음 |
| Session binding | existing session bindings | 분석 시 재사용 |
| Usage receipt | existing host execution receipt | 의미만 정확히 해석 |
| Knowledge persistence | SQLite Knowledge records | 원본 보존 |
| Knowledge freshness | `freshness.ts` | scope/sourceRefs 의미 분리 |
| Knowledge selection | `context-load.ts` | canonical duplicate collapse |
| Knowledge render | `context-render.ts` | 가능하면 변경하지 않음 |
| Knowledge capture | `capture.ts` | auto signal source/applicability 분리 |
| Knowledge review | `candidate-review.ts` | authoritative verification binding 유지 |
| Durable promotion | `cross-run-evidence.ts` + Improvement Pair | 기존 경로 재사용 |
| Eval/replay | `src/host-tooling/kernel-eval/*` | 비교와 read-only 분석 |
| Historical automation | W6에서만 | production authority 아님 |

---

# 4. Wave 0 — 실행 관측 semantics 정정

## 4.1 목표

향후 개선 효과를 잘못 측정하지 않도록 **현재 실행 ledger와 provenance를 기준으로 evidence를 해석하는 최소 read-only 규칙**을 만든다.

이 Wave는 Knowledge runtime 동작을 바꾸지 않는다.

## 4.2 우선 조사할 기존 API

새 SQL reader를 만들기 전에 다음 기존 경계를 재사용한다.

- `src/kernel/persistence/work-lifecycle-store.ts`
- `src/kernel/persistence/work-attempt-store.ts`
- `src/kernel/persistence/host-execution-store.ts`
- `src/kernel/persistence/trust-store.ts`

특히 다음 필드는 이미 존재한다.

- `provenanceKind`
- `actorSessionId`
- `usageReceiptId`
- `planRevision`
- `mutationRevision`
- `contractRevision`
- `sourceIdentity`
- workspace identity

### 설계 규칙

새 helper가 필요하면 Host/eval 내부의 **pure projection helper**로 만든다.

권장 우선순위:

1. 기존 eval 모듈에 작은 함수로 추가
2. 두 개 이상 eval이 공유해야 할 때만 별도 파일 추가
3. Kernel state-store API는 read-only 재사용
4. raw SQLite query를 production helper에 새로 넣지 않음

별도 파일이 필요하다면 후보:

`src/host-tooling/kernel-eval/execution-evidence.ts`

단, 기존 모듈 안에서 해결되면 파일을 만들지 않는다.

## 4.3 최소 관측 구조

내부 eval view는 최소한 다음 값을 가져야 한다.

- runId
- attemptId
- provenanceKind
- actorSessionId 존재 여부
- usageReceiptId 존재 여부
- contractRevision
- planRevision
- mutationRevision
- sourceIdentity
- workspace identity
- attempt status

새 public schema나 generated contract로 만들지 않는다.

## 4.4 핵심 판정 규칙

### Rule A — current ledger

`run_step_attempts`가 존재하면 current execution evidence로 사용한다.

legacy `attempts`는 current execution count를 대체하지 않는다.

### Rule B — usage receipt absence

`owner-session + usageReceiptId=null`은:

`owner-session-unattributed-cost`

와 같은 분석 상태로 볼 수는 있지만 **telemetry failure**로 판정하지 않는다.

실제 이름은 기존 eval naming과 맞춰 정한다.

### Rule C — revision identity

다음 중 하나가 다르면 동일 execution evidence로 merge하지 않는다.

- contractRevision
- planRevision
- mutationRevision

### Rule D — session token attribution

Codex session total token은 다음 조건 없이는 Run 비용으로 귀속하지 않는다.

- explicit run binding
- explicit turn binding
- usage receipt
- 또는 동일 수준의 durable execution identity

동일 session이 여러 Run에 연결되면 total token을 Run 수만큼 복제하지 않는다.

## 4.5 테스트

기존 테스트를 최대한 확장한다.

우선 후보:

- `tests/kernel-attempt-provenance.test.ts`
- `tests/kernel-run-step-ledger.test.ts`
- `tests/kernel-model-usage-receipt.test.ts`
- 관련 Host eval test

필요한 신규 focused case:

1. owner-session + no usage receipt
2. routed + usage receipt
3. kernel-owned + usage receipt
4. legacy-unattributed
5. 한 session / 두 Run
6. 같은 Run이지만 planRevision 다름
7. 같은 Run/plan이지만 mutationRevision 다름

## 4.6 focused 검증

최소:

```bash
npm run build:tests
node --test --test-concurrency=1 \
  tests/kernel-attempt-provenance.test.mjs \
  tests/kernel-run-step-ledger.test.mjs \
  tests/kernel-model-usage-receipt.test.mjs
npm run typecheck
git diff --check
```

관련 eval test를 추가했다면 그 파일도 포함한다.

## 4.7 중단 조건

다음이 필요해지면 W0 구현을 중단하고 계획을 재검토한다.

- DB migration
- 새 durable receipt
- Kernel public API 확장
- session token을 추정으로 분배해야만 기능이 성립
- owner-session 동작 자체 변경

W0 목적은 관측 의미 수정이지 telemetry subsystem 추가가 아니다.

## 4.8 완료 기준

- 최신 53 owner-session attempts를 실행 없음으로 보지 않는다.
- usage receipt 0을 telemetry failure로 자동 판정하지 않는다.
- revision이 다른 evidence를 합치지 않는다.
- session cost 중복 귀속이 없다.
- runtime behavior는 변경되지 않는다.

## 4.9 커밋

권장:

`refactor(eval): 실행 provenance와 revision 관측 기준 정정`

본문:

- current ledger 기준 전환
- owner-session receipt 해석
- revision fence
- token attribution 금지 규칙
- 검증 파일과 결과
- production runtime 미변경

---

# 5. Wave 1 — canonical Knowledge context 중복 제거

## 5.1 목표

Knowledge DB를 정리하지 않고 **context selection에서 동일 의미를 한 번만 공급**한다.

PROVE의 반복 noise를 제거해 W2 효과를 정확히 측정할 수 있게 한다.

## 5.2 삽입 위치

우선 위치:

`src/kernel/knowledge/context-load.ts`

현재 순서:

1. SQLite records load
2. active/freshness filtering
3. stage filtering
4. procedure scope/relevance
5. budget
6. render

중복 collapse는 **freshness와 stage 의미를 잃지 않도록 active/freshness filtering 후, budget 계산 전**에 적용한다.

권장 순서:

1. active/freshness
2. stage policy
3. procedure/relevance
4. canonical collapse
5. budget
6. render

이렇게 하면:

- stale record가 fresh 대표 record를 덮지 않음
- wrong-stage record가 같은 statement라는 이유로 surviving record를 바꾸지 않음
- budget 직전 중복만 제거 가능

## 5.3 canonical key 재사용

이미 두 개의 유사 identity가 있다.

- `src/kernel/knowledge/capture.ts::canonicalKnowledgeIdentity`
- `src/kernel/knowledge-ingestion/deduplicate.ts::candidateKey`

새 세 번째 normalizer를 만들지 않는다.

우선 `canonicalKnowledgeIdentity` 의미를 재사용한다.

단, context-load에서 capture import가 dependency cycle을 만들면:

- 기존 helper를 더 낮은 Knowledge 공용 모듈로 이동
- capture, persistence, context-load가 그 helper를 같이 사용

을 선택한다.

duplicate identity 함수 복제는 금지한다.

## 5.4 일반 record key

최소:

- canonical type
- normalized statement
- normalized scope

## 5.5 procedure key

procedure는 statement만 같아도 다른 동작일 수 있다.

따라서 procedure에는 다음 semantic body를 포함한다.

- metadata title/summary
- prerequisites
- steps
- verification
- prohibitions
- scope

동일 statement + 다른 procedure body는 collapse하지 않는다.

## 5.6 required_verification key

다음 차이가 있으면 별도 유지한다.

- commandRefs
- obligation
- verification method/evidence level
- scope

## 5.7 representative 선택

중복 group에서 임의 순서로 첫 row만 선택하면 안 된다.

대표 선택 우선순위:

1. current active/fresh record
2. higher trust tier
3. higher confidence
4. newer verified/revision metadata
5. stable id lexical order as deterministic final tie-break

단, 현재 record type에 없는 metadata를 추가 저장하지 않는다.

## 5.8 provenance 보존

DB row를 합치지 않는다.

context receipt에 별도 duplicate count를 추가할 필요가 없다면 새 field를 만들지 않는다.

기존 `omittedByPolicy`에 다음 수준의 reason을 기록할 수 있다.

`canonical_duplicate`

기존 receipt shape가 arbitrary reason을 허용하는 경우에만 사용한다.

새 contract 변경이 필요하다면 reason 추가 자체를 생략하고 deterministic selection만 구현한다.

## 5.9 테스트

주요 파일:

- `tests/kernel-knowledge-context.test.ts`
- `tests/kernel-knowledge-procedure-context.test.ts`
- `tests/kernel-knowledge-procedure-representation.test.ts`
- 필요하면 새 focused context dedupe test

필수 case:

1. 같은 type/statement/scope 10건 → 1건
2. 같은 statement, 다른 scope → 2건
3. 같은 semantic fact지만 stale + fresh → fresh 1건
4. same procedure statement, different steps → 2건
5. same required verification statement, different commandRefs → 2건
6. exact duplicate procedure → 1건
7. duplicate 제거 후 budget에 다음 유효 record가 들어오는지 확인

## 5.10 실제 데이터 비교

대표 runtime fixture를 복제한 read-only test data로:

before:

- PROVE facts 28
- unique 2
- prompt 837 chars

after:

- semantic unique 의미 유지
- `unsupported-verification` 반복 1건으로 collapse
- exact char 수는 완료 조건이 아님

## 5.11 focused 검증

```bash
npm run build:tests
node --test --test-concurrency=1 \
  tests/kernel-knowledge-context.test.mjs \
  tests/kernel-knowledge-procedure-context.test.mjs \
  tests/kernel-knowledge-procedure-representation.test.mjs \
  tests/context-budget.test.mjs
npm run typecheck
git diff --check
```

## 5.12 중단 조건

다음이 필요해지면 중단한다.

- Knowledge DB migration
- persisted row 삭제/merge
- render layer에 dedupe state 추가
- procedure body를 버려야만 dedupe 가능
- required verification command 의미 손실

## 5.13 완료 기준

- PROVE duplicate noise 감소
- semantic/procedure/verification 의미 차이 보존
- DB row/history 불변
- stage policy 불변
- budget semantics 불변

## 5.14 커밋

`fix(knowledge): context의 canonical 중복 선택 제거`

---

# 6. Wave 2 — scope/sourceRefs/freshness 경계 복구

## 6.1 목표

이번 전체 작업의 핵심 production 수정이다.

다음 세 의미를 분리한다.

- `scope`: 지식 적용 범위
- `sourceRefs`: freshness 검증 source
- `relatedFiles`: 관련 파일 metadata

## 6.2 Task A — candidate normalization 수정

파일:

`src/kernel/knowledge-ingestion/normalize.ts`

현재 잘못된 구조:

```text
scope = scope || sourceRefs || relatedFiles
sourceRefs = scope
```

목표:

```text
scope = explicit applicability scope
sourceRefs = explicit freshness refs
relatedFiles = related metadata
```

### 규칙

- candidate.scope가 있으면 그대로 normalize
- candidate.sourceRefs는 독립 normalize
- sourceRefs를 scope fallback으로 사용하지 않음
- scope를 sourceRefs fallback으로 사용하지 않음
- relatedFiles는 sourceRefs로 자동 승격하지 않음
- candidate identity의 scope dimension은 scope만 사용

기존 candidateId가 sourceRefs 때문에 scope가 달라지던 과거 row를 migrate하지 않는다.

## 6.3 Task B — freshness fallback 제거

파일:

`src/kernel/knowledge/freshness.ts`

현재:

`sourceRefs.length > 0 ? sourceRefs : record.scope`

목표:

- freshness digest는 sourceRefs만 사용
- sourceRefs 없음 → empty digest input
- `cheapReVerify()`는 sourceRefs 없음 → `fresh/no-source-refs`

이 정책은 이미 cheapReVerify에 존재하는 no-source-refs semantics를 일관되게 사용한다.

## 6.4 Task C — canonical mapper 수정

파일:

`src/kernel/knowledge/canonical-record-mapper.ts`

현재:

candidate sourceRefs 없으면 scope를 attachFreshness에 전달한다.

목표:

- explicit candidate.sourceRefs만 attachFreshness에 전달
- scope는 baseRecord.scope로만 유지

## 6.5 Task D — auto capture 수정

파일:

`src/kernel/knowledge/capture.ts`

현재:

`const sourceRefs = normalized.scope`

목표:

NormalizedSignal에서 다음을 분리한다.

- scope: applicability
- sourceRefs: explicit source/sourceFiles/sourceRefs only
- evidenceRefs: verification/evidence authority

autoCandidate:

- scope ← normalized.scope
- relatedFiles ← normalized related files if available
- sourceRefs ← normalized.sourceRefs
- evidenceRefs ← normalized.evidenceRefs

changedPaths는 scope로는 사용할 수 있지만 sourceRefs로 자동 사용하지 않는다.

## 6.6 Task E — canonical record semantics 확인

다음 타입은 sourceRefs가 없어도 존재할 수 있다.

- policy_anchor
- semantic_fact
- known_failure_pattern
- ontology_constraint

따라서 sourceRefs empty를 invalid record로 만들지 않는다.

반대로 explicit sourceRefs가 제공됐는데 missing이면 stale 판정은 그대로 유지한다.

## 6.7 Legacy Knowledge 처리

기존 DB row는 수정하지 않는다.

legacy record를 세 그룹으로 본다.

### Group 1 — true stale

- explicit source path가 실제로 없음
- 또는 현재 source와 statement가 더 이상 맞지 않음

계속 제외.

### Group 2 — changed / needs deep verify

- source path 존재
- digest 변경

자동 fresh 전환 금지.

현재 source에서 다시 verification된 경우 새 candidate/record로 진행.

### Group 3 — probable false stale

특징:

- sourceRefs 값에 glob이 있음
- sourceRefs가 scope와 완전히 동일
- path가 applicability pattern 형태
- 과거 conflation generation에서 생성

이 경우에도 row를 직접 수정하지 않는다.

current source를 재검증한 새 candidate가 생겼을 때 supersession/replacement lifecycle을 사용한다.

## 6.8 fixture 설계

필수 최소 fixture:

### F1 — explicit source vs scope

```text
scope      = ["src/kernel/**"]
sourceRefs = ["src/kernel/knowledge/context-load.ts"]
```

기대:

- scope applicability match 성공
- freshness는 context-load.ts만 검사
- `src/kernel/**`를 existsSync하지 않음

### F2 — missing source

```text
sourceRefs = ["src/kernel/missing.ts"]
```

기대:

- stale
- scope가 존재하더라도 source missing을 숨기지 않음

### F3 — changed source

digest 생성 후 file mutation.

기대:

- `needs_deep_verify`

### F4 — no sourceRefs

scope만 존재.

기대:

- `fresh/no-source-refs`
- scope는 relevance/applicability에 사용

### F5 — explicit sourceRefs preservation

normalizeCandidate 입력에서 scope와 sourceRefs가 다름.

기대:

- 둘 다 독립 보존

### F6 — relatedFiles only

relatedFiles만 있음.

기대:

- sourceRefs로 자동 변환되지 않음
- 필요하면 relatedFiles metadata만 보존

## 6.9 관련 테스트

- `tests/kernel-knowledge-freshness.test.ts`
- `tests/kernel-knowledge-freshness-load.test.ts`
- `tests/kernel-knowledge-procedure-representation.test.ts`
- `tests/kernel-knowledge-candidate.test.ts`
- normalization 관련 existing/new focused test
- `tests/kernel-standalone-project-knowledge.test.ts` — import regression

## 6.10 focused 검증

```bash
npm run build:tests
node --test --test-concurrency=1 \
  tests/kernel-knowledge-freshness.test.mjs \
  tests/kernel-knowledge-freshness-load.test.mjs \
  tests/kernel-knowledge-candidate.test.mjs \
  tests/kernel-knowledge-procedure-representation.test.mjs \
  tests/kernel-standalone-project-knowledge.test.mjs
npm run typecheck
git diff --check
```

## 6.11 실제 Knowledge 재검증

production DB를 bulk rewrite하지 않는다.

read-only audit로 다음 count를 만든다.

- sourceRefs missing
- sourceRefs glob-like
- sourceRefs == scope
- explicit real source exists
- digest changed
- no source refs

이 audit 결과 중 대표 current Knowledge만 골라 fresh candidate flow로 재검증한다.

실제 write-back이 필요하면 별도 Wave 안에서 기존 commit/supersession authority를 사용한다.
DB raw update 금지.

## 6.12 중단 조건

- scope/sourceRefs 분리를 위해 schema migration이 필요함
- 외부 source path를 자동 추정해야 함
- glob expansion을 freshness engine에 추가해야 함
- old record를 silent rewrite해야 함

위 경우 계획 재검토.

## 6.13 완료 기준

- 신규 candidate에서 scope/sourceRefs 독립 보존
- glob scope가 freshness source로 사용되지 않음
- true stale 유지
- changed source deep verify 유지
- no-source-ref record가 잘못 stale 처리되지 않음
- current valid Knowledge fixture가 EXECUTE/FRAME 등 해당 stage에서 선택 가능

## 6.14 커밋

`fix(knowledge): scope와 freshness source 경계 분리`

---

# 7. Wave 3 — verification evidence binding 및 C5 승격 품질

## 7.1 목표

**구체적인 지식은 강한 evidence로 수용하고, 일반 오류명은 durable memory로 쉽게 승격하지 않도록** Knowledge review/capture을 정합화한다.

## 7.2 보존할 핵심 보안/신뢰 규칙

`candidate-review.ts`의 다음 조건은 약화하지 않는다.

verification candidate match:

- status == passed
- exitCode == 0
- evidenceDigest 존재
- candidate evidenceRefs와 evidenceDigest/evidenceRef match
- acceptanceIds match
- obligationIds match
- source/mutation freshness constraints

`MISSING_VERIFICATION_EVIDENCE` gate를 제거하지 않는다.

## 7.3 Task A — explicit observation producer 추적

먼저 최근 explicit 3건을 만든 producer를 찾는다.

찾아야 하는 값:

- candidate sourceKind=explicit
- evidenceRefs가 temp file path가 된 경로
- 해당 Run에 persisted verification이 어떤 evidenceRef/digest를 가졌는지
- acceptance/obligation 연결이 있었는지

production 수정 전에 producer→review까지 exact dataflow를 테스트로 재현한다.

## 7.4 Task B — artifact를 verification authority에 연결

eval 결과가 Knowledge 근거가 되려면 다음 중 하나를 만족시킨다.

1. existing verification receipt의 evidenceRef가 eval artifact를 authoritative ref로 가리킴
2. existing evidence recording path를 통해 artifact digest가 persisted verification evidenceDigest로 기록됨

금지:

- candidate-review에서 filesystem path existence만 보고 승인
- arbitrary temp path hashing만으로 verification 간주
- evidencePack을 persisted verification 대체 authority로 사용

## 7.5 Task C — explicit candidate binding

explicit observation producer는 가능하면 다음을 직접 참조한다.

- verification evidenceDigest
- verification evidenceRef
- acceptanceIds
- obligationIds

candidate review는 기존 exact matcher를 그대로 사용한다.

## 7.6 Task D — generic blocker promotion 정리

현재 두 durable candidate 경로가 병존한다.

1. `capture.ts` repeated blockers → `known_failure_pattern`
2. `cross-run-evidence.ts` → resolution + Improvement Pair가 있는 durable promotion

2번이 더 강한 authority다.

따라서 repeated blocker generic path는 durable promotion authority가 되지 않도록 줄인다.

권장 방식:

- repeated generic blocker는 episodic candidate로 남김
- durable known_failure_pattern은 cross-run promotion path를 사용
- 명확한 기존 non-generic structured signal이 별도 계약을 가진 경우만 예외 검토

새 signal taxonomy를 추가하지 않는다.

## 7.7 구조적 중복 제거

`capture.ts`의 repeated blocker loop와 `cross-run-evidence.ts`가 같은 역할을 중복한다면, durable promotion은 cross-run path 하나로 수렴시킨다.

단, raw observation 수집 자체는 유지한다.

즉:

```text
observation collection
        ↓
episodic evidence
        ↓
cross-run grouping
        ↓
resolution + current evidence + improvement pair
        ↓
durable known_failure_pattern
```

## 7.8 필수 테스트 Case A — useful explicit lesson

상황:

- evaluation artifact 생성
- persisted verification passed
- artifact evidence가 receipt에 연결
- explicit candidate가 same evidence identity 참조

기대:

- review verified
- committed candidate의 evidenceRefs는 authoritative digest/ref
- temp local path 자체가 trust authority가 아님

## 7.9 필수 테스트 Case B — missing verification

상황:

- explicit candidate가 report path만 가짐
- persisted verification 없음

기대:

- `MISSING_VERIFICATION_EVIDENCE`
- 현재 fail-closed behavior 유지

## 7.10 필수 테스트 Case C — generic blocker

상황:

- 같은 generic blocker string 여러 Run
- resolution 없음
- Improvement Pair 없음

기대:

- episodic only
- durable known_failure_pattern 미생성

## 7.11 필수 테스트 Case D — resolved cross-run failure

상황:

- 독립 Run에서 반복 failure
- current successful resolution
- current success evidence
- scope owner
- rollback
- Improvement Pair ready

기대:

- 기존 `cross-run-promotion`으로 durable candidate 생성
- review gate 통과 조건은 기존 C22/C24 계약 유지

## 7.12 관련 파일

우선:

- `src/kernel/knowledge/candidate-review.ts`
- `src/kernel/knowledge/capture.ts`
- `src/kernel/knowledge/cross-run-evidence.ts`

producer가 eval 쪽이면 최소 해당 producer만 수정.

가능한 관련 tests:

- `tests/kernel-knowledge-review.test.ts`
- `tests/kernel-knowledge-cross-run-evidence.test.ts`
- `tests/kernel-knowledge-cross-run-promotion.test.ts`
- `tests/kernel-knowledge-improvement-promotion.test.ts`
- `tests/kernel-finalization-knowledge-nonblocking.test.ts`

## 7.13 focused 검증

```bash
npm run build:tests
node --test --test-concurrency=1 \
  tests/kernel-knowledge-review.test.mjs \
  tests/kernel-knowledge-cross-run-evidence.test.mjs \
  tests/kernel-knowledge-cross-run-promotion.test.mjs \
  tests/kernel-knowledge-improvement-promotion.test.mjs \
  tests/kernel-finalization-knowledge-nonblocking.test.mjs
npm run typecheck
git diff --check
```

## 7.14 중단 조건

- review gate를 느슨하게 해야만 explicit lesson을 살릴 수 있음
- persisted verification 없이 artifact path를 authority로 써야 함
- 새로운 approval system 필요
- 새 Knowledge type 필요

이 경우 구현 중단.

## 7.15 완료 기준

- explicit useful lesson을 올바른 verification binding으로 verified 가능
- arbitrary artifact path는 계속 rejected
- generic blocker 반복만으로 durable pattern 생성 안 됨
- 기존 cross-run Improvement Pair promotion은 유지
- Knowledge failure가 code finalization을 막지 않는 기존 nonblocking invariant 유지

## 7.16 커밋

`fix(knowledge): 평가 증거 연결과 failure pattern 승격 정합화`

---

# 8. Wave 4 — End-to-End Knowledge supply 회귀 고정

## 8.1 목표

W1~W3 변경이 isolated unit behavior가 아니라 **실제 stage context materialization**에서 맞는지 고정한다.

## 8.2 fixture 구성

하나의 temporary project fixture에 최소 다음 record를 만든다.

### K1 — FRAME current architecture/constraint

- valid sourceRef
- FRAME allowed type
- objective/path relevant

기대: selected.

### K2 — EXECUTE semantic fact

- valid sourceRef
- changed path relevant

기대: selected.

### K3 — EXECUTE procedure A

- scope match
- current source
- procedure body

기대: selected with body.

### K4 — EXECUTE procedure B

- same statement as A
- different steps

기대: 별도 보존.

### K5 — PROVE required verification

- distinct command binding

기대: selected.

### K6/K7 — exact duplicate known failure

기대: 한 번만 selected.

### K8 — missing source

기대: stale excluded.

### K9 — changed source digest

기대: deep verify excluded.

### K10 — scope-only no-sourceRefs fact

기대: freshness 때문에 제외되지 않음. relevance policy로만 판정.

### K11 — wrong-stage type

기대: omittedByPolicy.

## 8.3 검증 포인트

각 stage에 대해 다음을 assert한다.

- selected record IDs
- omitted reasons
- stale reasons
- context status
- promptBlock content
- promptBlock duplicate absence
- procedure semantic distinction
- context digest stability

## 8.4 관련 테스트

기존을 확장하는 것이 우선:

- `tests/kernel-knowledge-reuse-e2e.test.ts`
- `tests/kernel-stage-knowledge-remediation.test.ts`
- `tests/kernel-knowledge-procedure-context.test.ts`
- `tests/kernel-knowledge-context.test.ts`

새 파일을 만들 경우 단 하나의 E2E fixture file로 제한한다.

예:

`tests/kernel-knowledge-supply-e2e.test.ts`

## 8.5 focused 검증

```bash
npm run build:tests
node --test --test-concurrency=1 \
  tests/kernel-knowledge-reuse-e2e.test.mjs \
  tests/kernel-stage-knowledge-remediation.test.mjs \
  tests/kernel-knowledge-procedure-context.test.mjs \
  tests/kernel-knowledge-context.test.mjs \
  tests/kernel-knowledge-supply-e2e.test.mjs
npm run typecheck
git diff --check
```

신규 파일이 없으면 마지막 항목 제외.

## 8.6 완료 기준

- valid/current/applicable knowledge가 실제 stage context에 들어감
- stale/deep verify는 계속 제외
- duplicate 제거
- procedure semantic difference 보존
- stage policy 불변
- strictness/degraded behavior 불변

## 8.7 커밋

production 코드 변경이 없고 테스트만 추가했다면:

`test(knowledge): 검증 지식 재공급 회귀 시나리오 고정`

---

# 9. Wave 5 — 기존 replay/eval로 품질 판정

## 9.1 목표

구조적으로 맞는 수정이 실제 작업 품질도 개선하는지 판단한다.

새 evaluation framework를 만들지 않는다.

## 9.2 비교 arm

단일 변수 비교를 위해 최소 3개 candidate를 분리한다.

### A — W1 only

canonical duplicate collapse.

### B — W2 semantics

scope/sourceRefs/freshness fix.

### C — W3 evidence/promotion

verification binding + promotion quality.

가능하면 baseline을 동일 fixture/revision으로 유지한다.

## 9.3 평가 순서

### Gate 1 — Quality

필수 통과:

- current relevant knowledge retrieval 감소하지 않음
- stale leakage 0
- wrong-stage leakage 0
- explicit evidence trust 약화 0
- durable generic blocker noise 감소
- procedure correctness 유지

Quality가 악화되면 즉시 reject.

### Gate 2 — Rework

측정:

- repeated search/read 감소 여부
- unnecessary verification 감소 여부
- replan 변화
- correction loop 변화
- wrong knowledge로 인한 수정 증가 여부

Quality pass 후에만 본다.

### Gate 3 — Efficiency

측정 가능한 경우:

- prompt chars
- input tokens
- action count
- elapsed time
- cache ratio
- model usage

owner-session 전체 session token을 Run metric으로 복제하지 않는다.

## 9.4 기존 eval 재사용

우선:

- `src/host-tooling/kernel-eval/retrieval-eval.ts`
- `src/host-tooling/kernel-eval/model-prompt-replay.ts`
- existing optimization cycle

새 AB runner를 만들지 않는다.

## 9.5 replay repeat

변동성 있는 모델 replay를 사용할 경우 기존 ABBA 계약을 따른다.

single-variable 조건을 깨는 다른 prompt/model/guidance 변경을 동시에 넣지 않는다.

## 9.6 전체 회귀 검증

W5에서 처음으로 넓은 회귀 테스트를 돌린다.

순서:

```bash
npm run build:check
npm run typecheck

npm run build:tests
node --test --test-concurrency=1 \
  tests/kernel-knowledge-*.test.mjs \
  tests/context-*.test.mjs

npm run test:kernel
```

리소스 제약이 있으면:

- focused suite
- `test:kernel`
- 전체 `npm test`

순으로 진행하고, 전체 `npm test`는 최종 closeout 직전에 한 번만 수행한다.

## 9.7 판정

각 change arm:

- `PROMOTE`
- `KEEP_BASELINE`
- `INSUFFICIENT_EVIDENCE`

중 하나로 명시한다.

효율 이득만 있고 quality/rework가 나쁘면 `KEEP_BASELINE`.

## 9.8 결과 문서

새 evaluation platform이 아니라 결과 문서만 저장한다.

예:

`docs/public/reference/harness-knowledge-supply-eval-2026-10-20.md`

## 9.9 커밋

평가 문서만 있으면:

`docs(eval): 지식 공급 경로 개선 비교 결과 기록`

---

# 10. Wave 6 — Historical Improvement Loop 최소 자동화

## 10.1 시작 조건

다음이 모두 충족되어야 한다.

- W1~W4 구조 검증 완료
- W5에서 최소 하나의 change arm PROMOTE
- current evidence interpretation W0 완료

그 전에는 시작하지 않는다.

## 10.2 목표

향후 사용자가 "하네스 개선 루프 실행"을 요청했을 때 현재 로컬 이력에서 후보를 반복 추출할 수 있게 한다.

production Kernel workflow에 넣지 않는다.

Host/offline tooling이다.

## 10.3 HistoricalWorkCase 최소 필드

필수:

- runId
- projectId
- explicit session binding if available
- provenanceKind
- contractRevision
- planRevision
- mutationRevision
- sourceIdentity/workspace identity
- verification summary
- knowledge context summary
- knowledge observation/promotion summary
- usage receipt presence
- attributable usage only
- completion status

선택:

- git revision
- objective digest as weak evidence

## 10.4 identity merge 규칙

강한 identity:

1. explicit binding
2. run lineage/successor
3. attempt lineage
4. workspace/source identity
5. commit identity

약한 identity:

- objective normalized digest
- timestamp proximity

약한 identity만으로 merge하지 않는다.

## 10.5 generation relevance

후보마다:

- observed source identity
- current source identity
- fixing seam revision if known
- comparable current evidence
- `current | resolved | stale | insufficient`

를 계산한다.

특정 commit SHA hardcode 금지.

Git ancestry와 seam history를 사용한다.

## 10.6 후보 분류

자동 수정은 하지 않는다.

output:

- RESOLVED
- DEFERRED
- CANDIDATE
- INSUFFICIENT

와 evidence를 같이 낸다.

## 10.7 첫 자동화 범위

Knowledge supply 문제부터 dogfood한다.

예:

- duplicate rate
- stage selection emptiness
- stale/deep verify ratio
- explicit rejection reasons
- generic blocker durable ratio

그 뒤 C7/C8을 추가한다.

## 10.8 Action hotspot은 후순위

다음 의미로만 정규화한다.

- search
- read
- modify
- focused verify
- full verify
- Kernel lifecycle
- Git read
- Git mutation
- environment/setup

새 command scheduler/cache는 만들지 않는다.

## 10.9 Replan mining 후순위

원인:

- requirement correction
- environment failure
- verification failure
- workspace/source drift
- contract repair
- operator scope change

반복 current-generation 원인만 production candidate로 승격한다.

## 10.10 검증

- fixture corpus
- current local read-only run
- no runtime DB writes
- no Codex log writes
- deterministic identity
- missing telemetry remains null/unknown

## 10.11 커밋

`feat(eval): 현재 generation 개선 후보 분석 경로 추가`

---

# 11. Wave별 파일 변경 예상표

| Wave | 우선 변경 파일 | 조건부 파일 |
|---|---|---|
| W0 | existing eval/read helpers | `src/host-tooling/kernel-eval/execution-evidence.ts` only if shared |
| W1 | `src/kernel/knowledge/context-load.ts` | canonical identity helper 위치 조정 |
| W2 | `normalize.ts`, `freshness.ts`, `canonical-record-mapper.ts`, `capture.ts` | related type definitions |
| W3 | `candidate-review.ts`, `capture.ts`, `cross-run-evidence.ts` | explicit observation producer |
| W4 | tests only preferred | one E2E test file |
| W5 | eval result doc preferred | existing replay fixtures only |
| W6 | `src/host-tooling/kernel-eval/*` | one read-only loader/helper |

---

# 12. 테스트 전략

## 12.1 원칙

각 Wave:

- 해당 unit/focused integration
- typecheck
- diff check

최종:

- Knowledge suite
- Kernel suite
- full suite once

## 12.2 반복 금지

각 Wave에서 다음을 반복하지 않는다.

- `npm test` 전체
- provider smoke 전체
- unrelated git closeout suite
- unrelated prompt suite

단, 변경 영향이 실제로 해당 경계까지 확장되면 추가한다.

## 12.3 실패 처리

focused test 실패 시:

1. 기존 baseline에서도 실패하는지 확인
2. 환경 실패와 regression 분리
3. 실패를 숨기기 위한 fallback 추가 금지
4. 해당 Wave scope 안에서만 수정
5. 다른 구조 문제면 checkpoint 후보로 분리

---

# 13. 복잡도 예산

전체 완료 후 다음을 확인한다.

| 항목 | 허용 증가 |
|---|---:|
| Kernel public command | 0 |
| Kernel workflow stage | 0 |
| durable DB table | 0 |
| model-visible workflow concept | 0 |
| mandatory approval gate | 0 |
| provider fallback | 0 |
| project-specific condition | 0 |
| independent eval service | 0 |

코드 라인 수 증가는 허용하지만 다음 원칙을 적용한다.

- 같은 normalization 함수 2개 이상 금지
- 같은 identity 계산 2개 이상 금지
- duplicate authority 금지
- 새로운 state machine 금지
- 새 abstraction은 두 소비자가 생기기 전에는 만들지 않음

---

# 14. 각 Wave 리뷰 체크리스트

Wave 완료 전 반드시 확인한다.

## Architecture

- 기존 authority가 그대로인가?
- 새 source of truth가 생기지 않았는가?
- 같은 의미의 helper를 복제하지 않았는가?
- compatibility fallback으로 오류를 숨기지 않았는가?

## Semantics

- scope = applicability인가?
- sourceRefs = freshness source인가?
- evidenceRefs = verification/evidence인가?
- 세 값이 다시 합쳐지지 않았는가?

## Trust

- persisted verification gate가 유지되는가?
- arbitrary file path가 authority가 되지 않았는가?
- generic blocker가 durable trust를 우회하지 않는가?

## Historical safety

- 기존 row를 bulk mutate하지 않았는가?
- stale record를 무조건 살리지 않았는가?
- supersession/audit lineage가 보존되는가?

## Evaluation

- quality를 먼저 봤는가?
- rework를 두 번째로 봤는가?
- efficiency만으로 promote하지 않았는가?
- owner-session token을 중복 귀속하지 않았는가?

---

# 15. 최종 종료 조건

다음 15개를 모두 만족해야 전체 작업 완료다.

1. current execution ledger를 `run_step_attempts`로 정확히 해석한다.
2. owner-session usage receipt absence를 telemetry failure로 오판하지 않는다.
3. session usage를 여러 Run에 중복 귀속하지 않는다.
4. Knowledge context canonical duplicate가 제거된다.
5. procedure semantic difference가 보존된다.
6. required verification command difference가 보존된다.
7. scope/sourceRefs가 normalization에서 독립적이다.
8. scope가 freshness fallback으로 사용되지 않는다.
9. explicit sourceRefs missing은 여전히 stale다.
10. modified source는 deep verify 상태를 유지한다.
11. current valid Knowledge가 applicable stage에 공급된다.
12. explicit useful lesson이 persisted verification으로 검증될 수 있다.
13. arbitrary artifact path는 verification을 우회하지 못한다.
14. generic blocker는 durable known_failure_pattern을 자동 오염시키지 않는다.
15. 기존 replay에서 quality → rework → efficiency 순서로 baseline 이상임을 확인한다.

W6 자동화는 위 구조적 완료 이후의 운영 편의 기능이다.
W6가 실패해도 W1~W5의 Knowledge 구조 개선을 되돌리지 않는다.

---

# 16. 실제 진행 순서

실행 요청 시 다음처럼 진행한다.

```text
W0 구현
→ focused test
→ review
→ checkpoint
→ commit/push
→ STOP

W1 구현
→ focused test
→ review
→ checkpoint
→ commit/push
→ STOP

W2 구현
→ focused test
→ representative knowledge audit
→ review
→ checkpoint
→ commit/push
→ STOP

W3 구현
→ explicit lesson / generic blocker 대비 test
→ review
→ checkpoint
→ commit/push
→ STOP

W4 E2E
→ checkpoint
→ test-only commit
→ STOP

W5 replay/eval
→ quality verdict
→ rework verdict
→ efficiency verdict
→ result doc
→ commit
→ STOP

W6 minimal automation
→ local corpus dogfood
→ final full regression
→ cleanup review
→ final commit/push
```

최종 기준:

> **Knowledge를 더 많이 저장하는 것이 목표가 아니다. 검증된 현재 지식이 필요한 순간에 정확히 공급되고, stale·중복·일반 오류 noise는 공급되지 않는 구조를 만든다.**
