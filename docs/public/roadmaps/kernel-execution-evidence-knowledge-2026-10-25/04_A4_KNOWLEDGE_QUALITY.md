# Preset 04 — A4 Knowledge Quality

## 목적

generic failure가 durable Knowledge corpus를 압도하는 경로를 차단한다.

기존 candidate → review → commit → revision lifecycle은 유지한다.

## Moonremote 실행 프롬프트

```text
Moonremote로 /shared/moonshot-relay main 브랜치에서 Preset 04만 수행해줘.

get_work_context와 main/origin parity를 먼저 확인하고 Preset 03이 COMPLETE인지 확인해.

현재 known_failure_pattern candidate 생성, normalization, dedupe, review, commit owner를 찾는다.

다음 품질 기준을 구현해:
known_failure_pattern은 최소한
- reproducible failure fingerprint
- identified cause
- applicable scope
- verified resolution 또는 prevention
을 가져야 durable candidate로 인정할 수 있다.

자동 durable candidate에서 제외:
- 일회성 test failure
- 일반 compile failure
- temporary environment failure
- owner interruption
- timeout 자체
- 단순 error message
- generic unsupported verification

반복 횟수 N만으로 durable promotion하지 마.

dedupe에서 다음 의미가 다르면 합치지 마:
- scope
- sourceRefs
- verification commandRefs
- resolution
- procedure steps
- semantic type

기존 project boundary와 evidence binding을 유지해.
새 Knowledge subsystem/table/lifecycle을 만들지 마.

필수 테스트:
- generic compile failure → durable candidate 아님
- temporary host failure → durable candidate 아님
- reproducible pattern + cause + verified resolution → review 가능
- same message + different scope → 별도 candidate
- exact semantic duplicate → 억제

focused knowledge tests 후 구조 리뷰를 수행해.
검증 완료 후 STATUS.md 갱신, 한국어 상세 commit, main push, parity 확인 후 종료해.
```

## Acceptance

- generic failure candidate 비율이 baseline보다 감소
- 재사용 가능한 failure pattern은 보존
- semantic distinction 손실 없음
- 기존 review/commit authority 유지

## 커밋 제목 예시

`fix(knowledge): 일반 실패의 durable knowledge 과잉 승격 차단`
