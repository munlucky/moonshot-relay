# Preset 03 — A2+A3 Proof Delta + Failure Ownership

## 선행 조건

Preset 02 COMPLETE.

## 왜 한 프리셋으로 묶는가

Proof 재실행 판단과 failure ownership은 같은 Trust/Host 실행 경로를 건드린다.
둘을 분리하면 중간 compatibility 상태와 중복 result mapping이 생길 가능성이 높다.

## Moonremote 실행 프롬프트

```text
Moonremote로 /shared/moonshot-relay main 브랜치에서 Preset 03만 수행해줘.

get_work_context를 먼저 조회하고 main/origin parity와 Preset 02 완료 상태를 확인해.

Part A — Evidence Delta:
- 기존 proof reuse / evidence identity owner를 찾는다.
- 이전 failed proof와 현재 proof identity가 같고 meaningful delta가 없으면 executor를 자동 재호출하지 않는다.
- source/artifact/fixture/verifier/relevant environment/obligation 변화가 있으면 재실행한다.
- retry/timeout은 resource protection 역할로만 유지한다.
- same failure count 같은 correctness rule을 추가하지 않는다.

Part B — Failure Ownership:
- Product/Verification failure는 현재 Work Unit에서 구현 수정으로 돌아간다.
- Kernel authority/identity failure만 Kernel recovery 의미를 가진다.
- Host/environment failure는 Host observation/route 문제로 유지한다.
- 기존 result/error type을 우선 재사용하고 새 stage/recovery engine은 만들지 않는다.
- 필요하면 ownership metadata는 product/kernel/host 수준의 최소 표현만 허용한다.

필수 테스트:
- identical failed proof + no delta → executor 재호출 없음
- source/fixture/verifier/environment delta → 재실행
- compile/test failure → Work 유지
- workspace authority mismatch → Kernel failure
- CLI/tool unavailable → Host failure
- Host failure가 durable Knowledge 또는 Kernel policy로 자동 승격되지 않음

focused tests를 수행하고 구조 리뷰를 해.
새 retry engine, failure registry, error-string rule, OS별 branch가 생기면 COMPLETE로 판정하지 마.

검증 후 STATUS.md 갱신, 한국어 상세 commit, main push, origin/main parity 확인 후 종료해.
```

## Acceptance

- correctness와 retry/resource policy가 분리됨
- 입력 변화 없는 failed proof 반복 감소
- product/kernel/host ownership이 recovery path에서 섞이지 않음
- environment failure가 Kernel core rule로 승격되지 않음

## 커밋 제목 예시

`refactor(kernel): evidence delta와 실패 책임 경계를 실행 의미에 맞게 정리`
