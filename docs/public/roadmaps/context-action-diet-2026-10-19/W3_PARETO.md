# W3 · Pareto 병목 분석

## 결론

W2의 최신 completed/finalized run 20개를 분석한 결과, 전체 이력에서는 Verification이 가장 큰 비용 집중 영역이다.

그러나 이 결과를 그대로 W6 production 변경의 근거로 사용하면 안 된다. 표본 대부분은 2026-10-16 verification/reuse 정합화 이전 run이며, 현재 코드에는 이미 exact evidence reuse, same-report proof coalescing, stale/flaky/fresh 재실행 구분, pre-report 중복 proof 방지 지침이 존재한다.

2026-10-16 15:51 KST의 verification/reuse 정합화 커밋 `ff965da0` 이후 W2 표본에 포함된 completed run은 4개뿐이다. 이 4개는 각각 verification 1건만 기록했다. 따라서 현재 generation에서 Verification이 여전히 병목이라고 확정할 근거가 부족하다.

W3 판정은 다음과 같다.

- W4 Context: 수행하지 않음. prompt footprint coverage가 0/20이다.
- W5 Action: 수행하지 않음. 현재 generation의 attempt ledger가 없고 replan만으로 구조 변경을 정당화할 수 없다.
- W6 Verification: 역사적 병목 1순위지만 production 변경은 수행하지 않음. 10월 16일 기존 개선 이후 residual 병목을 입증하는 fresh run이 부족하다.
- 다음 단계: 새 abstraction이나 보정 heuristic을 추가하지 않고, W1 이후 실제 completed run에서 residual 비용을 다시 관측한다.

최종 판정: `NO_CURRENT_RESIDUAL_BOTTLENECK_PROVEN`.

## 근거와 계산

W2 고정 표본 20개를 사용했다. 누락 telemetry는 0으로 보정하지 않았다.

### 완전 관측 지표

| 지표 | 총량 | 상위 4 run 비중 | 상위 8 run 비중 | 판정 |
|---|---:|---:|---:|---|
| Mutation revision | 115 | 54 / 115 = 47.0% | 82 / 115 = 71.3% | 분산됨 |
| Replan | 33 | 21 / 33 = 63.6% | 31 / 33 = 93.9% | 일부 집중 |
| Intervention | 9 | 9 / 9 = 100% | 9 / 9 = 100% | 3개 run에만 존재 |
| Verification receipt | 619 | 411 / 619 = 66.4% | 534 / 619 = 86.3% | 가장 큰 집중 |

Verification 상위 3개 run만으로 371 / 619 = 59.9%를 차지했다.

1. `run-structural-improvement-2026-09-05`: 145
2. `run-5a88349a-f35a-4e3c-9a48-330a0ade3845`: 126
3. `run-23f5592b-c1ed-423f-a2e0-f6886d0c8cab`: 100

### Verification 품질/재사용 신호

W2 수집 receipt를 재사용해 verification history를 추가 대조했다.

- verification: 619
- failed verification: 107
- failure rate: 17.3%
- kernel proof execution: 563
- proof reuse: 2
- execution + reuse 기준 reuse rate: 0.35%
- failed verification이 있는 run: 12/20
- failed verification 상위 4 run: 72/107 = 67.3%

Verification wall timestamp는 12/20만 존재한다.

- 관측된 verification wall 합: 129,358,201 ms
- 상위 3 run: 106,108,172 ms
- 상위 3 비중: 82.0%

이 wall time에는 pause/resume이 포함될 수 있으므로 active compute time으로 해석하지 않는다.

### Action 지표

Attempt ledger가 있는 run은 12/20이다.

- attempt: 131
- failed attempt: 23
- failure rate: 17.6%
- failed attempt가 있는 run: 7/20
- 상위 3 run의 attempt: 71/131 = 54.2%
- 상위 3 run의 failed attempt: 16/23 = 69.6%

Attempt 지표는 coverage가 12/20이므로 Verification과 같은 신뢰도로 전체 표본 비교에 사용할 수 없다.

## generation 대조

Verification/reuse 정합화 기준은 `ff965da0`이다.

- commit time: 2026-10-16 15:51 KST
- UTC cutoff: 2026-10-16T06:51:12Z

W2 표본을 이 시점으로 나누면 다음과 같다.

| 구간 | Run 수 | Verification | Verification/run | Replan | Replan/run |
|---|---:|---:|---:|---:|---:|
| 정합화 이후 | 4 | 4 | 1.0 | 3 | 0.75 |
| 정합화 이전 | 16 | 615 | 38.44 | 30 | 1.88 |

정합화 이후 4개 run:

- `run-1bec6e30-a181-496c-a59a-2173e5704ea4`: verification 1
- `run-b6290dbe-873f-4af1-944a-0e612cfc453b`: verification 1
- `run-0075c9b5-807a-4edf-a0d4-c7d3a99f46ab`: verification 1
- `run-21849b21-8b0d-4851-9007-705299c737d3`: verification 1

이 차이를 `ff965da0`의 인과 효과로 단정하지 않는다. 작업 크기와 telemetry generation이 다르기 때문이다.

다만 중요한 점은 역사적 619건 중 615건이 해당 개선 이전 표본에 속한다는 것이다. 따라서 이력 전체의 verification 집중도를 근거로 현재 production을 다시 수정하는 것은 stale evidence를 이용한 최적화가 된다.

## 현재 구조 대조

현재 production에는 이미 다음 경계가 있다.

- `control-plane.ts`가 `reuseOfVerificationId`와 reuse receipt를 기록한다.
- exact reusable evidence를 찾으면 실제 command execution 없이 verification을 기록한다.
- 동일 report에서 같은 proof를 여러 obligation이 요구하면 shared execution/coalescing을 사용한다.
- `kernel-review-host-bridge.test.ts`가 같은 proof가 실제로 한 번만 실행되는 것을 검증한다.
- Kernel skill은 local debugging test와 Kernel completion proof를 분리한다.
- report 전에 동일 proof를 중복 실행하지 않도록 안내한다.
- fresh execution은 stale, flaky, explicit fresh 조건에만 요구한다.

2026-10-16 W3 workflow simplification도 production authority를 새로 추가하지 않고 기존 verification settlement/reuse를 model-facing 경로에 맞게 정리했다.

따라서 W6에서 새 verification scheduler, cache, taxonomy, state machine, fallback을 추가하는 것은 현재 근거보다 복잡도를 크게 늘린다.

## Wave 선택 판정

### W4 · Context

`SKIP_INSUFFICIENT_EVIDENCE`

W1 이전 20개 표본에는 prompt footprint가 없다. Provider token count도 1/20뿐이다. Context를 줄이기 위한 production 변경은 측정 없이 추측이 된다.

### W5 · Action

`SKIP_INSUFFICIENT_CURRENT_EVIDENCE`

전체 표본에서 replan은 일부 집중돼 있지만 attempt ledger는 12/20만 존재한다. 더 중요한 현재-generation 4개 run에는 attempt ledger가 없다. replan 0.75/run만으로 action loop를 다시 구조 변경할 근거가 없다.

### W6 · Verification

`HISTORICAL_TOP_BOTTLENECK_BUT_DEFER_CHANGE`

전체 이력에서는 명확한 1순위다. 그러나 verification/reuse 개선 이후 fresh comparable completed run이 4개뿐이고 모두 verification 1건이다. 현재 reuse 경로도 코드와 테스트로 존재한다.

따라서 W6 production 변경은 하지 않는다.

## 복잡도 검토

이번 W3에서 다음을 추가하지 않는다.

- 새 authority
- 새 state table 또는 DB column
- verification 전용 scheduler
- project/provider별 heuristic
- compatibility fallback
- 새로운 proof taxonomy
- 임의의 0 보정
- 과거 run을 새 telemetry 형식으로 추정하는 backfill

기존 telemetry, 기존 W2 baseline, 기존 Git history와 production source만 사용했다.

## 후속 기준

현재 구조를 추가 수정하려면 W1 이후 실제 completed run에서 다음 중 하나가 확인되어야 한다.

1. prompt footprint가 반복적으로 큰 동일 segment에 집중된다.
2. replan/attempt가 current generation에서도 반복적으로 높다.
3. exact reusable evidence가 있음에도 proof execution이 반복된다.
4. verification wall time이 fresh comparable run에서 반복적으로 상위 비용을 차지한다.

이 조건이 확인되기 전에는 W4/W5/W6 production 변경을 진행하지 않는다.

## W3 완료 판정

`COMPLETE_NO_CHANGE`

역사적 Pareto 1순위는 Verification이다. 하지만 해당 병목은 2026-10-16에 이미 직접 개선된 경계와 겹치며, 현재 residual 병목을 증명할 fresh evidence가 부족하다.

따라서 Context/Action/Verification 어느 쪽에도 새 production 변경을 추가하지 않는 것이 현재 증거에 맞는 최소 복잡도 결정이다.
