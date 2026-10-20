# Knowledge 공급 경로 W5 평가 결과

판정일: 2026-10-20. 최종 판정: **W1/W2/W3 모두 PROMOTE**.

## 평가 범위

이번 평가는 새 evaluation framework를 만들지 않았다. 기존 `runKnowledgeRetrievalEvaluation()`과 Knowledge production API를 그대로 사용했고, 각 비교 대상은 detached temporary worktree에서 해당 revision을 직접 build한 뒤 같은 fixture를 실행했다. 임시 evaluator와 결과 JSON은 `/tmp`에만 두었고 source package에는 넣지 않았다.

비교 revision은 다음과 같다.

| 구분 | revision | 의미 |
|---|---|---|
| Baseline | `64d12c19` | W0 완료 직후 |
| A / W1 | `f03b69b9` | canonical duplicate collapse |
| B / W2 | `a98df7d3` | scope/sourceRefs/freshness 의미 분리 |
| C / W3 | `51a62ff5` | verification binding + failure-pattern 승격 품질 |

W4 `4d3b37fd`는 candidate 기능 추가가 아니라 W1~W3 공급 경로를 E2E 회귀로 고정한 테스트 commit이므로 change arm으로 분리하지 않았다.

## Gate 1 — Quality

### A — W1 canonical duplicate collapse: PROMOTE

동일 statement/scope의 semantic fact 10건과 별도 유효 fact 1건, 서로 다른 procedure body 2건, 서로 다른 required verification 2건을 같은 evaluator에 넣었다.

| 지표 | Baseline | W1 |
|---|---:|---:|
| Retrieval recall | 1.00 | 1.00 |
| Injection recall | 1.00 | 1.00 |
| Injection precision | 0.40 | **1.00** |
| Context token proxy | 406 | **224** |

중복 case에서 Baseline은 `duplicate-00`~`duplicate-09`와 `next-valid`을 모두 공급했다. W1은 가장 강한 representative인 `duplicate-09`와 `next-valid`만 공급했다. 즉 중복 9건이 제거됐지만 다음 유효 지식은 보존됐다.

Procedure case는 두 revision 모두 `procedure-a`, `procedure-b`를 유지했다. Verification case도 `verify-unit`, `verify-integration`을 둘 다 유지했다. 따라서 procedure body 차이나 required verification 의미를 canonical duplicate로 잘못 합치지 않았다.

**판정: PROMOTE.** current relevant knowledge recall을 낮추지 않고 duplicate noise를 제거했다.

### B — W2 scope/sourceRefs/freshness: PROMOTE

같은 candidate→canonical record→context load 경로에서 scope-only record와 explicit source record를 비교했다.

| case | W1 이전 | W2 이후 |
|---|---|---|
| scope-only record `sourceRefs` | `['src/auth/**']` | `[]` |
| scope-only context | `stale`, 선택 0건 | **`ready-populated`, 선택 1건** |
| explicit source record | `ready-populated` | `ready-populated` |

W2 이전에는 applicability glob인 `src/auth/**`가 freshness source로 복사돼 실제 filesystem path가 없다는 이유로 false stale이 발생했다. W2 이후 scope-only 지식은 source ref를 발명하지 않으며 정상 공급된다. 실제 `src/auth/service.ts`를 source로 가진 record는 전후 모두 정상이다.

기존 freshness 회귀와 W4 E2E는 missing source를 `freshness_stale`, changed digest를 `freshness_needs_deep_verify`로 계속 제외한다. 따라서 current knowledge 복구를 위해 stale gate를 약화한 것이 아니다.

**판정: PROMOTE.** current relevant knowledge retrieval을 복구하면서 stale/deep-verify 차단은 유지했다.

### C — W3 verification binding + promotion quality: PROMOTE

동일 persisted Run/verification fixture에서 W3 전후를 비교했다.

| 항목 | W2까지 | W3 |
|---|---|---|
| worker observation `acceptanceIds` | 없음 | **필수 필드** |
| worker observation `obligationIds` | 없음 | **필수 필드** |
| current verification | verified 1 | verified 1 |
| stale source verification | **verified 1** | **rejected 1** |
| sourceDigest-only candidate | **verified 1** | **rejected 1** |
| repeated generic blocker | `known_failure_pattern` | **`episodic_observation`** |

W3는 current source identity와 mutation revision에 맞는 persisted verification을 계속 인정한다. 반대로 stale verification과 arbitrary source digest 우회를 `MISSING_VERIFICATION_EVIDENCE`로 차단한다. Generic blocker도 반복 횟수만으로 durable failure pattern이 되지 않는다.

**판정: PROMOTE.** explicit evidence trust가 강화됐고 durable generic blocker noise가 줄었다. 정상 current verification은 손상되지 않았다.

## Gate 2 — Rework

이번 W5는 provider 모델을 새로 호출해 실제 tool-call, replan, correction-loop 수를 측정하지 않았다. 따라서 아래 항목은 provider 행동 수치로 해석하면 안 된다.

- W1은 context에서 동일 중복 9건을 제거했다. 같은 내용을 반복해서 읽게 만드는 입력 자체는 직접 감소했다.
- W2는 false stale 때문에 current knowledge가 사라지는 경로를 제거했다. 잘못된 stale 판정으로 인한 재탐색 가능성을 줄였지만 실제 search/read 횟수는 측정하지 않았다.
- W3는 stale proof와 digest-only trust를 차단하고 generic blocker를 episodic으로 유지한다. 잘못 승격된 durable knowledge가 후속 correction을 유발하는 경로를 줄였지만 실제 correction-loop 횟수는 측정하지 않았다.

즉 **구조적 rework 원인은 감소했고 회귀는 관측되지 않았지만, provider 행동량의 정량 개선은 unavailable**이다. 이 값을 0으로 대체하지 않는다.

## Gate 3 — Efficiency

정량 효율 이득은 W1에서만 직접 측정됐다. 동일 evaluator의 context-size proxy가 `406 → 224`로 **182 감소, 약 44.8% 감소**했다. Injection recall은 1.00으로 유지됐다.

W2와 W3의 핵심 목적은 context 축약이 아니라 correctness/trust 복구다. 해당 arm의 provider input token, output token, elapsed time, cache ratio, model usage는 비교 가능한 receipt가 없으므로 unavailable로 둔다. owner-session 전체 token을 Run metric으로 복제하지 않았다.

## 기존 evaluator와 넓은 회귀

기존 retrieval eval과 W1~W4 Knowledge 회귀를 포함한 Kernel 전체 `kernel-*.test.mjs` 파일은 총 280개다.

먼저 `npm run test:kernel`을 그대로 실행했지만 Moonremote command timeout으로 SIGTERM 종료됐다. 이는 assertion failure가 아니며 완료 증거로 사용하지 않았다. 이후 **동일하게 정렬한 280개 파일을 70개씩 네 shard**로 나눠 `node --test --test-concurrency=2`로 전부 다시 실행했다.

| shard | 파일 범위 | pass | fail | skip |
|---|---|---:|---:|---:|
| 1/4 | 0..69 | 376 | 0 | 0 |
| 2/4 | 70..139 | 354 | 0 | 0 |
| 3/4 | 140..209 | 383 | 0 | 4 |
| 4/4 | 210..279 | 415 | 0 | 8 |
| **합계** | **280 files** | **1,528** | **0** | **12** |

Skip은 환경 의존 native-provider smoke 등 기존 조건부 테스트다. 네 shard 모두 exit code 0이었다.

W4 공급 E2E도 이 회귀에 포함되어 `FRAME → EXECUTE → PROVE`에서 fresh/current/applicable knowledge 공급, stale/deep-verify 제외, canonical dedupe, procedure body 보존, required verification 보존을 다시 통과했다.

## 최종 판정

| Arm | Quality | Rework | Efficiency | 판정 |
|---|---|---|---|---|
| A / W1 | 개선 | 구조적 duplicate-read 원인 감소, provider 행동량 unavailable | **44.8% context proxy 감소** | **PROMOTE** |
| B / W2 | 개선 | false-stale 재탐색 원인 제거, provider 행동량 unavailable | unavailable | **PROMOTE** |
| C / W3 | 개선 | false durable/trust correction 원인 제거, provider 행동량 unavailable | unavailable | **PROMOTE** |

세 arm 모두 새 workflow stage, durable table, 별도 authority, 프로젝트별 hardcoding, compatibility fallback을 추가하지 않는다. 기존 Knowledge authority와 lifecycle 안에서 의미 경계를 수정한 변경이다.

W6 시작 조건인 **“W1~W4 구조 검증 완료 + W5 최소 한 arm PROMOTE + W0 current evidence interpretation 완료”**는 충족됐다.

## 근거

- 비교 worktree 실행: operation `bc7a192f-615e-47ee-a1d6-9ead7c95e469`
- 비교 결과 복구 및 대조: operation `a18fe749-9e4a-40a7-9b31-d373282d71db`
- W1 case별 injection/token 대조: operation `1c1a2b2a-751b-4f46-86c3-293fb45b15db`
- Kernel shard 1/4: operation `f3c1a18e-76b2-4fa3-937e-f0a72f6121eb`
- Kernel shard 2/4: operation `6580af8a-a750-440a-b1f8-285313132c49`
- Kernel shard 3/4: operation `3b7588ca-e7bd-4873-b6a6-5a3063101d73`
- Kernel shard 4/4: operation `0bd1438f-176e-4794-bc5e-ad53f37de944`

`/tmp/w5-result-*.json`은 local evaluation artifact이며 repository authority가 아니다. 최종 판정의 durable 기록은 이 문서와 각 revision의 source/test다.
