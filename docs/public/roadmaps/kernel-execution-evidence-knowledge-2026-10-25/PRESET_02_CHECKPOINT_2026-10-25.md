# Preset 02 A1 Identity + Evidence Semantics — 체크포인트

작성 시점: 2026-10-25
작업 경로: `/shared/moonshot-relay`
기준 브랜치: `main`

이 문서는 Preset 02 작업을 다음 세션에서 바로 이어서 마감하기 위한 인계 문서다.
완료된 구현과 검증을 반복하지 말고, 아래 **재개 순서**부터 진행한다.

## 1. 가장 먼저 복구할 Moonremote 작업

기존 Moonremote task를 그대로 재사용한다.

- taskId: `c89c2ddc-da35-446c-825f-aa29f36b4059`
- 마지막 확인 revision: `4`
- objective: Preset 02 A1 Identity + Evidence Semantics
- 상태: `active`
- 실행 중/unsettled process: 없음

다음 세션 첫 호출:

```text
get_work_context
taskId = c89c2ddc-da35-446c-825f-aa29f36b4059
format = full
```

새 task를 만들지 않는다.

## 2. Git 기준점

마지막 확인 상태:

- branch: `main`
- local HEAD: `66cabf23323ef0f52e03d04feb0736398c2a9bbe`
- `origin/main`: `66cabf23323ef0f52e03d04feb0736398c2a9bbe`
- 따라서 **작업 시작 기준 local/origin parity는 일치**했다.
- 아직 Preset 02 변경은 commit/push하지 않았다.

체크포인트 문서 작성 전 tracked 변경 파일은 다음 4개였다.

```text
M docs/public/roadmaps/kernel-execution-evidence-knowledge-2026-10-25/STATUS.md
M src/kernel/persistence/trust-store.ts
M tests/kernel-evidence-semantics.test.ts
M tests/kernel-runtime-home-isolation.test.ts
```

diff stat:

```text
4 files changed, 262 insertions(+), 20 deletions(-)
```

이 체크포인트 파일 자체가 추가되므로 다음 세션에서는 `git status --short`를 다시 확인한다.

## 3. Preset 02에서 실제로 구현한 내용

### 3.1 Evidence current projection을 raw latest-row 선택에서 authority-aware 선택으로 변경

canonical production 수정은 현재 **1개 파일**이다.

`src/kernel/persistence/trust-store.ts`

기존 동작은 obligation별 `MAX(id)` row를 current verification으로 사용했다.
이 때문에 동일 Evidence Identity에서 나중에 기록된 weaker/caller-attested observation이 기존 Kernel VERIFIED를 덮을 수 있었다.

현재 구현은 다음 기준으로 current verification을 선택한다.

1. Evidence Identity digest가 다른 경우 새 evidence generation으로 간주한다.
2. 기존 row가 identity-bound이고 새 row가 identity-less이면 기존 row를 유지한다.
3. 새 row만 identity-bound이면 새 row를 선택한다.
4. 동일 Evidence Identity에서는 executor authority를 비교한다.
   - `kernel-runtime`: authority 2
   - 그 외 caller-attested 계열: authority 1
5. 동일 identity에서는 equal-or-stronger authority만 current projection을 전진시킨다.
6. authoritative contradiction은 current evidence를 갱신한다.
7. verification history 자체는 삭제하거나 덮어쓰지 않는다.
8. exact reusable verification도 같은 current-selection 의미를 사용한다.

관련 새 helper:

- `evidenceIdentityDigest`
- `verificationAuthority`
- `preferCurrentVerification`
- `selectCurrentVerifications`

run + obligation grouping key는 NUL delimiter를 사용하지 않는다.
구조 감사 중 실제 NUL byte가 source에 들어간 문제를 발견해 다음처럼 **text-safe JSON tuple**로 교체했다.

```ts
JSON.stringify([row.runId, row.obligationId])
```

이 변경 뒤 source의 NUL count는 0이다.

### 3.2 새 evidence regression

`tests/kernel-evidence-semantics.test.ts`

추가/강화한 핵심 회귀:

- 동일 Evidence Identity에서 weaker caller-attested failure가 기존 Kernel VERIFIED를 덮지 않는다.
- identity 없는 unobserved attestation도 identity-bound authoritative evidence를 덮지 않는다.
- 동일 Evidence Identity에서 `kernel-runtime` contradiction은 current evidence를 failed로 갱신한다.
- contradiction 뒤 exact reusable verification은 제거된다.
- history는 모두 보존된다.
- source identity 변경 시 과거 verification history는 유지되지만 Trust Authority freshness는 `source-identity-mismatch`로 stale이 된다.
- scoped identity가 바뀐 경우 기존 verification row는 보존하지만 completion requirement는 stale로 불충족된다.

### 3.3 Runtime path alias 회귀

`tests/kernel-runtime-home-isolation.test.ts`

symlink/junction alias와 physical runtime path가 기존 `resolveKernelRuntimeHome` canonicalization을 통해 동일 runtime identity로 해석되는 회귀를 추가했다.

새 runtime identity subsystem이나 alias registry는 만들지 않았다.

### 3.4 기존 worktree identity authority

같은 project의 linked worktree가 서로 다른 deterministic worktree identity를 유지하는 기존 회귀를 확인했다.

production 수정은 하지 않았다.

관련 기존 회귀:

`tests/kernel-worktree-binding.test.ts`

## 4. 검증 결과

### 4.1 로컬 focused 검증

post-cleanup 상태에서 다시 실행한 결과:

- TypeScript `typecheck`: pass
- runtime `build`: pass
- test `build:tests`: pass
- focused identity/evidence tests: **29/29 pass**
- `build:check`: pass
  - 308 files
  - 829 edges
  - changed 0
- `build:tests:check`: pass
  - 289 tests
  - 8 helpers
- `check:boundaries`: pass
  - 9 modules
  - 308 files
  - 829 edges

focused test 대상:

```text
tests/kernel-evidence-semantics.test.mjs
tests/kernel-runtime-home-isolation.test.mjs
tests/kernel-worktree-binding.test.mjs
```

로컬 재검증 receipt operationId:

`da998263-ef7e-46cb-a9f8-b7c77da1a979`

### 4.2 최초 Kernel authoritative proof

최초 구현 상태에서 Kernel Run을 완료했다.

- Run: `run-ebe47a8a-8aa3-4fb9-881d-278e769bb0cd`
- commandRef: `test:kernel-reliability`
- result: pass
- Kernel completion: `accepted / done`
- evidence digest:
  `sha256:94c6d0f9a4eaadad713b30877663a8e2435e825d7756cc035f5db6b2a710a059`

그 뒤 구조 감사에서 source 내부 NUL delimiter를 발견해 text-safe key로 수정했다.
따라서 이 최초 proof는 **최종 freshness proof로 사용하지 않는다.**

초기 report에서 knowledgeObservation 두 건을 `fact`, `constraint` type으로 넣었고 canonical knowledge type 불일치로 commit되지 않았다.

- `knowledgeRequired=false`
- Kernel completion에는 영향 없음
- Preset 02 범위에서 knowledge schema 확장이나 fallback은 추가하지 않았다.

이 문제는 Preset 02 마감 blocker가 아니다.

### 4.3 기존 runtime에서 successor final verification을 시도했을 때의 차단

post-proof textual cleanup 뒤 같은 runtime에서 successor Run을 만들려고 했으나 Kernel이 다음 오류로 정상 차단했다.

`successor_workspace_continuity_mismatch`

원인:

- predecessor final workspace identity:
  `sha256:b5eef2dd206f4596a676e16003ed9d5f119cf83756cf32797100641079b35110`
- cleanup 뒤 current workspace identity:
  `sha256:2c3f5a0504983f47a1ce9decafa4698794772ab9d48b3a10ccf77025279fc858`

즉 completed predecessor 뒤 workspace가 바뀌었기 때문에 continuity 규칙이 successor 생성을 막은 것이다.

이 이력을 수정하거나 DB를 고치거나 fallback으로 우회하지 않았다.

관련 operation:

- failed successor start: `1b7a6b8a-b00f-4f57-85fb-16cfb182d26c`
- diagnose: `26c9428a-a5ef-4535-af51-4c281cb9d48e`

diagnose 결과 기존 runtime에는 현재 workspace를 소유하는 active Run이 없었다.

### 4.4 post-cleanup 최종 Kernel authoritative proof

완료된 predecessor history를 건드리지 않고 현재 snapshot 자체를 다시 증명하기 위해 **격리된 임시 runtime**을 사용했다.

runtime:

`/tmp/moon-relay-preset02-final-runtime`

identity bootstrap은 `policy=isolate`로 수행했다. repository/account canonical state를 adopt하거나 overwrite하지 않았다.

최종 Run:

`run-66ad1736-757c-48c7-b1fe-24ca6b1b42ae`

최종 결과:

- status: `completed`
- goalStatus: `complete`
- Kernel decision: `accepted`
- next action: `done`
- commandRef: `test:kernel-reliability`
- proof status: pass
- executor: `kernel-runtime`
- evidence freshness: `fresh`
- acceptance: **3/3 complete**
- failures: 0
- mutationDetected: false
- finalization: completed
- knowledge: no_change

최종 evidence digest:

`sha256:5b34dba0c66498df74cf09f53d4a3aa0140bd260ef737ddf3829207997218a44`

최종 completion digest:

`sha256:5ab798c49ca7194a5a26869d9fb43a2ca1575ed3789c12dcee6d84ed423f5521`

최종 verified workspace identity:

`sha256:2c3f5a0504983f47a1ce9decafa4698794772ab9d48b3a10ccf77025279fc858`

관련 operation:

- isolated bootstrap + next:
  `ce4dd14c-6f9f-4d3d-91dd-2812875e8571`
- final report/proof:
  `b79e7442-5746-418a-b929-c08648e89c73`

이 Run이 **Preset 02 구현 상태에 대한 최신 Kernel authoritative proof**다.

주의: 이 체크포인트 문서가 repository에 추가된 시점은 위 final proof 이후다.
따라서 다음 세션에서 checkpoint/status 문서까지 같은 commit에 포함할 경우, final Git closeout 직전에 workspace freshness를 다시 확인한다. production/test source는 final proof 이후 변경하지 않았다.

## 5. 구조 복잡도 리뷰 결과

현재까지 확인한 결과:

- production source 수정: **1개 파일**
- 새 identity subsystem: 없음
- 새 alias registry: 없음
- 새 DB table/column: 없음
- 새 writable state: 없음
- 새 fallback chain: 없음
- provider/특정 프로젝트 전용 분기: 없음
- model-visible 규칙 추가: 없음
- compatibility layer 추가: 없음
- Project/Workspace/Runtime identity owner 중복 추가: 없음
- Trust Authority freshness 판단 owner 변경: 없음

이번 변경은 persistence의 **current evidence projection 선택**만 보강하고, freshness/completion 판정은 기존 Trust Authority에 남겨 두는 구조다.

## 6. STATUS.md 현재 상태와 남은 문서 수정

`docs/public/roadmaps/kernel-execution-evidence-knowledge-2026-10-25/STATUS.md`에는 Preset 02를 COMPLETE로 표시해 두었다.

단, 현재 문구 중 다음 줄은 final Run이 끝나기 전에 작성되어 아직 미래형이다.

```text
Final Kernel authoritative proof: 현재 post-cleanup successor Run에서 test:kernel-reliability로 재검증한다.
```

다음 세션에서 이 줄만 실제 완료 결과로 현행화한다.

권장 내용:

```text
Final Kernel authoritative proof: isolated final Run run-66ad1736-757c-48c7-b1fe-24ca6b1b42ae에서 test:kernel-reliability pass, accepted/done.
Final evidence digest: sha256:5b34dba0c66498df74cf09f53d4a3aa0140bd260ef737ddf3829207997218a44
```

## 7. 다음 세션에서 해야 할 작업

아래 순서만 수행한다.

1. `get_work_context(taskId=c89c2ddc-da35-446c-825f-aa29f36b4059, format=full)`
2. `git status --short`, `git diff --stat`, `git diff --check` 확인
3. 이 체크포인트 작성 이후 production/test source가 변경되지 않았는지 확인
4. `STATUS.md`의 final proof 문구를 실제 완료 결과로 현행화
5. 구조 감사 최종 1회
   - 특정 프로젝트/OS/provider 하드코딩 없음
   - fallback chain 없음
   - 새 writable state 없음
   - duplicate authority 없음
   - source에 NUL byte 없음
6. 문서 수정으로 workspace identity가 바뀌므로, **필요한 freshness 검증만 수행**
   - production/test source가 그대로라면 완료된 로컬/Kernal proof를 무조건 처음부터 반복하지 말 것
   - Kernel completion freshness가 문서 변경 때문에 stale로 판단되면 current snapshot에 맞는 bounded proof만 다시 수행
7. `STATUS.md`와 checkpoint를 포함한 최종 diff 확인
8. Conventional Commit 형식의 **상세한 한국어 commit message**로 Preset 02를 하나의 commit으로 마감
9. `git push origin main`
10. local HEAD == `origin/main` 확인
11. Moonremote checkpoint를 최종 갱신
12. 원래 Preset 02 요청이 모두 끝났고 미완료가 0인지 확인한 뒤에만 `complete_work(outcome=completed)`
13. Preset 03은 이 task에서 시작하지 않는다.

## 8. 커밋 대상 예상

현재 기준 예상 commit 범위:

```text
docs/public/roadmaps/kernel-execution-evidence-knowledge-2026-10-25/STATUS.md
docs/public/roadmaps/kernel-execution-evidence-knowledge-2026-10-25/PRESET_02_CHECKPOINT_2026-10-25.md
src/kernel/persistence/trust-store.ts
tests/kernel-evidence-semantics.test.ts
tests/kernel-runtime-home-isolation.test.ts
```

generated JS/MJS는 build로 freshness를 확인했지만 현재 tracked diff에는 없다.
직접 generated file을 편집하지 않는다.

## 9. 다음 프리셋

Preset 02 마감 후 다음 대상은:

`Preset 03 — A2+A3 Proof Delta + Failure Ownership`

하지만 **Preset 02 commit/push/parity/Moonremote complete_work를 먼저 끝낸 뒤 별도 task로 시작**한다.
