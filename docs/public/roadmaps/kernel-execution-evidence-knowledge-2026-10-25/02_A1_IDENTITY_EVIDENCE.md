# Preset 02 — A1 Identity + Evidence Semantics

## 선행 조건

Preset 01 COMPLETE 및 origin/main parity 확인.

## 목적

Project / Workspace / Runtime identity를 구분하고 Evidence merge 의미를 현재 Trust Authority owner로 수렴한다.

## Moonremote 실행 프롬프트

```text
Moonremote로 /shared/moonshot-relay main 브랜치에서 Preset 02만 수행해줘.

START_HERE.md 규칙을 따르고 get_work_context를 먼저 조회해.
Preset 01이 COMPLETE이고 origin/main parity가 맞는지 확인해.

현재 source에서 Project Identity, Workspace Identity, Runtime Identity,
Evidence merge의 실제 owner를 먼저 찾고 과거 문서 경로를 가정하지 마.

구현 목표:
1. 기존 Project Identity authority 재사용
2. 같은 project의 서로 다른 worktree를 다른 Workspace Identity로 유지
3. Runtime alias/path normalization은 Host 책임으로 유지
4. authority 판정에 raw path equality가 직접 사용되는 경로 제거
5. Evidence 비교는 동일 Evidence Identity 안에서만 수행
6. unobserved/weaker observation이 기존 VERIFIED를 파괴하지 않게 함
7. source identity가 바뀌면 과거 VERIFIED는 역사적으로 보존하되 현재 completion evidence로 사용하지 않음

새 canonicalIdentity subsystem, alias registry, fallback chain을 만들지 마.
기존 receipt/digest/obligation/mutation/source binding을 최대한 재사용해.

필수 회귀:
- same identity + unobserved → VERIFIED 유지
- same identity + weaker observation → VERIFIED 유지
- same identity + authoritative contradiction → 갱신
- source identity 변경 → 과거 evidence 보존 + 현재 evidence required
- same project + different worktree → 다른 workspace identity
- runtime alias → 동일 canonical runtime identity

focused tests와 필요한 typecheck/build freshness만 수행해.
구조 리뷰에서 hardcoding/fallback/duplicate authority 증가가 없는지 확인해.
STATUS.md 갱신 후 한국어 상세 commit, main push, origin/main parity를 확인하고 종료해.
다음 프리셋은 시작하지 마.
```

## Acceptance

- Evidence merge owner가 하나로 수렴
- source 변경이 과거 VERIFIED를 FAILED로 오염시키지 않음
- stale evidence가 현재 completion에 사용되지 않음
- Host runtime normalization과 Kernel trust 판정 경계가 명확
- 새 identity 저장 subsystem 없음

## 커밋 제목 예시

`refactor(kernel): identity와 evidence 병합 의미를 authority 경계로 수렴`
