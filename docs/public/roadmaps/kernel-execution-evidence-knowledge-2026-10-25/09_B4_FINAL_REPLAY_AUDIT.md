# Preset 09 — B4 Final Replay + Complexity Audit

## 목적

전체 개선을 기능 안전성과 복잡도 감소 두 축으로 최종 판정한다.

이 프리셋에서는 새 기능을 추가하지 않는다.
발견된 문제가 최종 회귀를 막는 실제 결함일 때만 최소 수정한다.

## Moonremote 실행 프롬프트

```text
Moonremote로 /shared/moonshot-relay main 브랜치에서 Preset 09만 수행해줘.

get_work_context를 먼저 조회하고 Preset 08 COMPLETE와 main/origin parity를 확인해.

전체 계획의 최종 replay와 complexity audit만 수행해.

기능 비교:
- 작업 완료율
- Proof 성공률
- 중단 후 resume
- false completion
- Knowledge cross-run reuse
- scope/workspace safety
- project namespace isolation
- usage receipt lineage

복잡도 비교:
- policy branch 수
- special-case regex 수
- fallback 수
- model-visible instruction 수
- duplicate authority 수
- Control Plane policy branch 수
- State Store policy branch 수
- 새 public command/stage/provider-specific Kernel branch 존재 여부

Negative Complexity Budget 위반이 있으면 완료하지 마.

대표 historical fixture와 전체 regression suite를 실행해.
환경 제한은 Host limitation으로 명확히 분리해.

Stop Rule:
- 대표 failure가 새 special-case 없이 해결됨
- completion safety 비열화 없음
- 동일 proof 반복 감소
- binding/environment recovery 감소
- generic failure Knowledge 감소
- usable current Knowledge 증가
- usage receipt coverage 복구
- duplicate authority 감소
- model-visible 규칙 감소

필요한 최종 문서와 STATUS.md를 갱신해.
실제 수정이 있으면 한국어 상세 commit을 만들고 main push해.
문서/검증 갱신만 있어도 변경이 있다면 commit/push해.
origin/main parity를 확인한 뒤 전체 로드맵을 완료 판정하고 complete_work로 종료해.
```

## Acceptance

- 전체 regression 통과 또는 명확히 설명된 Host limitation만 존재
- false completion 증가 없음
- stale evidence 오사용 없음
- knowledge leakage 없음
- Negative Complexity Budget 위반 없음
- 전체 Stop Rule 충족
- local main == origin/main

## 최종 판정 형식

```text
EXECUTION CONTINUITY = PASS/FAIL
EVIDENCE SEMANTICS = PASS/FAIL
KNOWLEDGE QUALITY = PASS/FAIL
KNOWLEDGE REUSE = PASS/FAIL
USAGE LINEAGE = PASS/FAIL
DECOMPLEXIFICATION = PASS/FAIL
REMOTE PARITY = PASS/FAIL
OVERALL = COMPLETE / BLOCKED
```

## 커밋 제목 예시

`test(kernel): 실행 연속성 및 decomplexification 최종 회귀 검증`
