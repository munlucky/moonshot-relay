# Preset 07 — B1+B2 Domain/Risk Authority + Capability/Prompt Reduction

## 선행 조건

Preset 06 replay가 B단계 진입 가능으로 판정되어야 한다.

## 목적

같은 종류의 규칙이 다시 쌓이는 구조를 줄인다.
domain/risk 의미의 중복 owner와 model-visible 운영 규율을 함께 축소한다.

## Moonremote 실행 프롬프트

```text
Moonremote로 /shared/moonshot-relay main 브랜치에서 Preset 07만 수행해줘.

get_work_context를 먼저 조회하고 Preset 06 replay 결과가 B단계 진입 가능인지 확인해.

Part A — Domain/Risk authority:
domain policy, proof policy, protected obligations, Host risk/model policy의 실제 owner를 조사해.
동일 risk/obligation 의미를 둘 이상의 subsystem이 독립 판단하면
Task/Work Contract + Verified Project Knowledge → Trust Authority 집행 구조로 수렴시켜.

프로젝트 domain keyword/path regex를 Kernel core에서 제거 가능한지 검토해.
새 Risk DSL, 새 classifier, 새 taxonomy는 만들지 마.

Part B — Capability/Prompt:
capability resolver/guidance, common execution prompt, moon-relay-kernel SKILL,
provider profile rules의 중복 지침을 조사해.

Host default 또는 diagnostic docs로 내릴 후보:
- 도구 사용 순서
- 대기 시간
- 파일 읽기 방법
- retry 횟수
- 운영상의 미세 팁

모델-visible 계약은 가능한 한
Objective / Acceptance / Constraints / Current Work / Relevant Knowledge / Required Evidence
로 축소해.

provider별 정책을 Kernel core에 넣지 마.
새 always-on 지침을 추가하지 마.

before/after로 다음을 측정해:
- duplicate authority 수
- model-visible instruction 수 또는 token 근사
- policy branch 수
- special-case regex 수

focused tests와 prompt/profile regression을 실행해.
구조 리뷰 후 STATUS.md 갱신, 한국어 상세 commit, main push, parity 확인 후 종료해.
```

## Acceptance

- 동일 risk/obligation 의미의 owner 중복 감소
- 모델-visible 운영 규칙 감소
- completion safety와 protected obligation 동작 유지
- 새 classifier/DSL/provider-specific Kernel branch 없음

## 커밋 제목 예시

`refactor(kernel): 중복 위험 권위와 모델 실행 지침 축소`
