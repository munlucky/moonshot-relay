# Preset 08 — B3 Control Plane / State Store Thinning

## 목적

Control Plane은 coordinate, State Store는 persist/query/transaction 역할에 집중하도록 policy ownership을 실제 authority로 이동하고 dead path를 제거한다.

## Moonremote 실행 프롬프트

```text
Moonremote로 /shared/moonshot-relay main 브랜치에서 Preset 08만 수행해줘.

get_work_context를 먼저 조회하고 Preset 07 COMPLETE와 main/origin parity를 확인해.

현재 Control Plane과 State Store에서 다음을 전수 확인해:
- Work 의미 판단
- Trust/Evidence 의미 판단
- Knowledge 의미 판단
- domain/risk policy 판단
- provider/Host policy 판단

목표:
Control Plane = coordinate
State Store = persist/query/transaction
Work/Trust/Knowledge 의미 판단 = 각 authority owner

새 facade 계층을 추가하고 기존 분기를 그대로 두는 방식은 금지해.
authority 이동 후 old consumer, old branch, dead state를 실제로 제거해.
구/신 path 장기 compatibility layer를 만들지 마.

작업 전후:
- Control Plane policy branch 수
- State Store policy branch 수
- duplicate authority
- writable state
- 관련 LOC
를 비교해.
LOC 감소 자체를 성공 조건으로 쓰지 마.

focused authority/state tests, boundary tests, typecheck/build check를 실행해.
구조 리뷰에서 policy가 단순히 다른 파일로 이동했을 뿐인지 확인해.

STATUS.md 갱신 후 한국어 상세 commit, main push, origin/main parity 확인 후 종료해.
```

## Acceptance

- Control Plane이 coordinator 역할로 축소
- State Store가 domain decision을 소유하지 않음
- Work/Trust/Knowledge owner가 명확
- 기존 dead branch/state 실제 삭제
- 새 facade/compatibility layer로 복잡도 이동 없음

## 커밋 제목 예시

`refactor(kernel): control plane과 state store의 정책 소유권 축소`
