# Harness Improvement Loop — Historical Corpus Baseline

기준선: `main / be16c1e1`
조사일: 2026-10-20
범위: 로컬 Codex / Kernel 실행 이력의 읽기 전용 조사와 첫 개선 후보 판정

## 결론

첫 production 개선 대상으로 Kernel workflow를 다시 수정하지 않는다.

현재 로컬에는 개선 루프를 시작하기에 충분한 실제 이력이 이미 있다.

- Codex active session files: 4,558
- Codex archived session files: 2
- Kernel runs: 391
- attempts: 1,101
- verifications: 3,298
- completion decisions: 319
- model usage receipts: 200
- knowledge candidates: 2,381
- knowledge records: 1,990

따라서 첫 작업은 새 평가 플랫폼을 만드는 것이 아니라 다음 세 source를 하나의 read-only historical work case로 정규화하는 것이다.

1. Codex session/thread history
2. Kernel run / verification / model usage receipt
3. Git source revision / workspace identity

## 첫 후보 판정

### CANDIDATE — Historical corpus normalization

문제:
실제 작업 데이터는 충분하지만 Codex session, Kernel run, Git revision이 서로 다른 identity로 흩어져 있다.

영향:
반복 실패와 비용 집중을 집계할 때 같은 작업을 중복 계산하거나, 오래된 generation의 문제를 현재 결함으로 오판할 수 있다.

변경 seam:
Host/offline evaluation tooling만 사용한다. Kernel runtime, public command, workflow stage, DB schema는 변경하지 않는다.

완료 조건:
- 동일 실제 작업을 가능한 범위에서 하나의 HistoricalWorkCase로 연결
- source generation / source revision 보존
- 누락 telemetry는 null/unknown 유지
- runtime DB와 Codex history를 수정하지 않는 read-only 수집
- current-generation relevance 판정 가능

### CANDIDATE — Generation-aware evidence coverage report

문제:
2026-10-19에 prompt/action telemetry가 추가됐지만 그 이후 comparable completed run이 아직 없다.

영향:
Context/Action 최적화를 지금 적용하면 측정 없는 추측이 된다.

판정:
production 변경이 아니라 corpus 분석 capability 후보로 유지한다.
새 completed run이 쌓이면 자동으로 coverage와 residual bottleneck을 다시 계산할 수 있어야 한다.

### RESOLVED / DEFER — Verification 반복 비용

역사적 20-run 표본에서 verification 619건, 상위 3 run이 59.9%를 차지했다.

그러나 2026-10-16 verification/reuse 정합화 이후 W2 표본의 completed run 4개는 모두 verification 1건이었다.
현재 source에는 exact evidence reuse, same-report proof coalescing, stale/flaky/fresh 구분이 이미 있다.

판정:
현재 production을 다시 수정하지 않는다.
fresh comparable run에서 exact reusable evidence가 있는데도 반복 execution이 확인될 때만 재개한다.

### RESOLVED / REJECT — Prompt Diet 추가 축약

최근 Prompt A/B 결과는 keep-baseline으로 종료됐다.
현재 근거로 prompt를 더 줄이면 품질 인과 효과가 입증되지 않은 상태에서 다시 최적화하는 셈이다.

판정:
재제안하지 않는다. 새로운 단일 변수 evidence가 생길 때만 별도 candidate로 평가한다.

### RESOLVED — Codex model profile 중복 하드코딩

현재 HEAD `be16c1e1`에서 Codex 모델 프로필 중복 하드코딩 제거가 완료됐다.

판정:
historical observation으로 보존하되 active candidate로 만들지 않는다.

## 첫 구현 방향

새 workflow engine, scheduler, evaluation DB, Kernel table을 만들지 않는다.

기존 자산을 재사용한다.

- `src/host-tooling/kernel-eval/model-prompt-replay.ts`
- `src/host-tooling/kernel-public/optimization-cycle.ts`
- 기존 Kernel SQLite receipts
- Codex local session/thread history
- Git revision

새 기능은 Host/offline 경계의 작은 read-only corpus loader/normalizer로 제한한다.

## 복잡도 예산

- Kernel public command 증가: 0
- Kernel workflow stage 증가: 0
- Kernel DB table 증가: 0
- model-visible field 증가: 0
- provider fallback 증가: 0
- project-specific heuristic 증가: 0
- 새 evaluation authority: 0

## 다음 단계

1. HistoricalWorkCase 최소 schema를 기존 eval contract와 대조한다.
2. Codex session ↔ Kernel run ↔ Git identity 연결 규칙을 정의한다.
3. 실제 로컬 데이터로 inventory를 생성한다.
4. 반복 문제를 RESOLVED / DEFERRED / CANDIDATE로 자동 분류하지 않고, 근거를 함께 산출한다.
5. 첫 current candidate를 기존 replay 경로로 검증한다.
