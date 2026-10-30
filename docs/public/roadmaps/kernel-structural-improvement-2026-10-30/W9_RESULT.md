# W9 결과 — Proof·Prompt·Context·Next 비용 계측

- 기준 HEAD `8d4ac071`, W8 Linux/source 및 native Host PARTIAL 유지.
- 판정: **KEEP/NO-CHANGE**. 검증 안전성을 보존하며 실측으로 개선이 입증되지 않은 추가 최적화는 제외한다.

## 검증

`kernel-next-purity`, `kernel-efficiency-telemetry`, `kernel-session-affinity`, `kernel-prompt-envelope`, `kernel-cache-replay`, `kernel-cache-usage-receipt`, `kernel-evidence-semantics` **50/50 PASS**. 실제 Proof 실패는 완료를 승인하지 않고, source/mutation 변경 시 유효하지 않은 증명은 재승인하지 않는다. Cache 및 사용량 Receipt 입력의 의미는 회귀로 보존했다.

## 동일 입력 read-path 벤치마크

격리 Linux Runtime에서 `baselineRequired=true`인 동일 Run에 대해 `next`를 65회 실행(선행 5회 버림), 실제 60회 `performance.now()` 측정. 결과 action은 매번 동일했다.

- `next` **p50 11.154ms, p95 18.661ms**, Action 안정성 PASS.
- 이 값은 **한 버전의 관측**으로, 변경 전/후 인과 A/B가 아니다. 새로운 cache/schema/proof skip을 유지할 근거가 없다.
- `request → first valid edit → required proof → accepted → delivery`의 실제 Provider/사용자 End-to-End 벽시계 지표, 실제 `cached_input_tokens`/`input_tokens`는 이 격리 실행에서 보고되지 않았다. `null`은 0 토큰 또는 0 비용을 의미하지 않는다.
- 같은 source/command/evidence/환경의 엄격한 동등성을 검증하지 않고 Proof를 캐싱하거나 건너뛰지 않는다. 모델 선택/effort/fallback 규칙도 추가하지 않았다.

**결론:** 안전·결과 관련 테스트 PASS, 비용 개선 성과는 **미입증**으로 기록. 현재 생산 코드·상시 Prompt·캐시 정책 유지. W10에서 통합 회귀를 실시한다.
