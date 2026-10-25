# Preset 06 — A6+A7 Usage Receipt Repair + Historical Replay

## 목적

Host usage receipt lineage를 복구하고 A단계 전체 효과를 historical replay로 검증한다.

이 프리셋은 A단계 통합 gate다.

## Moonremote 실행 프롬프트

```text
Moonremote로 /shared/moonshot-relay main 브랜치에서 Preset 06만 수행해줘.

get_work_context를 먼저 조회하고 Preset 05까지 COMPLETE 및 origin/main parity를 확인해.

Part A — Usage Receipt:
현재 Host dispatch → provider execution → usage receipt → attempt → run 경로를 추적해.
끊어진 reference만 복구해.
최소 확인:
- provider
- model
- input tokens
- cached input tokens
- output tokens
- wall time
- execution class/route
- attempt
지원되지 않는 값은 unknown으로 유지하고 추정하지 마.
새 telemetry table/exporter/provider-specific Kernel cost policy를 만들지 마.

Part B — Historical Replay:
Preset 01 fixture와 기존 historical corpus의 대표 subset으로 A1~A6 효과를 비교해.

비교:
- 동일 Proof 반복 횟수
- binding recovery 횟수
- generic failure Knowledge 후보 수
- usable verified Knowledge 수
- usage receipt coverage
- task/completion success
- false completion

다음이 악화되면 B단계로 진행 가능한 상태로 표시하지 마:
- false completion 증가
- stale proof 재사용 증가
- project knowledge leakage
- scope safety 약화
- normal work completion rate 하락

이번 프리셋에서는 A단계 통합 회귀를 수행해.
focused tests뿐 아니라 계획에서 정한 A단계 전체 regression gate도 실행해.

결과를 문서화하고 STATUS.md를 갱신해.
검증 완료 후 한국어 상세 commit, main push, origin/main parity 확인 후 종료해.
B1/B2는 시작하지 마.
```

## Acceptance

- representative Codex execution의 usage receipt가 attempt/run lineage에 연결
- A단계 기능 비열화 없음
- 의미 없는 Proof 반복 감소
- generic failure Knowledge 감소
- usable Knowledge 및 usage coverage 개선 또는 최소 유지
- B단계 진입 가능 여부가 evidence로 판정됨

## 커밋 제목 예시

`test(kernel): 실행 연속성과 지식 개선의 historical replay 결과 고정`
