# W7 · Model/Routing 평가 및 최종 통합 판정

## 최종 판정

`COMPLETE_KEEP_ROUTING_BASELINE_WITH_DEDUP_CLEANUP`

현재 Codex production model/routing 정책은 유지한다.

- planning: `gpt-6.1-sol / high`
- complex_implementation: `gpt-6.1-sol / high`
- review: `gpt-6.1-sol / xhigh`
- standard: `gpt-6-luna / medium`

W7에서 model mapping, escalation rule, routing authority는 변경하지 않았다.

대신 활성 profile source가 아닌 `package/profile-templates/codex/` 루트에 남아 있던 과거 provider/model TOML 4개를 제거했다. 실제 materialization authority는 기존대로 `package/profile-templates/codex/.codex/` 하나다. 재발 방지를 위해 Codex profile root에 sibling TOML model profile이 생기지 못하도록 계약 테스트를 추가했다.

## 최신 공식 모델 가이드 대조

2026-10-19 기준 OpenAI 공식 자료:

- Models: https://developers.openai.com/api/docs/models
- GPT-6 guide: https://developers.openai.com/api/docs/guides/latest-model
- Model selection: https://developers.openai.com/api/docs/guides/model-selection
- Work and Codex models: https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex

공식 가이드는 다음 역할을 제시한다.

- GPT-6 Astra: 가장 높은 intelligence가 필요한 복잡한 reasoning/coding.
- GPT-6.1 Sol: 복잡한 작업에서 intelligence와 cost의 균형.
- GPT-6 Luna: focused/high-volume 작업에서 가장 효율적.
- 모델과 reasoning effort는 실제 대표 작업에서 비교해 가장 가벼운 설정으로 품질 기준을 만족시키는 방식이 권장된다.

현재 정책은 이 역할 분리에 부합한다.

Astra를 planning/review 기본값으로 다시 올리지 않은 이유는 다음과 같다.

1. 현재 routing corpus에서 Sol/Luna 정책의 기능 회귀가 없다.
2. W1~W3에서 model quality regression 또는 routing failure가 residual 병목으로 확인되지 않았다.
3. Astra가 더 강한 모델이라는 사실만으로 비용이 더 큰 default를 정당화할 수 없다.
4. 현재 정책은 explicit user override를 허용하므로 특별히 Astra가 필요한 작업을 막지 않는다.

따라서 모델 세대 변경을 이유로 무조건 최고 tier를 default로 만드는 정책은 채택하지 않는다.

## Production routing authority

현재 production authority는 두 단계다.

1. Kernel은 provider-neutral `executionClass`를 결정한다.
2. Codex Host의 `src/host/kernel/codex-model-policy.ts`가 execution class를 실제 Codex model/effort로 해석한다.

Kernel provider-neutral classes:

- `planning`
- `complex_implementation`
- `review`
- `standard`

Codex Host provider mapping:

| Execution class | Model | Effort |
|---|---|---|
| planning | `gpt-6.1-sol` | `high` |
| complex_implementation | `gpt-6.1-sol` | `high` |
| review | `gpt-6.1-sol` | `xhigh` |
| standard | `gpt-6-luna` | `medium` |

Retry/risk 신호는 Host에서 임의 model tier를 선택하지 않는다. Kernel이 workload class를 바꾸고 Host는 그 class만 provider model로 투영한다.

이 구조를 유지한다.

## Shadow/evaluation GPT-5.6 자산 판정

다음 자산은 production runtime authority가 아니다.

- `scripts/provider-model-route-advisor.mjs`
- `scripts/lib/provider-model-routing.mjs`
- `scripts/lib/providers/codex-gpt-5-6-adapter.mjs`
- 관련 shadow fixture/tests

2026-10-17 baseline에서도 evaluation/shadow 자산으로 분류됐다.

이 경로는 diagnostic event를 만들지만 completion/promotion authority가 없다. 실제 Host model selection에도 import되지 않는다.

따라서 이번 W7에서는 이 historical shadow benchmark를 GPT-6 production policy와 병합하거나 재작성하지 않는다. 병합하면 provider-specific routing authority가 두 곳에 생길 위험이 더 크다.

향후 이 shadow benchmark 자체가 더 이상 평가 가치가 없다고 판단되면 별도 자산 정리 Wave에서 archive/delete해야 한다. 현재 W7에서는 runtime authority와 혼동되는 활성 profile hardcoding만 제거한다.

## 제거한 중복 profile hardcoding

삭제:

- `package/profile-templates/codex/config.toml`
- `package/profile-templates/codex/batch.config.toml`
- `package/profile-templates/codex/plan.config.toml`
- `package/profile-templates/codex/review.config.toml`

이 파일들은 2026-07~09의 이전 model 정책에서 생성된 자산이었다.

삭제 근거:

- `package/package-contract.yaml`의 Codex `templateRoot`는 `package/profile-templates/codex/.codex/`.
- `package/build-package.mjs`도 `.codex`만 materialize한다.
- installer/profile doctor 역시 materialized `.codex/config.toml`을 사용한다.
- 네 sibling TOML은 production materializer 참조가 없다.
- 상위 `package/profile-templates/codex/`가 bundle manifest에 포함되므로, 남겨 두면 실행되지 않는 과거 모델 ID가 배포 자산에 섞인다.

즉 이 삭제는 모델 정책 변경이 아니라 duplicate/stale configuration surface 제거다.

## 재발 방지

`tests/codex-profile-config-contract.test.mjs`에 다음 구조 계약을 추가했다.

- Codex profile source root에 sibling `*.toml` 파일이 없어야 한다.
- 실제 `.codex/config.toml`은 기존대로 global model/provider를 pin하지 않는다.
- 모델 선택은 worker invocation의 Host execution-class policy에서만 수행한다.

새 모델 세대가 추가되어도 profile TOML 복제본을 더 만들지 않고 `codex-model-policy.ts`의 단일 provider mapping을 변경·평가하도록 한다.

## Routing baseline 검증

변경 전 `npm run test:routing`:

- 73 tests
- pass 73
- fail 0

검증 내용에는 다음이 포함된다.

- invocation별 model selection
- parent session invariance
- model mismatch fail-closed
- owner-direct/native worker 경계
- independent review
- routing corpus cost proxy
- provider-neutral routing contract
- shadow evidence의 non-authority
- provider isolation

W7 변경 후 검증:

- `npm run test:routing`: 74/74 통과. 새 duplicate-profile guard 포함.
- package/materialization focused suite: 57개 중 56 통과, 1 환경 의존 skip, 실패 0.
- `npm run typecheck`: 통과.
- `npm run build:check`: 302 files / 817 edges / changed 0 / removed 0.
- `npm run build:tests:check`: 285 tests / 8 helpers / removed 0.
- `npm run check:boundaries`: 9 modules / 302 files / 817 edges 통과.
- `git diff --check`: 통과.
- Codex profile source root의 sibling `*.toml`: 0개.
- 활성 `.codex` template의 model pin 및 GPT-5.6/Astra hardcoding: 0개.

## W1~W7 통합 결과

### W1 · measurement

완료.

- 실제 prompt measurement를 기존 usage receipt에 연결.
- proof/review wall 측정 연결.
- 측정 불가능 값을 가짜 0 대신 null로 유지.
- 새 DB/state authority 없음.

### W2 · baseline

완료.

- 실제 completed/finalized run 20개 고정.
- 여러 telemetry generation이 섞였음을 명시.
- prompt footprint 0/20, provider token 1/20로 Context 비용 비교를 금지.

### W3 · Pareto

완료.

역사적 1순위 병목은 Verification이었다.

- 619 verification
- 상위 4 run 66.4%
- historical proof reuse 0.35%

그러나 2026-10-16 verification/reuse 정합화 이후 표본 4개는 각각 verification 1건이었다.

판정:

- W4 Context: skip
- W5 Action: skip
- W6 Verification: historical top bottleneck, current change defer

### W4~W6

production 변경 없음.

확인되지 않은 residual 병목을 개선한다는 이유로 새 scheduler, cache, taxonomy, heuristic, fallback을 추가하지 않았다.

### W7 · Model/Routing

현재 Sol/Luna execution-class mapping 유지.

실제 문제로 확인된 것은 model mapping이 아니라 활성 경계 밖에 남은 중복 legacy profile TOML이었다. 이를 제거하고 단일 profile/config authority 계약을 강화했다.

## 복잡도 최종 리뷰

이번 전체 작업으로 새로 만들지 않은 것:

- 두 번째 routing authority
- 모델별 retry matrix
- project-specific model heuristic
- provider fallback chain
- verification scheduler
- Context backfill 추정기
- 별도 telemetry DB
- profile별 model hardcoding 사본
- 자동 Astra escalation

유지한 단일 경계:

`Kernel workload class → provider Host model policy → observed receipt`

## 후속 관측 조건

추가 production 최적화는 W1 이후 실제 completed run이 충분히 쌓였을 때만 수행한다.

다음 중 하나가 반복 관측되어야 새 변경을 검토한다.

1. prompt footprint가 특정 segment에 반복 집중.
2. current-generation replan/attempt가 반복적으로 높음.
3. exact reusable proof가 있는데 실제 proof가 재실행됨.
4. verification wall이 current-generation의 반복 상위 비용.
5. Sol/Luna routing에서 품질·completion regression이 대표 eval로 확인됨.
6. Astra 또는 다른 tier가 동일 품질에서 비용/시간 포함 objective를 유의미하게 개선함.

그 전에는 현재 baseline을 유지한다.

## 최종 상태

`CONTEXT_ACTION_DIET_COMPLETE`

현재 확인된 문제는 최소 변경으로 처리됐다.

- measurement visibility: 개선됨
- historical bottleneck: 식별됨
- stale evidence 기반 과잉 최적화: 차단됨
- routing baseline: 유지
- stale profile model hardcoding: 제거
- 새 runtime complexity: 추가하지 않음
