# Preset 01 — A0 Characterization Freeze

## 목적

실제 구현 전에 이번 개선이 해결해야 할 대표 failure와 현재 authority owner를 최소 fixture로 고정한다.

이 프리셋에서는 production behavior를 변경하지 않는다.

## Moonremote 실행 프롬프트

```text
Moonremote로 /shared/moonshot-relay main 브랜치에서 Preset 01만 수행해줘.

먼저 get_work_context(cwd=/shared/moonshot-relay)를 조회해.
다른 목적의 active task가 있으면 hijack하지 말고 실행을 시작하지 마.
현재 프리셋 task가 없을 때만 checkpoint를 생성해.

작업 시작 전에 main, HEAD, origin/main parity, staged/unstaged 변경,
running/unsettled process, 최근 validation evidence를 확인해.

범위:
- 반복 failed proof
- workspace continuity mismatch
- runtime binding stale
- host binding missing
- environment execution failure
- generic known_failure_pattern promotion
- stale knowledge selection
- usage receipt missing

각 항목의 현재 owner와 실제 source 경로를 확인하고,
historical dataset 전체가 아니라 failure class별 최소 representative fixture만 고정해.
기존 fixture/test가 충분하면 새 fixture를 만들지 마.

production 동작은 바꾸지 마.
새 fallback, 새 registry, 새 state, 새 workflow stage를 만들지 마.

focused characterization test를 실행하고 결과를 기록해.
구조 리뷰 후 STATUS.md를 갱신해.

검증이 끝나면 한국어 상세 commit을 만들고 main에 push해.
origin/main과 local HEAD parity를 확인한 뒤 이 프리셋만 complete_work로 종료해.
다음 프리셋은 시작하지 마.
```

## 산출물

- 대표 failure fixture 또는 기존 fixture 참조
- authority owner map
- baseline 결과
- 다음 프리셋에서 수정해야 할 정확한 source owner

## Acceptance

- 각 핵심 failure가 재현 또는 구조적으로 관측 가능
- production behavior 변경 없음
- historical corpus 전체 복제 없음
- 새 special-case 없음
- fixture가 실제 후속 regression 기준으로 사용 가능

## 권장 검증

현재 owner test를 우선한다.

최소:

- fixture 관련 focused tests
- `npm run typecheck`
- 필요한 generated test freshness check
- `git diff --check`

## 커밋 제목 예시

`test(kernel): 실행 연속성과 지식 병목의 회귀 기준 고정`
