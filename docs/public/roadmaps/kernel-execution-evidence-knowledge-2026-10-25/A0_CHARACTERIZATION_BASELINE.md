# A0 Characterization Baseline

**Preset:** 01 — A0 Characterization Freeze
**Baseline HEAD:** `65b7419a66c4d5236d9952662a58c0983be112d2`
**Branch:** `main`
**Kernel Run:** `run-f69c4809-f56b-474b-8e96-81b7c14ae1d7`
**Characterization runtime:** isolated `/tmp/moon-relay-preset01-runtime`

이 문서는 production behavior를 바꾸지 않고 후속 A1~A7의 기준선을 고정한다.

## 1. Characterization 원칙

- historical corpus 전체를 fixture로 복제하지 않았다.
- 기존 regression이 충분한 항목은 새 fixture를 추가하지 않았다.
- production source는 수정하지 않았다.
- 새 fallback, registry, writable state, workflow stage를 추가하지 않았다.
- 현재 동작과 authority owner를 기록하고, 실제 수정은 해당 후속 Preset으로 넘긴다.

## 2. Representative Failure / Authority Map

| 대상 | 현재 authority / owner | 대표 regression | 현재 기준선 | 후속 판단 |
|---|---|---|---|---|
| 반복 failed Proof | `src/kernel/proof/evidence-reuse.ts`, `src/kernel/control-plane.ts` | `kernel-review-host-bridge`: report idempotency, proof coalescing, flaky reuse | 성공한 exact evidence만 재사용한다. failed proof에 대한 no-delta 억제 계약은 별도 characterization이 없다. | Preset 03(A2)에서 failed + same identity + no meaningful delta 재실행 여부를 명시적으로 고정/수정 |
| Workspace continuity mismatch | `src/kernel/run/binding-preflight.ts`, `src/kernel/run/invocation-resolver.ts`, worktree/state authority | `kernel-worktree-binding`, `kernel-run-env-resolution`, `kernel-session-run-lifecycle` | workspace identity는 worktree별로 구분되고 mismatch는 fail-closed | Preset 02에서 raw path/identity 비교 owner만 재검토 |
| Runtime binding stale | run locator + CLI binding resolution | `kernel-run-locator-fail-soft` | Turn 0 contract는 stale ambient locator를 우회해 fresh Run을 만들 수 있으나 explicit stale run-id는 fail-closed | 구조 기준선으로 유지 |
| Host binding missing/conflict | `src/kernel/run/binding-preflight.ts`, `src/kernel/run/invocation-resolver.ts` | `kernel-run-env-resolution`, `kernel-session-binding` | missing/conflicting Host identity는 typed failure로 차단 | Preset 03에서 failure ownership만 검토 |
| Host/environment execution failure | Host dispatcher / adapter execution boundary | `kernel-host-model-dispatch`, review Host bridge | failing dispatch는 success로 승격되지 않고 unsupported/unknown telemetry를 정직하게 유지 | Preset 03에서 Kernel recovery/Knowledge로의 잘못된 승격 여부 검토 |
| generic `known_failure_pattern` promotion | `src/kernel/knowledge/cross-run-evidence.ts`, candidate/review/promotion lifecycle | `kernel-knowledge-cross-run-evidence`, `kernel-knowledge-cross-run-promotion` | 반복 횟수만으로 durable pattern이 되지 않으며 generic blocker는 episodic에 머문다 | Preset 04는 현재 source를 다시 대조해 VERIFIED_EXISTING 가능성 우선 검토 |
| stale Knowledge selection | freshness + context selection | `kernel-knowledge-freshness-load`, `kernel-knowledge-supply-e2e` | source 소실/변경 record는 stale/deep-verify로 제외되고 scope와 sourceRefs가 분리됨 | Preset 05는 semantic invalidation과 provenance freshness의 남은 결합만 조사 |
| usage receipt missing / lineage | `src/kernel/persistence/host-execution-store.ts`, `work-attempt-store.ts`, `attempt-provenance.ts`, `control-plane.ts::recordModelUsage` | `kernel-model-usage-receipt`, `kernel-review-host-bridge` | run/decision/attempt 필드와 mismatch 검증은 이미 존재. routed review는 usage receipt 없이는 통과 불가 | Preset 06은 schema 재설계가 아니라 실제 owner-direct dispatch coverage가 끊기는지 확인 |

## 3. Evidence Reuse 현재 의미

`src/kernel/proof/evidence-reuse.ts`의 현재 계약은 다음과 같다.

- current result가 `passed`
- previous result가 `passed`
- exact Evidence Identity match

일 때만 evidence를 재사용한다.

따라서 **실패 evidence를 재사용하지 않는 안전성은 이미 존재한다.**

반면 다음 계약은 아직 별도로 고정되어 있지 않다.

```text
previous = failed
current Evidence Identity = same
meaningful delta = none
→ executor를 다시 실행하지 않는가?
```

이 항목이 Preset 03(A2)의 실제 수정 후보이다. A0에서는 behavior를 바꾸지 않는다.

## 4. Knowledge 현재 의미

현재 source와 regression은 계획 초안보다 이미 앞서 있다.

### 이미 고정된 것

- same-run retry는 cross-run recurrence로 세지 않는다.
- generic repeated blocker는 `episodic_observation`으로 남는다.
- repeat count만으로 durable candidate를 만들지 않는다.
- current-run resolution + fresh improvement evidence가 있어야 durable `known_failure_pattern` 후보가 될 수 있다.
- durable promotion도 기존 approval/replay authority를 통과해야 한다.
- stale/contradictory/scope-mismatched evidence는 promotion으로 숨기지 않는다.

따라서 Preset 04에서는 이 기능을 다시 구현하지 않는다. 실제 production gap이 없으면 `VERIFIED_EXISTING`으로 종료하는 것이 맞다.

## 5. Knowledge freshness 현재 의미

현재 regression은 다음을 보장한다.

- referenced source가 사라지면 stale로 selection에서 제외
- source drift는 `needs_deep_verify`
- applicability `scope`와 freshness `sourceRefs`는 분리
- scope-only record는 filesystem freshness input이 없어도 선택 가능
- stage materialization은 fresh/relevant canonical Knowledge만 공급

Preset 05는 이 기준선을 보존하면서, reusable semantic fact가 단순 path relocation 때문에 불필요하게 소실되는 실제 사례가 있는지 확인해야 한다.

## 6. Usage / Attempt lineage 현재 의미

현재 persistence에는 이미 다음 연결 필드가 존재한다.

```text
model usage receipt
→ run_id
→ attempt_id
→ route/admission
```

Work attempt에도 `usage_receipt_id` 필드가 존재하며, `attempt-provenance.ts`는 expected receipt와 attempt receipt가 다르면 `usage-receipt-mismatch`를 기록한다.

따라서 Preset 06에서 새 telemetry subsystem이나 새 table을 만드는 것은 금지한다. 확인해야 할 것은 **실제 Host owner-direct dispatch가 이 기존 lineage를 항상 채우는가**이다.

## 7. 실제 Moonremote Host 관측

이번 A0 수행 중 production source와 별개인 Host/runtime 상태에서 두 관측이 있었다.

### 7.1 generic `kernel` shim 없음

Moonremote shell의 PATH에서:

```text
kernel: command not found
```

이 관측은 repo launcher 결함으로 간주하지 않았다. 기존 canonical launcher인:

```text
node bin/moon-relay-kernel.mjs
```

를 사용했다.

Kernel core에 PATH fallback이나 shim 분기를 추가하지 않았다.

### 7.2 default account-root runtime identity 불일치

기본 `/root/.moon-relay-kernel`에서 Run 시작과 identity bootstrap은:

```text
project_identity_git_common_dir_unverified
```

로 fail-closed 됐다.

`kernel doctor`는 현재 root에 persisted identity가 없어 bootstrap을 권고했지만, default runtime의 기존 state가 동일 bootstrap을 차단했다.

A0 production 범위 밖이므로 state를 강제 수정하거나 alias를 추가하지 않았다.

대신 CLI가 공식 지원하는 `--runtime-home`을 이용해 **임시 격리 runtime**에서 identity bootstrap과 Kernel Run을 수행했다.

이 관측은 이후 identity/environment ownership 분석에서 참고하되, 개별 오류 전용 fallback 근거로 사용하지 않는다.

## 8. Focused Baseline

실행한 regression set:

```text
tests/kernel-review-host-bridge.test.mjs
tests/kernel-run-locator-fail-soft.test.mjs
tests/kernel-run-env-resolution.test.mjs
tests/kernel-worktree-binding.test.mjs
tests/kernel-host-model-dispatch.test.mjs
tests/kernel-model-usage-receipt.test.mjs
tests/kernel-knowledge-cross-run-evidence.test.mjs
tests/kernel-knowledge-cross-run-promotion.test.mjs
tests/kernel-knowledge-freshness-load.test.mjs
tests/kernel-knowledge-supply-e2e.test.mjs
```

결과:

```text
tests: 108
pass: 108
fail: 0
cancelled: 0
skipped: 0
```

## 9. 후속 Preset에 대한 조정

A0 결과를 바탕으로 다음 원칙을 적용한다.

- Preset 02: identity/evidence owner를 실제로 중복 판단하는 곳만 수정한다.
- Preset 03: failed proof no-delta 재실행과 failure ownership이 핵심 실제 gap이다.
- Preset 04: 기존 generic failure promotion guard가 충분하면 `VERIFIED_EXISTING` 가능.
- Preset 05: 기존 stale filter를 재구현하지 않는다.
- Preset 06: 기존 usage/attempt schema를 재설계하지 않고 live lineage coverage만 확인한다.

## 10. A0 Complexity Review

```text
production source change = 0
new fixture = 0
new public command = 0
new workflow stage = 0
new registry/state = 0
new fallback chain = 0
provider/OS/project-specific production branch = 0
```

A0는 characterization 기준선만 고정한다.

## 11. Build freshness Host limitation

`npm run build:tests:check`를 실행했지만 generated source mismatch가 아니라 Host의 메모리 부족으로 종료됐다.

```text
Error: ENOMEM: not enough memory, read
code: ENOMEM
syscall: read
Node.js v22.23.4
```

이 결과는 Kernel correctness failure로 승격하지 않는다. 이번 Preset의 production/test source 변경은 없고, focused regression은 108/108 통과했다. build freshness는 Host environment limitation으로 기록하며, Kernel authoritative proof는 별도 `typecheck` commandRef로 실행한다.
