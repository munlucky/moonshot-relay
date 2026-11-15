# Decomplexification Transition Maps v2 (Subcapability-Based)

이 문서는 Phase A (Capability Assetization) Baseline v2를 기준으로 Phase B (Kernel Decomplexification)를 실행하기 위한 **Subcapability 단위 5대 인계 맵**을 정의한다.

기존 15개 Capability Family의 거친 분류를 넘어, 각 Family 내부의 47개 세부 Subcapability별 disposition을 기준으로 분할 및 단순화를 수행한다.

---

## 2026-11-14 runtime assetization execution (R0–R1)

Execution baseline: `7a5f5bd815d33a047ccdcf0550da7432a76508ee`, clean `main`.
The isolated branch is `codex/kernel-runtime-assetization`; its worktree is
`C:/dev/moonshot-relay-assetization`. Kernel Run
`run-8a63100e-fe74-457c-a6ea-0a404b605b51` owns this work. The separate
Moonremote Host Worker task `6ceb861a-b1cd-4dd0-9a58-f1663c3f76cc`, revision
85, was observed read-only and is not repurposed or modified.

The execution plan is the user's final v1.1 plan dated 2026-11-14. The existing
review also requires baseline-to-candidate Run/Knowledge resume when installation
payload or persistent references change, and additive Native coverage when new
impact is found. Existing required combinations must not be removed for convenience.

### R0 protected baseline and Native gate

The minimum required Native combination is Windows × the actual Codex Desktop
session `01a1d6f2-bbda-74f1-954e-e66c72fed662` × installed Kernel CLI. This is
not a Codex CLI launcher test. The actual session must consume the installed
work unit, mutate its bounded sample project, and submit report and proof until
the installed Kernel returns `done`. Session binding, installation paths and
hashes must agree with the raw receipts. Native smoke is insufficient.

Linux/macOS and other Provider launchers are initially OUT_OF_SCOPE because no
change to their execution or profile contract is proposed. MCP is initially
OUT_OF_SCOPE because the planned correction concerns asset traceability, not
bridge dispatch. R1 findings can add mandatory combinations. Host/Worker
transport changes would require their real execution path; the Desktop scenario
cannot substitute for that path. The designated review chat confirmed this N1
method on 2026-11-14, subject to the actual evidence. It did not grant PASS.

Raw evidence stays outside source, under
`%LOCALAPPDATA%/moonshot-relay/assetization-20261114/` on the validation Host.
The initial snapshot covers 586 account-owned profile/config/skill files; its
aggregate ownership SHA-256 is
`4db6b31cb5df14b8621f11495635878b1a3b2cc672c8881040db49ae941bfaea`.
No real account profile, PATH or runtime DB is an installation target.

The three frozen files have these SHA-256 values:

- `CAPABILITY_ASSET_BASELINE.md`: `f0f1172441d79d890111cb800cfbd3b8a4c72cac1e01b4d8f418b83ea61ffdd3`.
- `catalog.yaml`: `e2b56b8ca30790b0fb6fb51f19ca4e89303392be413251e969752b2374fdb312`.
- `coverage-ledger.yaml`: `3b8336b6701ed677eb02d72e90be24c3e93cc0d9dc4c4b6ab3df14a0b51937dc`.

Clean checkout `npm ci --ignore-scripts`, `build`, `build:check`, `typecheck`,
and Kernel package materialization succeeded. Test artifacts were absent in
the clean checkout: `build:tests:check` and characterization initially failed
for missing generated `dist/tests` files. After `build:tests`, characterization
passed 17/17. This is a build prerequisite, not a source regression.
`test:capability-assets` exposed 30 unclassified typed source/output paths and
17 unclassified test entrypoints added after the frozen baseline. The owning
boundary is the existing migration catalog's `surfaces` mapping, not the frozen
ledger or the runtime implementation. It must be repaired before acceptance.

### R1 consumer and ownership findings

The historical 15 families / 47 subcapabilities and their classification remain
unchanged. The five maps below remain their classification authority. Current
file reachability is checked against source-layout, the compiler manifest,
package manifests, profile installer, CLI/MCP dispatch, npm scripts, CI and the
existing B0 characterization. There is no new asset registry.

R2: NO_CHANGE_REQUIRED. `capability-resolver.ts` selects the existing conditions
and rejects unknown requests. A normal implementation selects minimal-change
and verification guidance only. All seven Optional capabilities are inactive.
`project-hydrate.ts` and `profile-install.ts` expose one Kernel entrypoint.
`internalDiscovery.includeUnlistedSourceSkills` has no executable consumer in
`src`, `tools`, `package` or CI; its presence does not reproduce expanded loading.
Retain the metadata and existing explicit/conditional access. The public npm
product still needs Relay skills and the Standalone catalog. No shared skill,
agent or rule is removed by name or file count.

R3: CHANGED. B0 verifies that Optional implementations stay outside
the default static graph and activate only on existing conditions. Work, Trust
and Knowledge remain derived from their existing authorities. The retired
phase-runner/adapters have no live source reference. Explicit review requests
and protected review receipts remain intact. Host Worker/Reader/Writer source
is preserved. Later full reliability verification reproduced an existing W-03
ownership violation: accepted-completion cancellation updated `run_steps` directly
in the state-store facade. That unchanged SQL now belongs to the existing Work
step store. The facade calls it inside the same transaction and on the same DB
connection, preserving its predicates and timestamp calls. No owner allowlist,
model policy or state schema changes. Optional execution remains unchanged.

R4: CHANGED. `tools/build/bootstrap.mjs --tests` compiles canonical
TypeScript into `dist/tests`; tracked `.mjs` files forward execution to these
outputs. npm scripts and CI depend on that relationship. They are not redundant
copies to delete. B0 still connects the original safety counterexamples. No
independent duplicate test with a replacement proof was established. Two legacy
migration fixtures created a current-schema DB and injected old columns or
lifecycle states without resetting `user_version`. They now declare version 0
before reopening. Runtime migration and current-schema fast-path behavior and
all existing assertions remain unchanged.

R5 candidate: restore current traceability for compiler-owned Host/I/O pairs
and their tests using `catalog/kernel-capability-surface-migrations.json`.
The existing checker explicitly accepts its current `surfaces` field. This is
not a migration from an invented historical path. Existing `migrations`, the
baseline commit, frozen files and checker contract must remain unchanged.
Classify each actual source/output/test against the existing family and record
its consumers before adding it. Revert only those new mapping entries to undo
the correction. Runtime behavior and package inclusion settings do not change.
The shared npm tarball includes the updated catalog JSON because its existing
`files` list includes `catalog/`. Kernel materialization is checked separately.

### R5 current surface correction

CHANGED: 47 entries were added only to the existing `surfaces` mapping: 15
compiler-owned source/output pairs and 17 test entrypoints. No historical
migration entry or frozen classification changed. `test:capability-assets`
changed from FAIL (47 missing classifications) to PASS (1/1, about 22 seconds).

`provider-session-and-execution-boundary` owns `moonshot-io` and
`moonshot-io-hook` source/bin pairs, plus Host `codex-app-server-transport`,
`host-owned-writable-attempt`, `host-worker-sessions`, the six `io-*` modules,
and `local-worker-control`. Their actual consumers are the opt-in standalone
I/O CLI/hook, local worker control, adapters and MCP/worker dispatch. The
corresponding transport, continuation, local-control, disconnect and parallel
admission tests remain on their existing npm paths. These are HOST execution
assets; adding traceability does not enable them in an ordinary Run. Relay's
public I/O CLI, Kernel Host execution and Standalone I/O consumers are retained.

`mutation-fencing-and-git-closeout` owns Host `proof/write-containment`,
`workspace-writer-reservation`, and `workspace/canonical-worker-receipts` pairs,
and eight native/parallel/proof/recovery/reservation tests. Their consumers are
trusted proof, worker admission, physical worktrees and canonical settlement.
Kernel and Standalone retain those safety boundaries; Relay's shared package
continues to distribute them. They are not removed or marked ignored because
they run conditionally or because some real Native scenarios need another OS.

`control-plane-state-authority` owns the two schema-open/SQLite-recovery test
entrypoints. They preserve normal-open, migration, crash and lock recovery
counterexamples for the existing durable authority used by Kernel/Standalone.
Relay's shared test/package contract remains intact. All 17 entrypoints still
forward to their canonical TypeScript test outputs; no test was replaced.

For every added path the action is retain and classify the current surface.
The alternative is the unchanged direct caller/compiler output, not a new
dispatch layer. Undo consists of removing these 47 additions; do not modify
the frozen ledger. Kernel and npm manifests, profile payloads and all three
CLI entrypoint sources are byte-identical to baseline. R6 found a Standalone
resource-lifetime defect, so its existing content lock is regenerated using
`writeStandaloneLock`; only the utility content hash and generation provenance
change. Membership, catalog digest and permissions remain identical. R6 also found an audit
boundary defect, so the candidate audit payload differs and requires an actual
baseline-started Run and Knowledge upgrade/resume check. No Provider execution,
MCP dispatch or profile discovery contract changes; N1 remains mandatory.

Initial same-boundary metrics: Kernel source 135 files / 52,725 physical code
lines; Host source 80 files / 23,689 lines; test tree 940 files; installed Kernel
payload 1,144 files / 33,122,688 bytes (including runtime dependencies); one public
Kernel skill, two ordinary guidance items, zero active Optional capabilities.
Unchanged boundaries need final evidence, not forced LOC reduction. Installing a
profile proves file content and ownership; it does not prove a new Provider
session automatically discovered that profile. No profile-loading change is
currently proposed.

### R6 audit boundary and regression repairs

Additive required Native combination N2 (frozen before the following source
repair): Windows × installed Standalone `project-memory` CLI. An actual isolated
status command reproduced `ERR_INVALID_STATE`: the utility returned an async
operation from `try` while `finally` closed its DB before that operation resumed.
This is a resource-lifetime defect in the existing utility, not a new state or
authority. Await the existing operations before closing their store. Status,
codebase snapshot, review and import handoff must retain their current authority
and explicit approval rules. N2 adds coverage; it does not replace N1.

The Kernel runtime audit scanned the shared npm `bin/` directory and rejected
Relay-only `moonshot-io.mjs` for its legitimate Relay home reference. The Kernel
manifest excludes that CLI. Audit roots now use that existing manifest's bin
membership and its declared entrypoint. All pre-existing Kernel directories and
execution seeds remain scanned, together with their reachable local imports.
The existing package include resolver is exported and reused; its implementation
and package inclusion semantics are unchanged. There is no filename exception
or replacement registry. Relay and Standalone entrypoints remain distributed.

Invalid manifests, missing/empty bin membership, an unselected/missing entrypoint,
unresolved imports and paths outside the package fail closed. Prefix matches
and directory children receive realpath containment checks. Internal links are
traversed with physical-directory cycle detection. Import resolution and visited
identity use the actual file path, so a linked helper cannot redirect a relative
import to a different logical sibling. The designated review chat reproduced
these counterexamples before their fixes; the regression suite retains them.
Undo requires reverting the audit source and resolver export and rebuilding;
do not change the product manifests or frozen assets.

The existing public guideline classification now lists `host-owned-io-writer.md`
at its actual Host I/O consumers. Two published W8 records replace a personal
absolute checkout path with a neutral placeholder, retaining their historical
HEAD, dates and observations. These repairs retain the existing document checks.

Full reliability verification also found a CLI operator-approval fixture without
an owner binding. It now creates the Run through legitimate Host `ensureRun`
with an explicit test session before checking rejection of a missing approval reference and authorized
approval/finalization. Runtime owner checks and approval gates are unchanged.
The original failure and W-03 violation reproduced in a fresh HEAD archive with
fresh runtime and test builds. The existing W5 finalization counterexamples
check untouched-step cancellation and preservation of attempted work.

### R6 installed Native evidence

N1 used the actual Desktop session declared in R0 and the installed
`native-install/bin/kernel.ps1`, not the source CLI. The original installed Run
`run-b8490553-50c5-415c-beb7-adad4940150d` implemented bounded tag normalization.
An intentionally incomplete implementation failed real proof at mutation
revision 1. A new CLI process resumed the same Run/Step, corrected the source,
and obtained fresh trusted proof and `done` at revision 2. Read-only DB inspection
confirmed the actual `codex:` session binding and its release at completion.
Raw receipts are `native-failed.json`, `native-resumed.json`, `native-done.json`
and `native-binding-readonly.json`.

Baseline Run `run-e862d00f-b2c4-469f-b506-a71b65b610c8` committed one fact after
real behavior proof (`native-baseline-knowledge-accepted.json`, revision 4).
Baseline-started Run `run-1a769dd3-5f81-40b4-8be7-ffddde8bec56` selected that fact.
After candidate installation, it resumed the same `step-1-1`, selected one fact
with `use.available` and no degraded context, and returned fresh proof and
`done` (`native-upgrade-after.json`, `native-upgrade-done.json`). Earlier stale
Knowledge attempts remain in the evidence directory; they were not edited or
counted as accepted facts. Knowledge freshness currently requires invoking the
CLI from the sample project directory even when `--project-root` is supplied.
This pre-existing different-working-directory limitation is not changed here.

The isolated profile doctor verified 28 managed files and executable command
resolution. This proves installation and ownership, not new-session automatic
profile discovery. Fixture safety tests prove protected review receipt rejection,
mutation fencing, project isolation, supersession and rollback. Their simulated
Host transport does not establish a new real Provider review session. The
designated review chat supplies independent code feedback, not a protected
Kernel review receipt. No such receipt is fabricated.

### R6 repository gate before authorized budget review

The complete npm command stopped at active1. Before document repair it passed
source-runtime 20/20 and active1 had 621 pass, 3 fail, 1 environment skip.
All three failures reproduced on unchanged main `7a5f5bd8`. The two document
failures were repaired; the focused contract now has 22 pass and 1 environment
skip. Active2 was run separately: 1,089 pass, 1 legacy-fixture failure and 1 skip;
that fixture is corrected above. Active3 passed 41/41. Later verification logs
must confirm the final source state; these counts do not assert a green npm test.

Before the authorized policy review, the unchanged surface-budget policy was FAIL on baseline and candidate.
Baseline actual/limit: files 2,402/2,252; nonblank lines 368,320/347,416;
UTF-8 bytes 17,200,195/15,360,918; estimated tokens 4,300,049/3,840,230.
Both inventories have zero unregistered tests. Candidate deltas must be measured
after final source freeze with normalized line endings as well as the actual
worktree measurement. At that checkpoint no budget limit, exclusion, checker or assertion was changed. The later user-authorized review accepts a one-time allowance increase; exclusions, checker and assertions remain unchanged.
AC09 requires fresh full proof after the reviewed policy correction. Overall completion also requires the other unresolved acceptance conditions.
Do not label pre-existing failures as passing or let narrower proofs replace it.

### R6 final candidate evidence and measured status

The final candidate was installed after baseline-started Run
`run-95f51fbf-1e7c-44af-a6c9-7bc4937b438c` selected the accepted fact.
The installed CLI resumed the same Run and Step, retained one selected fact,
and returned fresh trusted proof and `done` (`native-v5-resumed.json`,
`native-v5-report.json`, `native-v5-done.json`). The final installed audit passed.

N2 exercised the final installed Standalone CLI: status, codebase analysis,
review, rejection without explicit approval, and approved candidate handoff.
Knowledge revision remained 4. The utility returned candidate authority only;
it did not commit Kernel Knowledge (`native-n2-summary.json`).

Protected Run `run-b0602556-b944-4584-abb0-6453589bffb9` selected no fact from
the other project. Its actual hard proof passed. Kernel issued a read-only
review capsule, but the available Host lacked an independent review transport:
`no-independent-review-capability`, no review receipt. The designated code
review chat cannot replace that receipt. AC05 remains blocked.

| Equivalent boundary | Baseline | Final candidate |
| --- | ---: | ---: |
| Shared skill files / bytes | 253 / 856,117 | unchanged |
| Shared agent files / bytes | 33 / 176,602 | unchanged |
| Shared rule files / bytes | 18 / 15,080 | unchanged |
| Tool files / physical code lines | 58 / 12,407 | unchanged |
| Kernel source files / physical code lines | 135 / 52,725 | 135 / 52,729 |
| Host source files / physical code lines | 80 / 23,689 | unchanged |
| Test files / physical code lines | 940 / 88,488 | 940 / 88,626 |
| Materialized Kernel files / bytes, including dependencies | 1,144 / 33,122,688 | 1,144 / 33,126,191 |
| Clean public npm files / unpacked bytes | 1,481 / 9,329,552 | 1,481 / final bytes in `final-metrics.json` |
| Public Kernel skill / managed profile files | 1 / 28 | unchanged |
| Ordinary guidance items / characters | 2 / 101 | unchanged |
| Active Optional capabilities | 0 of 7 | unchanged |

The ordinary guidance estimate is about 26 tokens at four characters per token;
it is not a tokenizer measurement or a cost claim. The added import edge reuses
the existing include resolver. There is no new dependency declaration, state
schema, workflow stage, public CLI entrypoint or asset membership. The increase
comes from boundary validation and retained regression cases, not forced deletion.
The npm baseline uses a fresh HEAD archive and normal prepack. An earlier local
pack contained an ignored Python cache and is not an equivalent comparison.
`final-metrics.json` records normalized source deltas after document freeze.

The isolated profile install, doctor and uninstall preserved user-owned skill
content and appended notes. The original account snapshot later differed in four
files: config, the system skill marker, and two OpenAI-docs skill files. Their
writer is not established. No further differences occurred during the measured
final operation window. One early utility probe accidentally created a default
account track registration for this worktree. Its exact scope, source and creation
time were verified; only that newly created registration was backed up and removed.
This incident and the four unexplained differences limit AC08; account-wide byte
parity is not claimed. No user profile file was restored or overwritten.

Original main remains clean. The unrelated Moonremote task was initially observed
at revision 85 and was never used for execution. A final read failed in the MCP
connection; its current remote state is unverified. The later user instruction excludes that remote check; local preservation evidence remains applicable.

The following checkpoint is recorded before fresh proof of the reviewed policy update. The latest Kernel proof receipt owns subsequent verification status.

| Acceptance | Status | Evidence or remaining condition |
| --- | --- | --- |
| AC01 | PASS | Actual installed execution, report, proof and done |
| AC02 | PASS | Failed revision 1 and fresh corrected revision 2 |
| AC03 | PASS | Process resume and final candidate upgrade |
| AC04 | PASS for tested paths | Existing safety counterexamples; hardlink tests require process-local LF setting and do not prove OS sandbox isolation |
| AC05 | BLOCKED | Actual independent protected review transport and receipt absent |
| AC06 | PASS | Accepted cross-Run Knowledge, other-project isolation and retained supersession cases |
| AC07 | PASS | One public skill and unchanged conditional access |
| AC08 | PARTIAL | Isolated preservation passed; account snapshot limitations above |
| AC09 | NOT_RUN for revised policy | The prior policy failed; the reviewed allowance correction requires fresh complete npm proof |
| AC10 | PASS | Frozen hashes and reversible current mappings |
| AC11 | PASS | Equivalent measurements; no added framework or registry |
| AC12 | PASS for local scope | Original checkout clean and unrelated local work retained; MCP/remote comparison is OUT_OF_SCOPE by user instruction |

Overall status is PARTIAL. Successful focused checks and Native sample completion
do not establish completion of this refactor Run. No push or merge was performed.

---

### Authorized budget policy review and MCP scope update

The user included budget policy review in this task on 2026-11-15 and excluded
MCP/Moonremote verification. The designated review chat accepted the bounded policy correction and requested the status distinctions recorded here. The local installed CLI matrix remains required;
protected CLI review receipts are not waived. Remote checkpoint comparison is
OUT_OF_SCOPE under that instruction, with no remote mutation performed.

Policy commit `34ef0871feab770824a2e94ab6caea2e97bc20c9` predates 150 canonical
additions already present at execution baseline `7a5f5bd8`: 109 documents,
6 opt-in account profile assets, 15 Host/CLI modules and 20 test/helper files.
Seventy other canonical paths changed. Existing compiler outputs are excluded
using the unchanged checker. The new source and test paths are traced by the
existing capability migration map; the profile and documentation consumers are
the existing account installer and public history/guidelines. They remain shared
product assets. No deletion is justified by their count alone.

The proposed one-time allowance retains the immutable `aca19ec` baseline and
all checker assertions. Its limits equal the reviewed final candidate, including
this policy and decision text, with zero measured headroom and zero unregistered
tests. There is no automatic future ratchet, new exclusion or runtime activation.
The existing byte metric reads worktree bytes and can vary with line endings;
this review does not change that metric or claim portable byte equivalence.
Normalized LF measurements remain separate evidence. Independent policy review is accepted. A fresh complete npm test is still required before this correction can pass verification.

## 1. CORE MAP (21 Subcapabilities)

현재 Kernel의 본질 경로인 **AI Agent Workflow**와 **Project Knowledge Lifecycle**을 성립시키는 최소 권위 집합이다. Decomplexification 시 반드시 Kernel 내부에 유지되어야 한다.

| Subcapability ID | Parent Family | Role | Product Relevance |
| :--- | :--- | :--- | :--- |
| `task-contract-binding` | task-contract-and-bounded-work | 사용자 목적, 인수조건, 비목표를 불변 계약으로 바인딩 | Workflow: O, Knowledge: X |
| `work-unit-scope` | task-contract-and-bounded-work | 허용/금지 경로 및 제한된 work-unit admission 경계 소유 | Workflow: O, Knowledge: X |
| `run-step-ledger` | step-ledger-resume | 단계별 순차 실행 상태 및 영속 원장 권위 유지 | Workflow: O, Knowledge: O |
| `work-cursor-resume` | step-ledger-resume | 실행 커서 및 안전한 세션 재개 단일 권위 | Workflow: O, Knowledge: O |
| `evidence-binding` | evidence-completion-and-review-authority | 실증 증거 수집 및 인수조건 의무 바인딩 | Workflow: O, Knowledge: X |
| `verification-authority` | evidence-completion-and-review-authority | 검증 실행 결과 평가 및 통과 여부 단일 권위 | Workflow: O, Knowledge: X |
| `completion-decision` | evidence-completion-and-review-authority | 최종 완료 판정 및 릴리즈 승인 게이트 | Workflow: O, Knowledge: O |
| `protected-obligation` | evidence-completion-and-review-authority | 고위험 변경에 대한 필수 검증 의무 강제 | Workflow: O, Knowledge: X |
| `mutation-scope-safety` | mutation-fencing-and-git-closeout | 선언된 경로 외의 임의 파일 변조 차단 | Workflow: O, Knowledge: X |
| `workspace-fencing` | mutation-fencing-and-git-closeout | 작업 공간 분리 및 외부 파일 유출 차단 | Workflow: O, Knowledge: X |
| `project-identity-binding` | project-identity-and-knowledge-lifecycle | 프로젝트 고유 식별자 확정 및 네임스페이스 격리 | Workflow: O, Knowledge: O |
| `knowledge-lifecycle-authority` | project-identity-and-knowledge-lifecycle | 지식 레코드 개정, 대체, 저장 권위 | Workflow: O, Knowledge: O |
| `knowledge-ingestion-normalization` | knowledge-ingestion-and-evidence-graph | 지식 수집, 정규화, 중복 제거 및 충돌 검사 | Workflow: O, Knowledge: O |
| `ontology-gate-promotion` | knowledge-ingestion-and-evidence-graph | 온톨로지 제약 평가 및 프로젝트 지식 승격 | Workflow: O, Knowledge: O |
| `state-transition-authority` | control-plane-state-authority | 런타임 라이프사이클 상태 전이 단일 권위 | Workflow: O, Knowledge: O |
| `minimal-durable-state` | control-plane-state-authority | SQLite 어댑터 기반 실행 상태 영속화 및 투영 | Workflow: O, Knowledge: O |
| `required-capability-contract` | model-routing-and-route-admission | 작업별 필수 역량 조건 선언 및 검증 계약 | Workflow: O, Knowledge: X |
| `route-admission` | model-routing-and-route-admission | 실행 전 라우트 안전성 승인 및 드리프트 방지 | Workflow: O, Knowledge: X |
| `context-build` | context-prompt-cache-and-optimization | 제한된 문맥 빌드 및 민감 정보 마스킹 | Workflow: O, Knowledge: O |
| `knowledge-context-selection` | context-prompt-cache-and-optimization | 프로젝트 지식 선별 및 주입 | Workflow: O, Knowledge: O |
| `context-receipt-freshness` | context-prompt-cache-and-optimization | 문맥 바이트 영수증 및 신선도 검증 | Workflow: O, Knowledge: O |

---

## 2. HOST MAP (13 Subcapabilities)

Kernel authority의 본질은 아니지만 실행 환경 및 제공자(Provider) 적응을 위해 필요한 기능이다. Host Layer, CLI 어댑터, 또는 Provider Bridge로 분리 이관할 대상이다.

| Subcapability ID | Parent Family | Recommended Host Layer | 이관 사유 및 가드레일 |
| :--- | :--- | :--- | :--- |
| `review-transport` | evidence-completion-and-review-authority | Provider Bridge / Review Adapter | 외부 리뷰어 세션 통신은 Host 전송 책임 |
| `git-staging-safety` | mutation-fencing-and-git-closeout | Host Git Closeout Adapter | Git 스테이징 정책 필터링은 배포 환경 책임 |
| `git-commit` | mutation-fencing-and-git-closeout | Host Git Closeout Adapter | Git 커밋 생성은 로컬 형상관리 도구 책임 |
| `host-session-binding` | provider-session-and-execution-boundary | Host Session Manager | Provider 세션 연결 및 인증 관리는 Host 소유 |
| `execution-capsule-transport` | provider-session-and-execution-boundary | Provider Runtime Bridge | 외부 프로세스/컨테이너 실행 및 입출력 전송 |
| `step-worktree-isolation` | provider-session-and-execution-boundary | Host Worktree Manager | 워크트리 생성/정리는 파일시스템 어댑터 책임 |
| `model-selection` | model-routing-and-route-admission | Host Model Policy | 논리 모델 클래스 매핑은 Host의 재량 |
| `provider-selection` | model-routing-and-route-admission | Host Dispatcher | Provider 계정/키 및 런처 호출은 Host 소유 |
| `effort-cost-routing` | model-routing-and-route-admission | Host Cost Policy | 추론 노력(Effort) 및 비용 조율은 Host 소유 |
| `prompt-envelope` | context-prompt-cache-and-optimization | Provider Prompt Adapter | Provider별 시스템 프롬프트 와이어 포맷 맞춤 |
| `prompt-cache` | context-prompt-cache-and-optimization | Provider Cache Client | 캐시 브레이크포인트 생성 및 Provider 캐시 활용 |
| `package-materialization` | account-root-package-and-profile-adoption | Package / Installer Tool | 릴리즈 패키지 빌드 및 매니페스트 번들링 |
| `account-profile-projection` | account-root-package-and-profile-adoption | Profile Installer | 계정 루트 프로필 파일 복사 및 설치 |

---

## 3. OPTIONAL MAP (9 Subcapabilities)

기본 실행 경로에서는 제외되며, 명시적인 사용자 요청이나 고위험 작업 조건에서만 선택적으로 활성화하는 자산이다.

| Subcapability ID | Parent Family | Trigger Condition | 주의사항 |
| :--- | :--- | :--- | :--- |
| `independent-reviewer-execution` | evidence-completion-and-review-authority | 고위험 변경(보안, 마이그레이션, 비가역 변경) | 일상적 버그픽스/구현에는 실행 차단 |
| `remote-parity` | mutation-fencing-and-git-closeout | 명시적 푸시 및 릴리즈 closeout 요청 | 원격 네트워크 실패 시 로컬 커밋 차단 방지 |
| `stagnation-escalation` | model-routing-and-route-admission | 다중 턴 진행 정체(Stagnation) 감지 | 모델 비용 급증 방지 가드레일 필요 |
| `optimization-cycle` | context-prompt-cache-and-optimization | 명시적 토큰 절감 지표 측정 요청 | 런타임 레이턴시 증가 요인이 되어서는 안 됨 |
| `architecture-artifacts` | standalone-architecture-and-research-tools | 설계 선행 작업 및 계약 시드 도출 | 런타임 완료 권위와 결합 금지 |
| `codebase-understanding` | standalone-architecture-and-research-tools | 대규모 리팩토링 전 코드베이스 색인 | 일회성 분석 도구로 격리 |
| `standalone-diff-and-audit` | standalone-architecture-and-research-tools | 사용자 대면 검토용 HTML 리포트 생성 | 별도 CLI로만 구동 |
| `daily-retro-collection` | retrospective-and-regression-learning | 일일 작업 완료 후 회고 트리거 | 런타임 상태에 영향 주지 않음 (Advisory) |
| `improvement-proposals` | retrospective-and-regression-learning | 회고 후 개선 제안 작성 요청 | 자동 지식 승격 금지 |

---

## 4. REFERENCE MAP (2 Subcapabilities)

제품 코드의 기능이 아니라 저장소 품질, 테스트 등록 상태 및 표면 예산을 관측하기 위한 진단 참조 자산이다.

| Subcapability ID | Parent Family | Purpose |
| :--- | :--- | :--- |
| `harness-surface-budget` | harness-surface-and-regression-audit | 저장소 파일수/줄수/토큰 예산 기준선 측정 및 통제 |
| `regression-audit-reporting` | harness-surface-and-regression-audit | 미등록 테스트 탐지 및 회귀 테스트 상태 보고 |

---

## 5. DEPRECATED MAP (2 Subcapabilities)

과거 Relay 세대의 설계 결함과 스플릿 브레인 문제를 겪고 퇴역한 자산이다. 과거 역사와 교훈으로만 보존되며 현 제품에 직접 재도입해서는 안 된다.

| Subcapability ID | Parent Family | Deprecation Reason & Failure Lesson |
| :--- | :--- | :--- |
| `legacy-phase-runner` | legacy-phase-runner-and-harness-adapters | phase/attempt/lease 상태 이원화로 인한 분열 결함. 단일 Step Ledger로 대체됨. |
| `legacy-harness-adapters` | legacy-phase-runner-and-harness-adapters | 구 하네스 브릿지. 새 계약 및 격리 증거 없는 단순 복원 절대 금지. |

---

## 6. C9 Improvement/Eval Ownership Audit

C10 single-variable replay bridge가 추가된 뒤 실제 import graph와 package/CLI consumer를 다시 확인했다. 이 표는 새로운 capability 분류를 만들지 않고, 기존 자산이 **어디에 속하는지**만 명시한다.

| Asset / surface | Ownership classification | Current consumer / reason | C9 disposition |
| :--- | :--- | :--- | :--- |
| `src/host-tooling/kernel-eval/historical-improvement.ts` | active Host/offline eval tooling | current-generation HistoricalWorkCase 및 Knowledge finding 분석 | retain |
| `historical-actions.ts`, `historical-replans.ts` | active Host/offline eval tooling | 실행 hotspot/replan 진단; production mutation authority 없음 | retain |
| `historical-replay.ts` | active Host/offline eval tooling | current `CANDIDATE`를 기존 single-variable replay contract에 연결 | retain |
| `model-prompt-replay.ts` | active Host/eval tooling | ABBA, identity drift, quality → rework → efficiency 판정의 기존 replay contract | retain |
| follow-up / retrieval / model-routing / sentinel eval | active Host/eval tooling | focused regression/eval suite가 직접 소비 | retain |
| `src/host-tooling/kernel-public/optimization-cycle.ts` | active optional Host/public validation | unification audit가 optional optimization-cycle 완료 상태를 검사 | retain |
| `scripts/kernel/optimization-cycle.mjs` | compatibility projection | 위 typed source에서 build가 생성하는 package/runtime projection | retain; source로 취급 금지 |
| `scripts/kernel/eval/*.js` | compatibility projection | `src/host-tooling/kernel-eval/*.ts`의 generated runtime/package output | retain; source로 취급 금지 |
| `tools/retro/**` | active advisory production tooling | `moonshot-relay retro` CLI와 retro tests/package가 직접 소비 | retain |
| `scripts/knowledge-improvement-lifecycle.mjs` | active advisory compatibility validator | harness-memory-promoter skill과 package contract가 직접 사용 | retain until consumer migration |
| `scripts/awtl-memory-promotion.mjs` 및 `scripts/lib/awtl-*` | active explicit promotion/eval tooling | promotion audit, replay probe/scorecard, package contract가 직접 소비 | retain |
| `tools/awtl/trace-to-testcase.mjs` | active eval tooling | eval-regression contract와 package materialization이 직접 소비 | retain |
| `archive/scripts/legacy-phase-adapters/**`의 구 AWTL/phase 구현 | historical/dead asset | 현재 runtime consumer 없음; 비교·교훈 자산으로만 보존 | archive only; 재도입 금지 |

### Authority boundary

위 자산 중 어느 것도 Kernel의 completion, Knowledge persistence, verification 또는 automatic promotion Authority를 새로 소유하지 않는다. 해당 Authority는 기존 CORE capability에 남는다. 특히 retro/historical/replay 결과는 advisory/evidence이며 명시적 review/commit 없이 runtime policy나 canonical Knowledge로 승격되지 않는다.

### 삭제 판정

C9 시점의 실제 local corpus는 `HistoricalWorkCase=74`, `CANDIDATE=0`, `DEFERRED=2`, `INSUFFICIENT=3`이었다. 따라서 C10 consolidated path는 fixture와 fail-closed dogfood는 통과했지만 **실제 candidate replay 성공 사례는 아직 0건**이다.

원 계획의 "새 경로가 실제로 사용된 뒤에만 dead/duplicate path를 제거한다" 조건을 적용하면 이번 C9에서 active/compatibility 자산을 삭제하는 것은 시기상조다. 첫 실제 current-generation `CANDIDATE`가 C10 replay를 통과한 뒤 consumer/import graph를 다시 측정하고, 그때 consumer가 0인 compatibility/advisory 경로만 삭제 후보로 재분류한다.

이 결정은 다음을 추가하지 않는다.

- public Kernel command
- workflow stage
- durable table
- provider fallback
- scheduler/cache/suppression layer
- automatic mutation/promotion authority
- project-specific production heuristic
