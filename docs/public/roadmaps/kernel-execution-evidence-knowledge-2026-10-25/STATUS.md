# 실행 상태

기준 브랜치: `main`

이 파일은 작업 인덱스다. Moonremote checkpoint나 Git remote parity를 대체하지 않는다.

| # | 프리셋 | 상태 | Commit | origin/main parity |
|---|---|---|---|---|
| 01 | A0 Characterization | COMPLETE | 66cabf23 | verified |
| 02 | A1 Identity + Evidence | COMPLETE | d08a887b | verified |
| 03 | A2+A3 Proof Delta + Failure Ownership | COMPLETE | 3c66d01d | verified |
| 04 | A4 Knowledge Quality | COMPLETE | current Preset 04 closeout | verify after push |
| 05 | A5 Knowledge Reuse | NOT_STARTED | - | - |
| 06 | A6+A7 Usage Receipt + Historical Replay | NOT_STARTED | - | - |
| 07 | B1+B2 Policy/Prompt Reduction | NOT_STARTED | - | - |
| 08 | B3 Control Plane / State Store Thinning | NOT_STARTED | - | - |
| 09 | B4 Final Replay + Complexity Audit | NOT_STARTED | - | - |

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
