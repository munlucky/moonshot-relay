# Harness Improvement Loop — 확정 후보 목록 및 우선순위

기준선: `main / a46c2e47`
조사일: 2026-10-20
범위: 로컬 Codex session, Kernel runtime-state, Git/source history를 이용한 read-only mining

> **리뷰 후 우선순위 변경:** 이 문서는 후보 inventory로 보존한다. 최종 구현 순서는 `W2_REVIEWED_EXECUTION_PLAN.md`가 대체한다. 핵심 P0는 canonical dedupe 단독이 아니라 **검증한 지식을 현재 작업에 다시 공급하는 scope/sourceRefs/freshness/evidence 경계 복구**다. C1/C2/C4 전체 도구화는 선행 조건이 아니다.

## 1. 조사 근거

현재 로컬에는 다음 실제 이력이 있다.

- Codex session JSONL currently readable here: 71
- Earlier 4,558-session observation: not reproducible here; excluded from final priority evidence
- Kernel Run: 391
- Attempt: 1,101
- Verification: 3,298
- Completion decision: 319
- Model usage receipt: 200
- Knowledge candidate: 2,381
- Knowledge record: 1,990

Run 상태는 completed 320, abandoned 32, blocked 28, active 11이다.

이번 판정은 과거 전체 빈도만으로 production 변경을 결정하지 않는다.
모든 후보는 현재 generation relevance를 별도로 확인한다.

---

# 2. P0 — 먼저 구현할 개선 후보

## C1. HistoricalWorkCase 정규화와 identity 연결

**판정:** CANDIDATE / P0 / 근거 강도 A

### 확인된 문제

Codex session, Kernel Run, Git source revision이 서로 다른 identity로 저장되어 있다.

동일 objective가 여러 Run으로 반복된 실제 사례가 있다.

- 동일 architecture simplification objective: 6 Run
- Moon Finance local-first objective: 4 Run
- Patch Relay lifecycle objective: 3 Run
- sync ownership safety objective: 3 Run
- project identity alias objective: 3 Run
- humanizer review objective: 2 Run

따라서 Run 행 수를 작업 수로 간주하면 같은 실제 작업을 중복 계산한다.

### 개선안

Host/offline tooling에 read-only `HistoricalWorkCase` view를 만든다.

가능한 identity 연결 순서:

1. explicit Kernel run/session binding
2. Codex session id / actor session lineage
3. workspace/worktree identity
4. source identity / commit SHA
5. successor key / parent lineage
6. objective digest는 보조 evidence로만 사용

fuzzy semantic matching을 authority로 사용하지 않는다.

### 금지

- 새 Kernel DB table
- runtime schema migration
- objective 문자열만으로 강제 merge
- 프로젝트별 path hardcoding

---

## C2. 최신 generation telemetry coverage 복구

**판정:** CANDIDATE / P0 / 근거 강도 A

### 확인된 문제

Kernel 상태는 2026-10-19까지 계속 갱신됐지만 model usage receipt는 2026-10-10에서 끊겼다.

2026-10-11 이후:

- 전체 Run: 34
- usage receipt가 있는 Run: 0
- moonshot-relay Run: 9
- usage receipt가 있는 moonshot-relay Run: 0

반면 같은 기간 Codex session JSONL에는 다음 값이 실제로 존재한다.

- session id
- cwd
- model
- effort
- input tokens
- cached input tokens
- cache write tokens
- output tokens
- duration

실제 2026-10-19 session 표본에서도 token usage가 기록돼 있다.

### 개선안

두 단계를 분리한다.

1. **Improvement Loop 분석 경로**
   - Codex JSONL telemetry를 HistoricalWorkCase에 read-only로 연결
   - Kernel receipt가 없으면 `coverage=missing_kernel_receipt`로 표시
   - 값을 0으로 보정하지 않음

2. **Production Host 원인 조사**
   - 10월 10일 이후 usage receipt 생성 경로가 왜 끊겼는지 확인
   - 실제 결함이면 기존 Host receipt 경계만 복구
   - 새 telemetry subsystem은 만들지 않음

### 중요

Codex log를 production authority fallback으로 쓰지 않는다.
offline evidence source로만 사용한다.

---

## C3. Project Knowledge canonical duplicate 억제

**판정:** CANDIDATE / P0 / 근거 강도 A

### 확인된 문제

moonshot-relay 프로젝트의 committed knowledge record는 179개다.

하지만 현재 canonical identity와 같은 기준인:

`record type + normalized statement + normalized scope`

로 묶으면 고유 항목은 33개뿐이다.

- committed record: 179
- canonical unique: 33
- canonical duplicate occurrence: 146

대표 중복:

- 같은 failure fingerprint: 30회
- `unsupported-verification`, empty scope: 27회
- 같은 failure fingerprint: 22회
- 다른 같은 failure fingerprint: 22회
- 같은 failure fingerprint: 18회
- 같은 failure fingerprint: 14회
- 같은 failure fingerprint: 11회

현재 `context-load.ts`는 committed/verified record를 읽고 stage/relevance/budget 필터링을 하지만 canonical duplicate collapse를 하지 않는다.

PROVE stage는 `known_failure_pattern`을 포함하므로 동일 record가 context budget을 반복 소비할 수 있다.

### 개선안

1차는 **비파괴 read-model 개선**으로 제한한다.

- Knowledge authority의 원본 row와 receipt는 보존
- context selection 직전에 canonical identity로 collapse
- 동일 canonical record의 provenance/evidence는 aggregate metadata로 보존
- prompt에는 대표 record 한 건만 제공

2차는 fresh Run으로 효과가 확인된 경우에만 검토한다.

- future commit 시 동일 canonical knowledge를 새 record로 계속 생성하지 않고 기존 semantic identity에 evidence lineage를 추가
- 기존 DB history는 삭제하지 않음

### 금지

- 기존 knowledge row 일괄 삭제
- 새 DB table
- 새로운 knowledge type
- 프로젝트별 dedupe rule

---

## C4. Generation-aware current relevance 판정

**판정:** CANDIDATE / P0 / 근거 강도 A

### 확인된 문제

과거 빈도와 현재 결함이 명확히 다르다.

대표 사례:

- 과거 20-run 표본의 Verification: 619
- 그중 615건은 2026-10-16 verification/reuse 정합화 이전
- 정합화 이후 comparable completed Run 4개는 각각 verification 1건

전체 이력만 보면 Verification을 다시 고쳐야 하지만 current generation에서는 residual 병목이 입증되지 않았다.

### 개선안

모든 improvement candidate에 다음 evidence를 붙인다.

- observed source revision
- affected revision range
- current source revision
- fixing/relevant seam revision
- current comparable evidence count
- relevance: `current | resolved | stale | insufficient`

generation은 날짜 하드코딩이 아니라 Git source ancestry와 변경 seam identity로 판단한다.

특정 commit SHA를 production heuristic으로 박지 않는다.

---

# 3. P1 — P0 이후 검증할 개선 후보

## C5. Knowledge failure-pattern 품질 gate

**판정:** CANDIDATE / P1 / 근거 강도 A-

moonshot-relay knowledge candidate 337개 중 280개가 `known_failure_pattern`이다.

전체 DB에서도 2,381 candidate 중 2,068개가 `known_failure_pattern`이다.

generic signal이 반복된다.

- `unsupported-verification`: candidate 61회
- `external-dependency`: 18회
- 동일 failure fingerprint 반복: 수십 회

### 개선안

새 taxonomy를 만들지 않는다.

기존 cross-run evidence와 improvement-pair 의미를 이용해 durable promotion 조건만 강화한다.

durable `known_failure_pattern`은 최소한:

- project-specific scope 또는 명확한 affected seam
- 독립 Run 반복 evidence
- current relevance
- resolution 또는 actionable mitigation evidence

를 요구한다.

단순 generic blocker는 episodic/audit evidence로는 보존하되 durable project knowledge로 반복 승격하지 않는다.

---

## C6. Stale/legacy Run의 corpus 격리

**판정:** CANDIDATE / P1 / 근거 강도 B+

현재 active Run은 11개다.

- 9개는 2026-10-01 이전
- 6개는 2026-09-01 이전

현재 runtime에는 이미 최신 Run 조회에서 비호환 이력을 격리하는 수정이 있다.
따라서 runtime authority를 다시 바꾸지 않는다.

### 개선안

Historical corpus에서 상태를 구분한다.

- current-active
- stale-active-history
- abandoned
- blocked
- completed-finalized
- legacy-completed-inconsistent

stale active를 자동 삭제하거나 자동 close하지 않는다.

필요하면 doctor/report 수준의 non-blocking finding만 검토한다.

---

## C7. Action hotspot semantic mining

**판정:** ANALYSIS CANDIDATE / P1 / production 변경 DEFER

2026년 10월 직접 moonshot-relay workspace Codex session 7개에서 exec call은 282회였다.

고비용 session:

- 106 calls
- 58 calls
- 45 calls
- 42 calls
- 16 calls
- 15 calls

그러나 exact command duplicate는 전체 282회 중 6회뿐이다.

즉 단순 `같은 명령 반복 차단`으로 해결할 문제는 아니다.

### 개선안

HistoricalWorkCase에서 action을 다음 수준으로만 정규화한다.

- search
- read
- modify
- focused verification
- full verification
- Kernel lifecycle
- Git read
- Git mutation
- environment/setup

그 뒤 성공/실패/replan과 상관관계를 본다.

새 command cache, action scheduler, 자동 명령 suppression은 아직 만들지 않는다.

---

## C8. Replan 원인 분류

**판정:** ANALYSIS CANDIDATE / P1 / production 변경 DEFER

2026-10-16 이후 전체 Run 30개:

- replan 총 15
- replan이 있는 Run 8
- intervention 0

moonshot-relay 최신 Run 5개:

- completed 4
- replan 총 3
- intervention 0

과거에는 replan 8~10회와 intervention 5~7회인 Run도 있었지만 현재 generation에서는 user intervention이 사라졌다.

### 개선안

replan 횟수를 줄이기 위한 새 workflow를 만들지 않는다.

먼저 replan을 원인별로 offline 분류한다.

- requirement correction
- environment failure
- verification failure
- workspace/source drift
- contract repair
- operator-requested scope change

동일 current-generation 원인이 반복될 때만 production candidate로 승격한다.

---

# 4. P2 — 구조 정리 후보

## C9. Improvement/Eval 자산 ownership 통합

**판정:** INVESTIGATE / P2

현재 다음 자산이 동시에 존재한다.

- `src/host-tooling/kernel-eval/model-prompt-replay.ts`
- `src/host-tooling/kernel-public/optimization-cycle.ts`
- follow-up/retrieval/routing/sentinel eval
- `scripts/kernel/optimization-cycle.mjs`
- `scripts/knowledge-improvement-lifecycle.mjs`
- AWTL replay probe/scorecard
- daily-retro 계열 자산

### 개선안

먼저 import graph와 실제 consumer를 조사한다.

각 자산을:

- production authority
- active Host/eval tooling
- compatibility projection
- historical/dead asset

으로 분류한다.

새 consolidated path가 dogfood로 검증된 뒤에만 dead/duplicate path를 제거한다.

---

## C10. Single-variable replay 일반화

**판정:** CANDIDATE / P2

Prompt replay에는 이미 single-variable, actual identity, ABBA, quality→rework→efficiency 계약이 있다.

### 개선안

새 evaluation engine을 만들지 않고 기존 replay contract를 다음 candidate seam에 재사용한다.

- context selection
- knowledge dedupe
- model/effort
- verification guidance
- prompt/guidance

candidate마다 허용된 차이 한 개만 선언한다.

---

# 5. 지금 production 변경을 하지 않을 항목

## R1. Verification scheduler/cache 추가

**판정:** RESOLVED / DEFER

역사적 최대 병목이지만 current-generation residual 병목이 입증되지 않았다.

새 scheduler, cache, state machine을 추가하지 않는다.

---

## R2. Prompt 추가 압축

**판정:** REJECT / KEEP BASELINE

최근 Prompt Diet 실험은 compact candidate가 baseline보다 품질이 낮고 scope violation도 발생해 keep-baseline으로 종료됐다.

새 evidence 없이 다시 압축하지 않는다.

---

## R3. Prompt cache 구조 추가 최적화

**판정:** DEFER

2026년 10월 Moonshot 관련 Codex session 39개의 실제 token record 합계:

- input: 18,115,154
- cached input: 17,112,832
- cached/input ratio: 약 94.5%

현재 evidence에서는 cache hit 자체가 우선 병목이 아니다.

---

## R4. Codex 모델 라우팅 재변경

**판정:** DEFER

최근 Kernel usage receipt coverage가 0이므로 current-generation 모델 효율 비교가 불가능하다.

먼저 C2 telemetry coverage를 복구한다.

---

## R5. Exact duplicate command suppression

**판정:** REJECT FOR NOW

직접 repo session의 exec 282회 중 exact duplicate는 6회뿐이다.

command dedupe layer를 추가할 근거가 약하다.

---

## R6. Legacy latest-Run ambiguity 재수정

**판정:** RESOLVED

현재 source에는 최신 Run 조회에서 비호환 이력을 격리하는 수정이 이미 반영되어 있다.

corpus에서는 stale history를 분리하되 runtime lookup authority는 다시 건드리지 않는다.

---

## R7. Codex model profile 중복 하드코딩

**판정:** RESOLVED

현재 기준선 이전 `be16c1e1`에서 Host model profile 중복 하드코딩 제거가 완료됐다.

---

# 6. 최종 우선순위

구현 순서는 다음이 가장 안전하다.

## Batch A — Evidence 신뢰성

1. C1 HistoricalWorkCase identity normalization
2. C2 latest telemetry stitching/coverage
3. C4 generation-aware relevance

이 세 개를 하나의 Host/offline corpus boundary로 구현한다.

## Batch B — Knowledge 품질

4. C3 context canonical collapse
5. C5 durable failure-pattern promotion gate

Kernel Knowledge Authority를 재설계하지 않고 현재 lifecycle 안에서 해결한다.

## Batch C — 실행 비용 분석

6. C7 action hotspot semantic mining
7. C8 replan cause mining

측정 결과가 threshold를 넘을 때만 production 후보를 만든다.

## Batch D — Candidate 검증

8. C10 single-variable replay reuse

quality → rework → efficiency 순서로 판정한다.

## Batch E — 구조 정리

9. C9 improvement/eval asset ownership cleanup

새 경로가 검증된 후에만 legacy/dead 자산을 삭제한다.

---

# 7. 복잡도 예산

이 개선 루프 전체에서 다음은 증가시키지 않는다.

- Kernel public command: +0
- Kernel workflow stage: +0
- Kernel durable table: +0
- model-visible concept: +0
- mandatory approval gate: +0
- provider fallback: +0
- project-specific production heuristic: +0
- 별도 evaluation service: +0

핵심 원칙:

> 먼저 실제 이력을 하나의 신뢰 가능한 corpus로 만든다. 그 다음 현재 generation에서 반복되는 문제만 candidate로 승격한다. 이미 해결된 문제와 측정이 부족한 문제는 production patch로 만들지 않는다.
