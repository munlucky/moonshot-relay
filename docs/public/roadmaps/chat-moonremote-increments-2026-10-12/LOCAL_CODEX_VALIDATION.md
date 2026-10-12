# 로컬 Codex 모델-backed 검증

이 문서는 원격 Moonremote/CI가 실행할 수 없는 모델-backed 품질 검증을 로컬 Codex 환경에서 수행하는 절차다. 현재 실제 운영 provider surface는 Codex다. Claude/OpenAI standalone provider의 live 평가는 필수 릴리스 gate가 아니다.

## 1. 검증 대상

- 기준 corpus: `tests/fixtures/kernel-eval/corpus.json`의 `promptComparison`
- 고정 cases: 6개
- 반복: case별 old/new 각각 2회
- 순서: corpus에 정의된 교차 순서 사용
- workspace: 각 run이 동일한 격리 시작 상태를 사용해야 한다.
- 모델/profile/effort/tools: corpus에 고정된 조건을 유지한다.
- 실패 run과 incomplete run도 결과에서 제외하지 않는다.

원격 구현은 이 검증 결과에 맞춰 baseline을 다시 쓰지 않는다. 로컬 결과가 실패하면 해당 delta 카드로 돌아가 수정하고 같은 조건으로 재검증한다.

## 2. 로컬 사전 gate

작업 branch를 최신 상태로 받은 후 저장소 루트에서 실행한다.

```bash
npm run build:check
npm run build:tests:check
npm run typecheck
npm run check:boundaries
node --test   tests/kernel-eval-corpus-contract.test.mjs   tests/kernel-codex-gpt56-prompt.test.mjs   tests/kernel-codex-model-policy.test.mjs   tests/kernel-codex-plan-policy.test.mjs   tests/kernel-codex-programmatic-tool-policy.test.mjs   tests/kernel-codex-responses-capabilities.test.mjs   tests/kernel-turn-dispatcher-envelope.test.mjs
```

모든 검사가 같은 HEAD에서 통과해야 모델-backed 실행으로 넘어간다.

## 3. Codex 실행

현재 저장소에는 C01 corpus를 Codex 모델에 자동 제출하는 전용 A/B runner가 없다. 따라서 로컬 Codex 앱 또는 로컬 Codex 실행 surface에서 각 case를 독립 세션/격리 workspace로 실행한다.

각 case에서 다음 두 profile을 비교한다.

- old: C01에 고정한 baseline prompt/profile
- new: 현재 branch의 Prompt Profile/Host renderer/capability delta 적용 상태

각 arm을 2회 실행한다. 한 번의 좋은 결과만 선택하지 않는다. retry가 필요하면 C01의 retry budget을 따른다.

## 4. 기록 항목

각 run마다 최소 다음을 기록한다.

- case id, arm(old/new), repetition
- Codex model/profile/effort/tool 조건
- 시작 HEAD와 workspace identity
- task success와 acceptance 충족 여부
- scope violation
- hardcoded solution 여부
- regression 여부
- unsupported assumption
- extra file/fallback/abstraction 증가
- unnecessary tool/subagent call
- verification duplication
- clarification-before-action이 불필요했는지
- input/output/reasoning/cached token usage가 제공되면 실제 값
- latency가 제공되면 실제 값
- incomplete/retry 여부
- 결과 diff 또는 receipt 참조

provider가 주지 않는 usage metric은 `unavailable`로 기록한다. 추정치는 실제 값과 섞지 않고 `estimated`로 표시한다.

## 5. 합격 기준

정확성과 범위 안전성이 비용보다 우선한다.

- task success/acceptance가 baseline보다 낮아지지 않는다.
- scope violation, hardcoding, regression이 증가하지 않는다.
- critical authority 위반은 1건도 허용하지 않는다.
- 불필요 tool/subagent/중복 검증 횟수가 감소하거나, 실제 token/latency 중앙값이 사전 threshold 이상 개선되는 효율 근거가 하나 이상 있어야 한다.
- 변동성이 개선폭보다 크면 효율 개선은 미확인으로 판정한다.

실패하면 W1 전체를 재작성하지 않는다. 실패 원인이 속한 Prompt renderer 또는 capability delta 카드만 다시 연다.

## 6. 비운영 provider

Claude/OpenAI standalone live 평가는 현재 필수 gate가 아니다. deterministic serialization/capability/boundary 테스트는 원격 suite에서 계속 유지한다. 향후 해당 provider를 실제 운영 surface로 채택하면 그 시점에 동일 corpus를 사용해 provider-specific live gate를 추가한다.

## 7. 릴리스 판정

원격 W1 구현 완료와 로컬 Codex 모델-backed 검증 완료를 구분한다.

- 원격 W1 COMPLETE: 구현·계약·회귀·boundary 검증 완료
- 로컬 Codex VALIDATED: 위 6-case 모델-backed 비교 통과
- 릴리스/기본 profile 활성화: 로컬 Codex VALIDATED 이후

로컬 모델-backed 결과를 원격에서 mock으로 생성하거나 통과로 기록하지 않는다.
