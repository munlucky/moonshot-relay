# 실행 상태

기준 브랜치: `main`

이 파일은 작업 인덱스다. Moonremote checkpoint나 Git remote parity를 대체하지 않는다.

| # | 프리셋 | 상태 | Commit | origin/main parity |
|---|---|---|---|---|
| 01 | A0 Characterization | COMPLETE | 66cabf23 | verified |
| 02 | A1 Identity + Evidence | COMPLETE | d08a887b | verified |
| 03 | A2+A3 Proof Delta + Failure Ownership | COMPLETE | 3c66d01d | verified |
| 04 | A4 Knowledge Quality | COMPLETE | 78c05a9d | verified |
| 05 | A5 Knowledge Reuse | COMPLETE | 5b5cd618 | verified |
| 06 | A6+A7 Usage Receipt + Historical Replay | COMPLETE | fa7243c7 | verified |
| 07 | B1+B2 Policy/Prompt Reduction | COMPLETE | 94114497 | verified |
| 08 | B3 Control Plane / State Store Thinning | COMPLETE | current Preset 08 commit | verified |
| 09 | B4 Final Replay + Complexity Audit | COMPLETE | current Preset 09 commit | verified after push |

허용 상태:

`NOT_STARTED`, `IN_PROGRESS`, `BLOCKED`, `COMPLETE`, `VERIFIED_EXISTING`

## Preset 01 evidence

- Baseline: `A0_CHARACTERIZATION_BASELINE.md`
- Focused characterization: **108/108 pass**
- Production source changes: **0**
- New fixtures: **0**
- Kernel Run: `run-f69c4809-f56b-474b-8e96-81b7c14ae1d7`
- Default account-root runtime observation: `project_identity_git_common_dir_unverified`
- Characterization Run: isolated temporary runtime, no repository/runtime production state adoption

프리셋 종료 시 실제 결과만 기록한다.

## Preset 02 evidence

- Initial Kernel Run: run-ebe47a8a-8aa3-4fb9-881d-278e769bb0cd (textual cleanup 전 proof)
- Production source changes: **1 file** — src/kernel/persistence/trust-store.ts
- Focused identity/evidence regression: **29/29 pass**
- TypeScript typecheck: **pass**
- Runtime build freshness: **308 files / 829 edges, changed 0**
- Test build freshness: **289 tests / 8 helpers**
- Boundary check: **9 modules / 308 files / 829 edges**
- Initial Kernel proof: test:kernel-reliability **pass**. 이후 textual cleanup으로 workspace identity가 바뀌어 최종 freshness evidence로 사용하지 않는다.
- Final Kernel authoritative proof: isolated final Run `run-66ad1736-757c-48c7-b1fe-24ca6b1b42ae`에서 `test:kernel-reliability` 통과, Kernel completion `accepted / done`.
- Final evidence digest: `sha256:5b34dba0c66498df74cf09f53d4a3aa0140bd260ef737ddf3829207997218a44`.
- Evidence merge: 동일 Evidence Identity에서 kernel-runtime evidence가 weaker/unobserved caller attestation에 의해 덮이지 않으며, 동일 authority의 contradiction은 current evidence를 갱신한다.
- Source/workspace identity drift: 과거 verification history는 보존하고 Trust Authority freshness만 stale로 판정한다.
- Workspace/Runtime identity: 기존 linked-worktree authority와 runtime-home canonicalization을 재사용했다. 새 identity subsystem, alias registry, writable state, fallback chain은 추가하지 않았다.
- Knowledge observation commit: canonical knowledge type 불일치로 0건 commit. knowledgeRequired=false였고 Kernel completion은 accepted / done이었다. 이 프리셋에서는 knowledge schema를 확장하거나 fallback을 추가하지 않았다.

## Preset 03 evidence

- Kernel Run: `run-6e8c45dd-93b7-43db-9e43-73b6cea723f4`
- Production source changes: **3 files** — `src/kernel/control-plane.ts`, `src/kernel/persistence/trust-store.ts`, `src/kernel/state-store.ts`
- New regression: persisted failed proof + identical Evidence Identity는 **failed 상태를 유지하면서 executor 재호출 0회**
- Meaningful delta: source / fixture / verifier / relevant environment 변화는 Evidence Identity를 변경해 executor를 다시 호출
- Focused A2+A3 regression: **147/147 pass**
- TypeScript typecheck: **pass**
- Runtime build freshness: **308 files / 829 edges, changed 0**
- Test build freshness: **289 tests / 8 helpers**
- Boundary check: **9 modules / 308 files / 829 edges**
- Product/Verification ownership: compile/test failure는 기존 Work Unit evidence failure와 구현 수정 경로를 유지
- Kernel ownership: workspace/identity authority mismatch는 기존 binding/recovery authority에서 fail-closed
- Host ownership: launcher/tool/provider infrastructure failure는 기존 Host dispatch result/failureCategory에서 유지
- Knowledge guard: same-run retry와 반복 generic blocker는 durable `known_failure_pattern`으로 자동 승격되지 않음
- Complexity: 새 retry engine, failure registry, recovery stage, writable state, error-string correctness rule, provider/OS/project-specific production branch를 추가하지 않음
- Kernel authoritative proof는 위 Run의 최종 receipt를 authority로 사용한다.

## Preset 04 evidence

- Kernel Run: `run-ffb7177a-d929-41e5-b59c-1b650ce1d102`
- Production source changes: **3 files** — `src/kernel/knowledge-ingestion/candidate-extract.ts`, `src/kernel/knowledge/capture.ts`, `src/kernel/knowledge/cross-run-evidence.ts`
- Generic session failure: standalone session의 compile/test/temporary Host 실패 문장은 durable `known_failure_pattern`이 아니라 `episodic_observation`으로 유지
- Durable failure quality gate: cross-run promotion은 단일 reproducible failure fingerprint, identified cause, non-empty scope, current verified resolution/replay, existing promotion basis가 모두 있어야 함
- Repeat count: 기존 C23/C24 경계대로 같은 Run retry와 횟수 자체는 durable promotion 근거가 아님
- Semantic dedupe: 기존 canonical Knowledge identity에 procedure body와 required-verification command semantics를 실제 전달하고, durable failure는 provenance / resolution / fingerprint / cause / correction provenance 차이를 보존
- A1 identity boundary: `scope`와 `sourceRefs` 책임 분리는 유지하며, source freshness metadata를 applicability scope로 재해석하지 않음
- Existing authority: project boundary, persisted evidence binding, Improvement Pair approval/replay, commit/revision transaction을 그대로 재사용
- Focused Knowledge regression: **54/54 pass**
- TypeScript typecheck: **pass**
- Runtime build freshness: **308 files / 829 edges, changed 0**
- Test build freshness: **289 tests / 8 helpers**
- Boundary check: **9 modules / 308 files / 829 edges**
- Complexity: 새 Knowledge subsystem/table/lifecycle, failure registry, repeat threshold, provider/OS/project-specific production branch를 추가하지 않음
- Kernel authoritative proof는 위 Run의 최종 receipt를 authority로 사용한다.

## Preset 05 evidence

- Kernel Run: `run-09f0c88f-9b5d-4928-a4af-ceededc3d48c`
- Production source changes: **2 files** — `src/kernel/knowledge/context-load.ts`, `src/kernel/run/obligation-compiler.ts`
- Cross-run reuse: 기존 Run A → Run B SQLite Knowledge reuse/revision continuity/project namespace isolation E2E를 유지
- Semantic validity vs provenance freshness: `semantic_fact`와 `architecture_decision`은 단순 referenced path missing만으로 semantic invalidation 처리하지 않고 계속 selection 가능
- Source evolution: 같은 source path의 digest drift는 기존 `needs_deep_verify`로 selection에서 제외
- Semantic invalidation: superseded/rejected/archived status와 기존 canonical/scope/trust authority는 그대로 유지
- Trust-critical verification: source-bound `required_verification`은 source missing 또는 source digest drift 상태에서 executable obligation으로 컴파일하지 않음
- A1 boundary: applicability `scope`와 provenance `sourceRefs` 책임 분리를 유지
- Focused retrieval/freshness/reuse/obligation regression: **68/68 pass**
- TypeScript typecheck: **pass**
- Runtime build freshness: **308 files / 830 edges, changed 0**
- Test build freshness: **289 tests / 8 helpers**
- Boundary check: **9 modules / 308 files / 830 edges**
- Complexity: 새 freshness taxonomy, vector store, path alias registry/fallback, Knowledge table/lifecycle, provider/OS/project-specific production branch를 추가하지 않음
- Kernel authoritative proof는 위 Run의 최종 receipt를 authority로 사용한다.

## Preset 06 evidence

- Production source changes: **0**
- Usage lineage production status: **VERIFIED_EXISTING**
- Regression strengthened: representative Host dispatch에서 provider/model/input/cached input/output/wall time + route decision + attempt + usage receipt + run lineage를 한 번에 확인
- Attempt reverse linkage: persisted attempt의 `usageReceiptId`가 receipt ID와 일치
- A-stage representative integration gate: **121/121 pass**
- Fixed sentinel: **false completion 0 / missed accept 0**
- Historical replay contract: current supported candidate만 single-variable replay에 진입하고 quality → rework → efficiency 판정 순서 유지
- Failed Proof: 동일 Evidence Identity no-delta executor 재호출 0, meaningful delta에서만 재실행
- Knowledge quality: generic failure는 episodic, durable failure는 fingerprint/cause/scope/current verified resolution-replay 필요
- Knowledge reuse: Run A → Run B reuse/revision continuity/project isolation 유지
- B-stage entry: **PASS**
- 상세 결과: `A_STAGE_HISTORICAL_REPLAY_RESULT.md`
- Complexity: 새 telemetry table/exporter/provider-specific Kernel cost policy/workflow stage/fallback/failure registry를 추가하지 않음

## Preset 07 evidence

- Focused authority/prompt/profile/review regression: **187/187 pass**
- TypeScript typecheck: **pass**
- Runtime build freshness: **308 files / 831 edges, changed 0**
- Test build freshness: **289 tests / 8 helpers**
- Boundary check: **9 modules / 308 files / 831 edges**
- Duplicate authority 측정: targeted independent authority sites **6 → 0**
- Unstructured domain-policy branch proxy: **6 → 0**
- Kernel domain special-case regex: **9 → 0**
- Risk/model taxonomy: Host 위험 shape 분류는 `common-model-policy` 한 곳으로 수렴하고 Kernel core에는 provider-specific branch를 추가하지 않음
- Risk authority: free-text `risks`와 security keyword/path가 risk surface 또는 security review를 독립 생성하지 않으며, Task Contract의 structured surfaces/flags를 사용
- Protected obligation authority: obligation 이름 regex를 제거하고 `kernel/proof-policy.yaml`의 explicit `protected` metadata를 사용
- Migration policy: 실제 obligation ID `data-migration-smoke`와 proof policy를 정합화하고 protected hard evidence를 유지
- Always-visible source footprint: common prompt + Kernel skill + Codex profile **14,065 → 7,386 bytes (-47.5%)**
- Always-visible word-like 근사: **1,819 → 864 (-52.5%)**
- Common execution prompt: `kernel-common-execution.v3`; stable scope/autonomy/architecture/authority invariant만 유지
- Historical C01: current prompt와 동등성을 강제하지 않고 recorded `sourceHead`의 historical prompt/revision/digest를 검증해 frozen baseline을 보존
- Removed operational micro-guidance: 고정 search/file-read 순서, wait/poll 시간, two-turn plan reading, fixed context budget, Codex profile의 중복 workflow authority
- Dynamic contract: Objective / Acceptance / Constraints / Current Work / Relevant Knowledge / Required Evidence 구조는 유지
- Completion/protected safety: migration T3, protected waiver refusal, independent review receipt, stale review/evidence, completion authority 회귀 통과
- Complexity: 새 Risk DSL/classifier/taxonomy, fallback chain, registry/table/state, provider/OS/project-specific Kernel branch를 추가하지 않음


## Preset 08 evidence

- Base / Preset 07 parity: `HEAD = origin/main = 9411449785130505c28ed54b64369c680299996d`에서 시작했다.
- Authority 이동: route escalation은 `proof-route`, blocker classification은 `run/work-authority`, completion/evidence/review gate는 `proof/trust-authority`, protected waiver는 `proof/protected-obligations`, Review Receipt subject adoption은 `proof/review-receipt`가 소유한다.
- State Store targeted policy ownership: route tier **9 → 0**, blocker class **1 → 0**, completion gate **5 → 0**, protected waiver **5 → 0**, review adoption **4 → 0**.
- State Store 전체 branch proxy: **493 → 438**, semantic branch proxy: **27 → 16**, LOC: **4,612 → 4,243 (-369)**.
- Control Plane 전체 branch proxy: **533 → 536**, semantic branch proxy: **20 → 21**, LOC: **5,074 → 5,109 (+35)**. 증가는 owner snapshot 조립과 lifecycle guard이며, completion/domain policy owner는 제거했다. LOC 자체는 성공 조건으로 사용하지 않았다.
- Writable authority: State Store의 canonical authority table direct SQL write는 **0 → 0**이다. 기존 same-connection owner persistence를 유지했고 새 table/state/registry를 추가하지 않았다.
- Focused authority/state/review/boundary regression: **80/80 pass**.
- TypeScript typecheck: **pass**.
- Runtime build freshness: **308 files / 840 edges**, 최종 `build:check` changed **0**.
- Test build freshness: **289 tests / 8 helpers**, 최종 check pass.
- Boundary check: **9 modules / 308 files / 840 edges**, pass.
- Kernel reliability: **282/282 pass**.
- State Store에 남긴 판단은 schema/command binding, referential integrity, transition/OCC, transaction 경계다. route/completion/domain policy를 persistence에 다시 복제하지 않았다.
- Complexity: 새 facade/compatibility layer/fallback chain/provider·OS·프로젝트 전용 분기 없이 기존 Work/Trust owner를 재사용했다.

## Preset 09 evidence

- Base / Preset 08 HEAD: `d4998b2fe1bc1a9212678eead720834f11e6833a`.
- Production `src/`, `scripts/`, `bin/` changes: **0**.
- Initial `test:active:2`: **1,067 tests / 1,056 pass / 6 fail / 5 skip**. 실패 6건을 stale test contract 5건과 일시적 `ENOMEM` 1건으로 분리했다.
- Completion regression: 제거된 `StateStore.evaluateCompletion()`에 남아 있던 test caller **3 → 0**. State Store compatibility shim은 복구하지 않고 canonical Trust Authority를 직접 검증한다.
- Prompt regression: Preset 07 이전 장문 문구를 요구하던 stale assertions를 현재 semantic authority 기준으로 갱신했다. 삭제된 operational micro-guidance는 복원하지 않았다.
- Duplicate authority cleanup: `package/kernel/profiles/codex/skills/moon-relay-kernel/SKILL.md` shadow copy **1 → 0**. Installer는 canonical `skills/moon-relay-kernel`을 provider home에 투영하고 canonical source가 없으면 fail-closed한다.
- Capability asset 정합화: coverage surface **789 → 788**, capability-classified **764 → 763**, ignored **25 유지**. `test:capability-assets` **1/1 pass**.
- Environment classification: install-isolation `ENOMEM`은 단독 **1/1 pass** 및 최종 전체 재실행에서도 통과했다. retry/fallback이나 환경별 production branch는 추가하지 않았다.
- Final `test:active:2`: **1,067 tests / 1,062 pass / 0 fail / 5 skip**.
- Additional regression: `active:3` **41/41**, profile ownership **17/17**, explicit invocation **3/3**, commit message **7/7**, decomplexification **17/17**, reliability **282/282**, git closeout **61/61**.
- Source/runtime: `test:source-runtime` **20/20 pass**.
- TypeScript typecheck: **pass**.
- Runtime build freshness: **308 files / 840 edges / changed 0**.
- Test build freshness: **289 tests / 8 helpers**.
- Boundary check: **9 modules / 308 files / 840 edges**.
- Negative Complexity Budget: 신규 compatibility shim/fallback/retry engine/public command/workflow stage/Authority/durable table/provider·OS·project-specific Kernel branch **0**.
- Surface budget: immutable baseline을 유지하고 최종 canonical actual을 limit로 사용하는 zero-headroom maintenance로 마감한다. unregistered tests **0**.
- Final Kernel proof는 모든 repository mutation 이후 실행하고 receipt는 Kernel authority에 보존한다. Source 문서에 receipt ID를 되써서 proof freshness를 깨지 않는다.
- Detailed result: `09_B4_FINAL_REPLAY_AUDIT.md`.
