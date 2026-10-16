# Kernel Relay 실사용 워크플로우 단순화 개발 계획

작성일: 2026-10-16 (Asia/Seoul)

기준 소스: `09f452bfc8ef241040233078903555c73a7be62f`

상태: 구현 전 계획. 코드 변경은 아직 시작하지 않는다.

## 1. 목표

이번 작업은 Kernel의 안전 권위를 약화하지 않고, 일반 애플리케이션 작업에서 모델이 직접 관리하는 절차 상태와 중복 왕복을 구조적으로 줄인다.

최종 목표는 다음과 같다.

> 일반 애플리케이션 작업에서 모델이 Kernel 내부 구현을 읽거나 제어용 JSON을 수작업으로 고치지 않아도 되고, Host와 Kernel은 하나의 canonical 경로를 사용하며, scope·binding·proof·completion 권위는 그대로 유지한다.

구현 순서는 반드시 다음을 따른다.

```text
Existing capability 확인
→ 공개 사용 경로 정합화
→ semantic equivalence와 안전성 검증
→ 검증된 경로의 model-visible 왕복 제거
→ 전후 측정
→ 남은 내부 복잡도만 제거
```

## 2. 설계 원칙

### 2.1 유지할 Authority

다음 Authority는 제거하거나 Host로 우회하지 않는다.

- **Work Authority**: 현재 목표, Work Unit, scope, lease, owner.
- **Trust Authority**: workspace observation, proof freshness, review, completion.
- **Knowledge Authority**: project knowledge 조회·기록·revision.

### 2.2 제거할 model-visible 절차 상태

가능한 범위에서 다음을 모델이 직접 관리하지 않게 한다.

- Task Contract JSON의 형식적 wiring.
- acceptance ID와 evidence binding.
- 정상 경로의 run/session ID 추적.
- recovery JSON 파일과 retry bookkeeping.
- authoritative Git 경로에서의 changedPaths 재기술.
- Kernel이 이미 수행할 verification의 중복 수동 실행.
- report 직후 다시 호출하는 model-visible `next`.

### 2.3 금지 사항

이번 작업에서는 다음 방식으로 문제를 해결하지 않는다.

- 특정 프로젝트명, 경로, provider, 모델명에 맞춘 하드코딩.
- 특정 오류 코드마다 별도 fallback을 추가해 흐름을 계속 우회하는 방식.
- 구 경로와 신 경로를 장기간 병렬 유지하는 compatibility layer.
- Host와 Kernel에 같은 정책을 중복 구현.
- 새 workflow engine, session registry, recovery engine, verification taxonomy, scoring engine.
- `objective → acceptance` 단순 복사.
- scope를 모른다는 이유로 `allowedPaths=[]`를 자동 사용.
- non-Git 변경 관측 실패를 빈 변경으로 간주.
- `report.next`를 현재 `next()`의 검사를 생략하는 대체물로 사용.
- fresh evidence, owner, lease, scope, completion gate 완화.

기존 경로가 구조적으로 중복이면 새 fallback을 추가하지 말고 canonical path로 수렴시킨다.

## 3. Moonremote 공통 실행 규칙

모든 Wave는 아래 규칙을 따른다.

1. 정확한 workspace에서 `get_work_context`를 먼저 실행한다.
2. 활성 task가 있으면 재사용한다. 없을 때만 현재 Wave 목표로 checkpoint를 만든다.
3. 기존 `prepared/running/unknown` 실행을 새 operationId로 반복하지 않는다.
4. 시작 전에 `git status --short`, HEAD, branch, upstream parity를 확인한다.
5. 이전 Wave의 commit이 origin에 push되고 remote parity가 확인되지 않으면 다음 Wave를 시작하지 않는다.
6. 제품 원본은 `src/**/*.ts`와 canonical asset을 수정한다. 생성된 `scripts/**/*.js`, `dist/**`는 직접 편집하지 않는다.
7. 테스트 변경은 `tests/**/*.ts`에서 하고 현재 build 절차로 생성 테스트를 갱신한다.
8. 한 Wave에서 unrelated cleanup을 합치지 않는다.
9. 구조적 해결이 가능한데 새 fallback·provider 분기·프로젝트별 예외를 추가하려 하면 해당 Wave를 중단하고 설계를 다시 검토한다.
10. 각 Wave 끝에서 STATUS.md를 갱신하고 검증 후 **Wave 하나당 commit 하나**를 기본으로 한다.
11. commit 후 즉시 push하고 remote parity를 확인한다.
12. push 실패 시 같은 Wave에서 복구한다. 새 commit으로 덮거나 다음 Wave로 넘어가지 않는다.

### Wave commit 형식

Conventional Commit type/scope는 유지하되 설명과 본문은 한국어로 작성한다.

예:

```text
refactor(kernel): 다음 작업 준비 경로를 canonical next로 통합

report 이후 다음 Work Unit 준비가 별도 projection과 next 호출로 나뉘어
preflight·knowledge refresh·scope 검사의 의미가 달라질 수 있던 구조를 정리했다.

- 실행 가능한 continuation은 canonical next 경로에서만 생성
- report와 next가 동일한 준비 결과를 사용하도록 Host 경계 통합
- scope/preflight/knowledge 전환 동등성 회귀 테스트 추가

검증:
- npm run typecheck
- focused kernel continuation tests
- npm run build:check
- npm run build:tests:check
```

커밋 본문은 실제 diff와 실제 검증 결과에 맞춰 작성한다. 위 예시를 그대로 복사하지 않는다.

## 4. Wave 구성

| Wave | 핵심 목표 | 선행 | 위험도 | 완료 후 commit/push |
| --- | --- | --- | --- | --- |
| W0 | 안전 기준선과 characterization 고정 | 없음 | 낮음 | 필수 |
| W1 | Git owner-direct changedPaths 경로 정합화 | W0 | 중간 | 필수 |
| W2 | Session source-selection과 canonical binding 경계 정리 | W1 | 중간 | 필수 |
| W3 | Verification/report 사용 경로 정합화 | W2 | 낮음~중간 | 필수 |
| W4 | canonical next preparation 단일 경로 확립 | W3 | 높음 | 필수 |
| W5 | 검증된 continuation으로 model-visible next 왕복 제거 | W4 equivalence 통과 | 높음 | 필수 |
| W6 | semantic Contract 입력으로 JSON wiring 축소 | W5 | 중간~높음 | 필수 |
| W7 | Recovery continuity mechanics를 Host 경계에 흡수 | W6 + 필요성 확인 | 중간~높음 | 필수 |
| W8 | telemetry·전후 측정·통합 검증·잔여 복잡도 제거 | W7 또는 VERIFIED_EXISTING | 중간 | 필수 |

Wave는 W0→W8 순서로 닫는다. W4가 완료되기 전에는 W5를 시작하지 않는다. W6/W7은 앞선 Wave의 실제 결과에서 model-visible friction이 남아 있음을 확인한 뒤 수행한다.

---

# W0 · 안전 기준선과 구조 Characterization

## 목표

현재 안전 의미와 source-selection 정책을 테스트로 고정하고, 이후 Wave가 behavior-preserving인지 판단할 기준을 만든다.

제품 동작을 개선하지 않는다. 현재 정책과 반드시 보존해야 할 invariant를 명시한다.

## 주요 입력

- `src/application/kernel-cli/main.ts`
- `src/host/kernel/host-session.ts`
- `src/kernel/control-plane.ts`
- `src/kernel/run/workspace-change-set.ts`
- `src/contracts/verification-settlement.ts`
- `src/kernel/state-store.ts`
- `src/kernel/run/measurement.ts`
- `src/kernel/bridge/mcp.ts`
- `skills/moon-relay-kernel/SKILL.md`

## 작업

### W0-1. Session 정책 characterization

현재 동작을 그대로 고정한다.

- `CODEX_THREAD_ID`만 있으면 canonical Codex session으로 연결.
- env session과 thread ID가 같으면 성공.
- env session과 thread ID가 다르면 `host_binding_conflict`.
- explicit session과 env session이 같으면 성공.
- explicit session과 env session이 다르면 `host_binding_conflict`.
- explicit `--session-id`가 있으면 CLI가 `CODEX_THREAD_ID`를 resolver 후보에서 제외하는 현재 정책을 별도 테스트로 고정.
- resolver는 전달된 후보만 canonicalize하고 충돌 검사.

이 Wave에서 모든 후보를 항상 비교하도록 정책을 바꾸지 않는다.

### W0-2. changedPaths 안전 기준선

다음을 characterization 또는 기존 regression으로 고정한다.

- Git owner-direct에서 omitted claim과 explicit `[]`가 다른 의미.
- explicit `[]` + 실제 변경은 reject.
- run baseline 이전 dirty change와 이후 task change를 구분.
- index-only/staged change 의미 유지.
- worker/parallel receipt의 changedPaths provenance 비교 유지.
- non-Git에서 authoritative Git change set이 없을 때 현재 explicit report 정보가 필요함을 테스트로 드러낸다.

나쁜 behavior를 영구 계약으로 만들지 않는다. non-Git omission이 현재 빈 변경으로 흘러가는 경우에는 “현재 한계”를 테스트 이름과 주석으로만 기록하고 W1의 수정 대상에 둔다.

### W0-3. next 의미 차이 characterization

`report.next` projection과 canonical `next()`의 차이를 고정한다.

canonical `next()`에서 다음이 실행됨을 테스트 또는 기존 테스트 조합으로 증명한다.

- binding preflight.
- contract preflight.
- pending delivery materialization recovery.
- knowledge context refresh.
- proof-policy/verification support refresh.
- baseline-required 판단.
- current Work Unit scope fail-closed 검사.

W0에서는 두 결과를 같게 만들지 않는다.

### W0-4. Verification reuse 기준선

다음 reuse 조건을 테스트로 고정한다.

- obligation.
- contract revision.
- exact evidence identity.
- reusable success evidence.
- forceFresh/flaky/discovered 조건.

단순 command 문자열 중복만으로 reuse하지 않는다는 점을 명확히 한다.

### W0-5. Telemetry 의미 고정

기존 field의 의미를 변경하지 않는다.

- `timeToFirstMutationMs = runStartedAt → firstMutationAt`.
- owner-direct `firstMutationAt`는 실제 editor mutation 순간이 아니라 Kernel first-observed mutation일 수 있음.
- `contractRepairCount`가 현재 모든 성공 contract revision에서도 증가할 수 있음을 characterization.

## 예상 테스트

기존 테스트를 우선 확장한다.

- `tests/kernel-run-env-resolution.test.ts`
- `tests/kernel-session-binding.test.ts`
- `tests/kernel-changed-path-contract.test.ts`
- `tests/kernel-contract-preflight-continuation.test.ts`
- `tests/kernel-next-purity.test.ts`
- `tests/kernel-efficiency-telemetry.test.ts`
- verification reuse를 이미 소유한 기존 test.

새 테스트 파일은 기존 owner가 명확하지 않을 때만 만든다.

## 완료 조건

- 안전 invariant가 현재 HEAD에 대해 재현 가능하다.
- explicit session이 thread ID를 대체하는 현재 CLI 규칙이 테스트에 있다.
- non-Git과 Git changed-path 의미가 혼동되지 않는다.
- canonical next와 raw projection의 차이가 테스트에서 보인다.
- generated test 산출물 freshness가 맞다.
- 제품 behavior 변경 없음.

## 검증

최소:

- `npm run build:tests`
- 관련 focused tests.
- `npm run typecheck`
- `npm run build:tests:check`
- `git diff --check`

### W0 commit 예시

`test(kernel): 워크플로우 단순화 안전 기준선 고정`

---

# W1 · Git Owner-Direct Report 계약 정합화

## 목표

authoritative Git workspace에서는 모델이 changedPaths를 다시 적지 않아도 되게 하되, non-Git과 worker receipt의 의미는 손상하지 않는다.

## 핵심 구조

```text
Git owner-direct
  → caller path claim 불필요
  → Kernel baseline + live observation
  → actualChangedPaths

non-Git
  → authoritative Git change set 없음
  → explicit change information 또는 typed rejection

isolated worker / parallel
  → canonical execution receipt provenance 유지
```

## 작업

### W1-1. report 입력 역할 분리

owner-direct 일반 report와 isolated worker receipt의 changedPaths 의미를 코드/타입에서 명확히 구분한다.

- owner-direct에서 Git authoritative observation이 가능한 경우 changedPaths를 optional claim으로 취급.
- worker execution receipt에서 changedPaths required provenance 유지.
- Codex adapter의 worker schema를 무조건 느슨하게 만들지 않는다.
- 동일 타입 하나를 억지로 optional 처리해 provenance를 약화하지 않는다.

가능하면 기존 report normalization과 worker outcome type을 재사용한다. 새로운 범용 schema 계층을 만들지 않는다.

### W1-2. non-Git fail-safe

non-Git에서 changedPaths omission이 자동으로 빈 변경으로 성공하지 않게 한다.

선호 순서:

1. 기존 명시 report 경로가 있으면 그것을 유지.
2. 기존 typed failure가 의미적으로 정확하면 재사용.
3. 기존 error taxonomy로 표현할 수 없을 때만 최소 typed failure를 추가.

새 fallback으로 stat 결과를 “authoritative”라고 승격하지 않는다.

### W1-3. Skill/MCP 설명 정합화

일반 Git owner-direct 사용 경로에서는 changed files를 모델이 필수로 작성해야 한다는 표현을 제거한다.

동시에 non-Git과 worker receipt 예외를 명시한다.

`kernel_report` 도구 설명도 실제 semantics와 맞춘다.

### W1-4. 제거할 중복

W1 완료 후 owner-direct Git 경로에서 모델이 changedPaths를 채우기 위해 별도 `git diff --name-only` 등을 수행하도록 유도하는 지침이 있다면 제거한다.

## 예상 변경 경로

- `src/kernel/control-plane.ts`
- `src/kernel/run/workspace-change-set.ts`는 필요한 경우만.
- `src/host/kernel/adapters/codex.ts`는 worker와 owner 계약 분리에 필요할 때만.
- `src/kernel/bridge/mcp.ts`
- `skills/moon-relay-kernel/SKILL.md`
- 관련 tests.

## 완료 조건

- Git owner-direct omission 성공.
- explicit wrong claim은 기존처럼 reject.
- dirty/index baseline 보호 유지.
- non-Git actual edit + omission이 “변경 없음”으로 완료되지 않음.
- worker receipt mismatch 차단 유지.
- project/provider-specific 분기 추가 없음.

## 검증

- changed-path focused suite.
- worker/parallel receipt 관련 focused suite.
- MCP bridge contract test.
- typecheck.
- build / build:check.
- build:tests / build:tests:check.
- 필요 시 `npm run check:boundaries`.

### W1 commit 예시

`refactor(kernel): Git owner report의 변경 경로 권위를 workspace 관측으로 일원화`

---

# W2 · Session Source Selection과 Binding 경계 정리

## 목표

정상 Codex 세션에서 모델이 session ID를 직접 관리할 필요를 줄이되 현재 source-selection과 conflict semantics를 그대로 보존한다.

## 핵심 구조

```text
Host/CLI source selection
  → resolver candidate set 결정
  → canonical session resolver
  → consistency validation
  → binding preflight
```

## 작업

### W2-1. source-selection 정책 단일 소유

현재 explicit session이 `CODEX_THREAD_ID`를 대체하는 규칙이 여러 호출부에 복제되지 않게 한다.

구현 시 목표는 “조건문을 더 넣기”가 아니다.

- source-selection policy를 한 owner에 둔다.
- resolver는 전달된 후보의 canonical consistency만 책임진다.
- 기존 explicit/env/thread semantics를 유지한다.
- 다른 provider의 session source를 Codex 규칙으로 하드코딩하지 않는다.

정확한 함수 위치는 W0 characterization 뒤 결정한다. 기존 `host-session.ts` 경계로 흡수할 수 있으면 새 모듈을 만들지 않는다.

### W2-2. 정상 경로의 수동 session 노출 축소

Skill/Host가 정상 Codex 실행에서 `--session-id`를 요구하거나 모델이 thread ID를 복사하게 하는 지침이 있으면 제거한다.

explicit session은 진단·명시적 Host pinning 경로로 남길 수 있다. 새로운 fallback로 사용하지 않는다.

### W2-3. conflict 유지

다음 차단은 그대로 유지한다.

- env vs thread conflict.
- explicit vs env conflict.
- wrong owner.
- wrong worktree.
- run binding conflict.

## 예상 변경 경로

- `src/application/kernel-cli/main.ts`
- `src/host/kernel/host-session.ts`
- 필요한 Host binding helper.
- `skills/moon-relay-kernel/SKILL.md`
- `tests/kernel-run-env-resolution.test.ts`
- `tests/kernel-session-binding.test.ts`

## 완료 조건

- 정상 Codex thread는 수동 session ID 없이 연결.
- explicit session override semantics 유지.
- resolver candidate conflict fail-closed 유지.
- session policy가 CLI, Host adapter, skill에 중복 구현되지 않음.
- 새 session registry/fallback 없음.

## 검증

- session focused tests.
- run env resolution.
- lifecycle binding tests.
- cross-surface regression 중 관련 범위.
- typecheck/build checks.

### W2 commit 예시

`refactor(kernel): Host session 선택과 canonical binding 책임을 단일 경계로 정리`

---

# W3 · Verification과 Report 사용 경로 정합화

## 목표

이미 있는 verification settlement/reuse를 실제 model-facing 경로에 맞게 연결해, 모델이 동일 proof를 report 전에 의무적으로 중복 실행하지 않게 한다.

## 작업

### W3-1. Skill semantics 정리

다음 의미를 분명하게 만든다.

```text
local debugging test
  ≠ Kernel completion evidence

kernel report
  → outstanding obligation 선택
  → trusted proof execute 또는 reuse
```

“모든 evidence를 먼저 기록한 뒤 report”처럼 읽혀 동일 proof를 복제하게 하는 지침을 제거한다.

### W3-2. requestedVerifications 최소화

모델이 이미 만족된 obligation을 습관적으로 재요청하지 않도록 Host/Skill surface를 정리한다.

- Kernel의 자동 outstanding proof selection을 우선.
- explicit fresh/flaky 요청 semantics는 유지.
- integration/goal settlement 의미는 유지.
- 새로운 focused/closeout 내부 taxonomy를 만들지 않는다.

### W3-3. reuse 회귀

동일 reusable evidence가 있을 때 command 재실행이 일어나지 않는 기존 경로를 확인한다.

필요하면 Host/model view가 stale/outstanding 상태를 더 정확하게 보여주되 새 state machine은 만들지 않는다.

## 예상 변경 경로

- `skills/moon-relay-kernel/SKILL.md`
- `src/kernel/bridge/mcp.ts` 설명/모델 view가 실제로 잘못 유도할 때만.
- `src/kernel/control-plane.ts`는 실제 reuse 연결 결함이 발견될 때만.
- verification/evidence 관련 tests.

## 완료 조건

- existing `focused/integration/goal` 유지.
- reusable proof의 재실행 없음.
- fresh/flaky는 재실행.
- 모델이 Kernel proof와 동일한 명령을 필수 pre-report 단계로 수행하라는 지침 없음.
- 새 verification abstraction 없음.

## 검증

- evidence semantics/reuse focused tests.
- host loop test.
- real usage regression의 관련 시나리오.
- skill surface/packaging test.
- build checks.

### W3 commit 예시

`fix(kernel): report 중심 proof 실행과 evidence 재사용 경로 정합화`

---

# W4 · Canonical Next Preparation 단일 경로 확립

## 목표

`report.next`의 단순 projection과 `next()`의 실행 준비 semantics가 분리된 구조를 하나의 canonical continuation 경계로 수렴시킨다.

**이 Wave에서는 아직 model-visible 추가 next 호출을 제거하지 않는다.**

## 현재 문제

현재 `next()`는 다음 준비를 수행한다.

- binding preflight.
- task contract preflight.
- delivery materialization recovery.
- knowledge context refresh.
- proof-policy binding refresh.
- verification support.
- locator sync.
- capability resolution.
- baseline-required 판단.
- current Work Unit scope 검사.
- completion/context projection.

반면 report 결과의 `next`는 `buildNextForRun()` projection이다.

## 구조 원칙

실행 가능한 continuation의 canonical authority를 하나만 둔다.

우선순위는 **기존 `next()` semantics 재사용**이다.

선호 구조:

```text
report 완료
   \
    → canonical continuation preparation → model next view
   /
kernel next
```

새로운 두 번째 planner나 state machine을 만들지 않는다.

## 작업

### W4-1. continuation owner 확정

`next()`의 side effect와 lease boundary를 분석하고 실행 가능한 continuation을 누가 준비할지 고정한다.

가능한 최소 구조:

- Control Plane의 canonical next path를 내부 API로 그대로 재사용하거나,
- Host report path가 report 완료 후 canonical `next()`를 내부 호출.

`buildNextForRun()`를 실행 authority로 승격하지 않는다.

### W4-2. semantic equivalence harness

report 이후 prepared continuation과 별도 canonical next를 다음 항목에서 비교한다.

- action/status.
- current step.
- allowed/forbidden paths.
- contract rejection.
- delivery recovery.
- knowledge context revision/digest.
- obligations/verification support.
- capabilities.
- baseline-required.
- scope rejection.
- completion.

### W4-3. 위험 시나리오

반드시 포함:

- 다음 Work Unit이 unbounded라 scope rejection.
- contract preflight 실패.
- pending delivery materialization.
- knowledge context revision 전환.
- unsupported verification.
- baseline-required.
- blocked/resumed run.
- completed/finalization-incomplete 경계.

## 예상 변경 경로

- `src/kernel/control-plane.ts`
- `src/kernel/bridge/mcp.ts` 또는 기존 Host lifecycle 경계.
- 필요하면 `src/host/kernel/lifecycle-bridge.ts`.
- `tests/kernel-contract-preflight-continuation.test.ts`
- `tests/kernel-completion-view.test.ts`
- `tests/kernel-host-loop-e2e.test.ts`
- `tests/kernel-bridge-mcp.test.ts`
- 새 equivalence 테스트는 기존 owner로 표현 불가능할 때만 추가.

## 완료 조건

- 실행 가능한 continuation은 canonical next semantics를 거침.
- report 경로와 next 경로가 서로 다른 policy를 복제하지 않음.
- W0에서 고정한 safety invariant 모두 유지.
- model-visible 인터페이스 변경은 아직 하지 않음.
- compatibility fallback 추가 없음.

## 검증

- continuation focused suite.
- contract preflight.
- host loop/MCP bridge.
- knowledge freshness 관련 focused tests.
- run-step scope.
- typecheck/build/build:check/build:tests:check.
- check:boundaries.

### W4 commit 예시

`refactor(kernel): 다음 작업 준비를 canonical continuation 경로로 통합`

---

# W5 · Model-Visible Next 왕복 제거

## 진입 조건

W4 semantic equivalence가 모두 통과해야 한다.

하나라도 다르면 W5를 시작하지 않고 W4 구조를 수정한다.

## 목표

report가 성공한 뒤 모델에게 별도 `kernel next`를 다시 호출시키지 않는다. 내부에서는 canonical next preparation을 그대로 수행한다.

## 작업

### W5-1. MCP report continuation

`kernel_report`가 report settlement 이후 canonical continuation을 준비하고 한 결과 안에서 모델에 제공하게 한다.

Host review가 추가되는 경우도 같은 continuation path를 사용한다.

### W5-2. model-facing guidance 축소

Skill과 model view에서 정상 report 직후 “다시 next 호출”을 요구하는 지침을 제거한다.

다음 경우만 별도 next 호출이 남을 수 있다.

- 사용자가 명시적으로 상태를 새로 요청.
- report와 무관한 다음 turn에서 workspace/authority가 변경.
- diagnostic command.

이를 위해 새 fallback 분기를 만들지 않는다.

### W5-3. stale projection 제거

canonical prepared continuation으로 대체된 raw `buildNextForRun()` report projection이 실제 consumer가 없으면 제거한다.

consumer가 남아 있으면 어떤 consumer가 왜 필요한지 증거를 남기고 W5에서 임의 제거하지 않는다.

## 완료 조건

- 일반 report→next 사이 model-visible tool round trip 1회 감소.
- 내부 safety preparation은 W4와 동일.
- scope/preflight/knowledge transition 회귀 없음.
- raw/stale continuation path가 중복 Authority로 남지 않음.
- Host review 경로도 동일 canonical continuation 사용.

## 검증

- W4 equivalence suite 재실행.
- MCP bridge report→continuation E2E.
- host review path.
- real usage regression.
- next purity.
- build checks.

### W5 commit 예시

`refactor(kernel): report 이후 canonical continuation을 Host 내부에서 준비`

---

# W6 · Semantic Contract 입력으로 JSON Wiring 축소

## 진입 조건

W0~W5 이후 일반 앱 흐름에서 여전히 contract JSON 형식 조립이 반복되는지 확인한다.

이미 현재 MCP `contractJson`의 단순 semantic object만으로 충분하면 새 schema를 만들지 않고 Skill/Host projection만 정리한다.

## 목표

모델은 objective/acceptance/constraints/non-goals/scope 의미를 제공하고, 기존 Kernel normalization이 ID와 형식을 구성하게 한다.

## 구조 원칙

새 Contract v2를 만들지 않는다.

기존 `normalizeTaskContract()`, acceptance indexing, evidence-plan compiler를 재사용한다.

## 작업

### W6-1. 최소 semantic input 경로

가능한 입력:

- objective.
- acceptance statements.
- constraints.
- nonGoals.
- explicit narrow scope when known.

다음을 모델이 만들지 않게 한다.

- acceptance ID.
- obligation ID wiring.
- evidence receipt ID.
- digest.
- 내부 revision.

### W6-2. ambiguity fail-safe

완료 의미가 불명확하면 objective를 acceptance로 복사하지 않는다.

mutation scope가 불명확하면 `allowedPaths=[]`를 넣지 않는다.

필요하면 read-only discovery로 전환하고 mutation contract를 나중에 구성한다.

### W6-3. CLI/MCP 역할

MCP는 structured object를 직접 받을 수 있으므로 파일 생성이 필요 없게 한다.

CLI의 `--contract-json`은 CLI 사용 경로로 남길 수 있지만 model-facing 기본 flow가 되지 않게 한다.

새 `--simple-contract`, `--auto-contract` 같은 parallel flag를 추가하지 않는다.

## 예상 변경 경로

- `src/kernel/bridge/mcp.ts`
- `src/application/kernel-cli/main.ts`는 help/default path 정합화가 필요할 때만.
- `src/kernel/task/task-contract.ts`
- Host composition/lifecycle 경계.
- `skills/moon-relay-kernel/SKILL.md`
- bridge/contract/evidence-plan tests.

## 완료 조건

- 일반 MCP 경로에서 temp contract JSON 파일 불필요.
- simple semantic input이 기존 normalized contract로 수렴.
- ambiguity가 권한 확대나 약한 acceptance로 바뀌지 않음.
- 새 contract schema/compatibility layer 없음.

## 검증

- task contract focused tests.
- evidence plan.
- MCP contract-first bootstrapping.
- successor/resume.
- scope guard.
- build/checks.

### W6 commit 예시

`refactor(kernel): Host 의미 입력을 기존 Task Contract 정규화로 직접 연결`

---

# W7 · Recovery Continuity Mechanics 축소

## 진입 조건

W0~W6 이후에도 정상 복구에서 모델이 recovery JSON, previous fingerprint, retry counter를 직접 관리하는 흐름이 실제로 남아 있어야 한다.

그렇지 않으면 W7은 `VERIFIED_EXISTING` 또는 범위 축소로 종료한다.

## 목표

continuity mechanics는 Host가 관리하고 Kernel은 recovery admission/safety authority를 유지한다.

## 구조

```text
Host
  diagnosis history
  previous fingerprint
  retry count
  safe re-entry mechanics

Kernel
  owner / lease / scope
  workspace validity
  recoverability
  safety blocker
  proof / completion authority

Model
  실제 원인 진단과 수리
```

## 작업

### W7-1. existing recovery path 재사용

`agent-recovery.ts`의 fingerprint와 unchangedAttempts를 새로운 저장 시스템으로 복제하지 않는다.

Host가 기존 recovery capsule을 보존·재전달할 수 있으면 그 경로를 사용한다.

### W7-2. normal recovery surface 축소

정상 복구에서 모델이 파일을 만들어 `--previous-recovery-json`을 반복 전달할 필요를 줄인다.

inspect/escalate/safety/scope extension은 계속 model/user-visible로 남긴다.

### W7-3. 반복 제한 유지

동일한 실패에서 무한 retry가 되지 않게 기존 unchanged-attempt limit를 유지한다.

새 자동 fallback로 repair를 강행하지 않는다.

## 예상 변경 경로

- `src/kernel/run/agent-recovery.ts`는 authority 의미 변경이 필요할 때만.
- `src/host/kernel/run/agent-recovery.ts`
- `src/application/kernel-cli/recovery.ts`
- Host lifecycle.
- Skill recovery guidance.
- recovery focused tests.

## 완료 조건

- 정상 recoverable case에서 model bookkeeping 감소.
- owner/scope/lease/safety admission 유지.
- 3회 unchanged escalation 의미 유지.
- 새 recovery DB/table/state machine 없음.
- unknown failure를 guessed fallback으로 완료하지 않음.

## 검증

- agent recovery tests.
- work-unit recovery E2E.
- workspace recovery.
- session/run lifecycle.
- conditional planning recovery.
- build checks.

### W7 commit 예시

`refactor(kernel): recovery 연속성 관리를 Host 경계로 축소`

---

# W8 · 전후 측정, 통합 검증, 잔여 복잡도 제거

## 목표

이번 개선의 실제 효과를 측정하고, W0~W7 과정에서 남은 중복 경로를 제거한 뒤 전체 작업을 닫는다.

## 작업

### W8-1. Telemetry 의미 보존

기존 field 이름을 바꾸거나 과장 해석하지 않는다.

- `timeToFirstMutationMs`: run start부터 Kernel first-observed mutation.
- `firstMutationAt`: 실제 editor edit 시각이 아닐 수 있음.
- `contractRepairCount`: 현재 정상 revision도 포함할 수 있음.

새 subsystem을 만들지 않는다.

필요한 분석 분류는 기존 receipt/errorCode/contract lineage에서 파생한다.

### W8-2. 전후 지표

가능한 경우 이번 주 세션 baseline과 개선 후 일반 앱 세션을 비교한다.

핵심 지표:

- user request → first observed repository edit.
- Kernel internal source read 횟수.
- 수동 Contract JSON 수정 횟수.
- schema/contract repair round trip.
- recovery model turn.
- report 후 별도 model-visible next 호출.
- reusable evidence가 있는데 실제 proof command가 다시 실행된 횟수.
- expected guard와 harness friction의 분리.

세션 데이터에서 실제 edit 순간을 알 수 없으면 “first observed edit”라고 명시한다.

### W8-3. 제거 리뷰

다음만 실제 증거가 있을 때 제거한다.

- W5 이후 consumer가 없는 raw continuation projection.
- W6 이후 모델 전용 contract wiring.
- W7 이후 불필요한 manual recovery guidance.
- 같은 policy를 가진 Host/Kernel 중복 코드.
- 사용되지 않는 compatibility branch.

삭제 대신 새 fallback을 추가하지 않는다.

### W8-4. 구조 리뷰

최종 diff를 다음 관점에서 검토한다.

- 새 provider/project hardcoding이 생기지 않았는가.
- fallback 수가 늘지 않았는가.
- Authority source가 늘지 않았는가.
- model-visible field가 실제로 줄었는가.
- Host와 Kernel에 동일 policy가 복제되지 않았는가.
- 새 abstraction이 실제 consumer 1개를 위해 과도하게 추가되지 않았는가.

## 통합 검증

최종 closeout에서만 broad suite를 실행한다.

최소 후보:

- `npm run typecheck`
- `npm run check:boundaries`
- `npm run build`
- `npm run build:check`
- `npm run build:tests`
- `npm run build:tests:check`
- `npm run test:kernel-lifecycle`
- `npm run test:kernel-reliability`
- 변경 범위가 넓으면 `npm run test:kernel` 또는 `npm test`를 최종 한 번 검토.

전체 suite는 Wave마다 반복하지 않는다. 각 Wave에서는 관련 focused tests를 사용한다.

## 완료 조건

다음은 감소해야 한다.

- 일반 앱 세션의 Kernel 내부 source 탐색.
- contract/recovery JSON 수동 조립.
- 불필요한 report→next 모델 왕복.
- reusable proof의 불필요 재실행.

다음은 악화되면 안 된다.

- false completion.
- scope escape.
- owner/run hijack.
- lease bypass.
- baseline dirty-file 오판.
- stale proof acceptance.
- non-Git 변경 누락.
- worker receipt provenance 검증.

### W8 commit 예시

`refactor(kernel): 실사용 워크플로우 단순화 통합 검증과 잔여 경로 정리`

---

## 5. Wave별 커밋·푸시 Closeout

각 Wave는 아래 순서로 닫는다.

1. `git status --short`로 예상 파일만 변경됐는지 확인.
2. `git diff --check`.
3. source 변경이면 typecheck.
4. 해당 Wave focused tests.
5. 필요한 build/generated freshness 검사.
6. 구조 복잡도 리뷰:
   - 새 fallback?
   - provider/project hardcoding?
   - 중복 Authority?
   - 기존 기능 재사용 대신 새 abstraction?
7. STATUS.md에 실제 변경·검증·남은 항목 기록.
8. commit message 파일을 한국어로 작성.
9. commit.
10. push.
11. remote branch hash와 local HEAD parity 확인.
12. checkpoint update.
13. 다음 Wave 진입.

### Wave 실패 시

테스트 실패가 구현 결함이면 같은 Wave에서 수정한다.

다음 경우는 즉시 BLOCKED로 기록하고 다음 Wave로 넘어가지 않는다.

- scope를 넓혀야만 해결 가능.
- safety semantics 변경 필요.
- 기존 behavior와 계획이 충돌.
- 다른 owner의 대규모 변경이 필요.
- 새 migration/state table 필요.
- compatibility fallback 없이는 진행할 수 없다고 판단.

이 경우 구조를 다시 검토한다. 임시 분기 추가로 통과시키지 않는다.

## 6. 상태 기록 형식

각 Wave 완료 시 STATUS.md에 다음을 기록한다.

```text
wave: Wn
status: COMPLETE / BLOCKED / VERIFIED_EXISTING
baseHead:
resultHead:
taskId:
scope:
acceptance:
checks:
structuralReview:
commit:
push:
remaining:
nextWave:
```

`push`에는 remote parity까지 기록한다.

## 7. 구현 시작 시 첫 요청

실제 Moonremote 실행은 [START_HERE.md](START_HERE.md)의 W0 요청으로 시작한다.

한 요청에서 여러 Wave를 자동 실행하지 않는다. 사용자가 “모든 Wave를 순차 진행”이라고 명시한 경우에도 각 Wave마다 검증 → commit → push → parity 확인을 끝낸 뒤 다음 Wave로 넘어간다.

## 8. 최종 완료 판정

W8까지 완료됐더라도 다음을 모두 만족해야 전체 계획을 완료로 본다.

- W0~W8 상태가 COMPLETE 또는 명시적 VERIFIED_EXISTING.
- 각 구현 Wave의 commit이 origin에 존재.
- 최종 working tree가 깨끗함.
- broad regression이 현재 HEAD에 대해 성공.
- 구조 리뷰에서 새 hardcoding/fallback/중복 Authority가 남지 않음.
- plan에서 제거하기로 한 model-visible 절차가 실제 일반 사용 경로에서 제거됨.
- 기존 safety invariant가 모두 유지됨.

문서 상태 변경만으로 완료라고 판단하지 않는다.
