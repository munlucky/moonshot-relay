# A단계 Historical Replay 결과

작성일: 2026-10-25
대상: Preset 01~06 / A0~A7
기준 HEAD: `5b5cd6189041b071ba01a7b413a29f7cef6df657` + Preset 06 test/doc delta

## 결론

**B단계 진입 가능: PASS**

A0에서 고정한 대표 failure와 Preset 01~05에서 변경한 Evidence/Knowledge 경계를 Preset 06의 representative integration gate로 다시 검증했다.

이번 결과는 historical corpus 전체의 모든 실사용 세션에 대한 통계적 전후 비교가 아니다. A0 characterization, 현재 generation regression, fixed sentinel corpus, historical replay contract를 결합한 bounded regression 판정이다. A0에서 수치 baseline이 없던 항목은 임의 숫자를 만들지 않고 정성 비교로 기록한다.

## Usage Receipt Lineage

A6 production schema와 persistence 경계는 이미 필요한 lineage를 보유하고 있었다. 따라서 새 table, exporter, provider-specific cost policy를 추가하지 않았다.

현재 verified chain:

```text
route decision
→ Host dispatch
→ provider execution observation
→ usage receipt
→ canonical attempt
→ run
```

대표 Host dispatch 회귀에서 다음을 한 번에 확인했다.

- provider: `claude`
- requested/resolved/observed model identity
- input tokens
- cached input tokens
- output tokens
- wall clock
- route decision
- attempt ID
- usage receipt ID
- run ID
- attempt의 `usageReceiptId` 역참조

지원하지 않는 telemetry는 기존 계약대로 `null`을 유지한다. 값을 추정하거나 0으로 위조하지 않는다.

### A6 판정

**VERIFIED_EXISTING + REGRESSION STRENGTHENED**

production lineage repair는 필요하지 않았다. 부족했던 것은 representative owner/routed Host dispatch에서 전체 lineage를 한 번에 고정하는 회귀였다.

## A0 대비 A단계 결과

| 지표 | A0 기준선 | Preset 06 현재 판정 |
|---|---|---|
| 동일 failed Proof 반복 | no-delta suppression 계약이 별도로 고정되지 않음 | 동일 Evidence Identity에서는 executor 재호출 0. source/fixture/verifier/environment delta만 재실행 |
| binding recovery | typed fail-closed/recovery 존재. 수치 baseline 없음 | cross-project/workspace/session recovery regression 유지. 수치 개선율은 산출하지 않음 |
| generic failure Knowledge | 일부 guard 존재. standalone generic failure 경로는 남아 있었음 | generic session failure는 episodic. durable pattern은 fingerprint+cause+scope+verified resolution/replay 필요 |
| usable verified Knowledge | stale filter가 source relocation과 semantic invalidation을 함께 취급 | Run A→Run B reuse 유지. semantic/architecture fact의 missing provenance는 재사용 가능, source drift는 reverify |
| usage receipt coverage | schema/field 존재. live lineage 전체 회귀 부재 | representative dispatch 1/1에서 route/receipt/attempt/run + telemetry lineage 완전 확인 |
| task/completion regression | A0 focused 108/108 | A-stage representative gate 121/121 |
| false completion | 별도 fixed sentinel authority 존재 | sentinel false completion 0, missed accept 0 |
| project leakage | namespace isolation 회귀 존재 | Run A→Run B project root isolation 통과 |
| scope safety | worktree/work-unit scope 회귀 존재 | work-unit recovery 및 binding gate 통과 |

## Representative Integration Gate

실행 대상:

```text
kernel-host-model-dispatch
kernel-model-usage-receipt
kernel-review-host-bridge
kernel-evidence-semantics
kernel-run-env-resolution
kernel-work-unit-recovery-e2e
kernel-knowledge-cross-run-promotion
kernel-knowledge-reuse-e2e
kernel-knowledge-supply-e2e
kernel-sentinel-eval
kernel-historical-improvement
```

결과:

```text
tests: 121
pass: 121
fail: 0
cancelled: 0
skipped: 0
```

추가 결과:

- fixed sentinel false completion: **0**
- fixed sentinel missed accept: **0**
- historical replay contract: current supported candidates만 single-variable replay queue에 진입
- replay scoring authority: quality → rework → efficiency 순서 유지
- historical replay 자체는 production mutation/promotion authority를 갖지 않음

## A1~A5 보존 확인

### A1 Identity + Evidence

- same Evidence Identity의 authoritative verification monotonicity 유지
- source identity 변경은 history를 보존하되 current evidence를 stale 처리
- cross-project/workspace binding은 fail-closed

### A2+A3 Proof Delta + Failure Ownership

- persisted failed proof + same Evidence Identity는 재실행하지 않음
- meaningful delta가 있을 때만 proof executor 재호출
- product verification failure는 Work에 남음
- Kernel binding/identity failure와 Host infrastructure failure 경계 유지

### A4 Knowledge Quality

- repeat count만으로 durable candidate 생성 안 함
- identified cause + reproducible fingerprint 없는 failure는 durable pattern 아님
- approval/replay/commit authority 유지

### A5 Knowledge Reuse

- direct SQLite Run A→Run B Knowledge reuse 통과
- revision continuity 유지
- project root isolation 유지
- source relocation과 semantic invalidation 분리
- source drift는 계속 deep verification 요구

## B단계 진입 Gate

다음 비열화는 관측되지 않았다.

- false completion 증가: **없음**
- stale proof의 현재 completion 오사용: **없음**
- project Knowledge leakage: **없음**
- scope/workspace safety 약화: **없음**
- normal completion regression: **없음**
- generic Host/environment failure의 durable policy 자동 승격: **없음**

따라서 Preset 07의 B1+B2 authority/prompt reduction으로 진행할 수 있다.

## Complexity Review

Preset 06에서 production subsystem은 추가하지 않는다.

```text
new telemetry table = 0
new exporter = 0
new provider-specific Kernel cost policy = 0
new workflow stage = 0
new fallback chain = 0
new failure registry = 0
```

A6는 기존 receipt/attempt/run authority를 재사용한다. A7는 기존 fixed sentinel과 historical replay contract를 재사용한다.
