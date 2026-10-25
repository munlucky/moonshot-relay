# Preset 05 — A5 Knowledge Reuse

## 목적

verified Knowledge가 다음 Run에서 실제로 재사용되도록 하되 semantic validity와 provenance freshness를 혼동하지 않는다.

## Moonremote 실행 프롬프트

```text
Moonremote로 /shared/moonshot-relay main 브랜치에서 Preset 05만 수행해줘.

get_work_context를 먼저 조회하고 Preset 04 완료와 main/origin parity를 확인해.

현재 knowledge retrieval, freshness, stale, supersession, trust tier, scope owner를 조사해.
historical knowledge 중 stale 처리되는 대표 사례를 다음으로 구분해:
- semantic invalidation
- provenance freshness mismatch
- path relocation
- source evolution

구현 목표:
1. semantic validity와 provenance freshness를 분리
2. trust-critical verification knowledge는 필요한 current source binding을 요구
3. reusable architecture/project fact는 단순 path relocation만으로 영구 폐기하지 않음
4. typed knowledge, scope, supersession, trust tier, revision을 재사용
5. path-specific fallback을 추가하지 않음
6. SQLite/candidate/review/commit lifecycle은 재설계하지 않음

E2E:
Run A에서 reusable verified knowledge commit
→ Run B 관련 objective/scope에서 실제 selection

source-bound verification knowledge는 source 변경 후 current trust evidence 없이 completion proof로 사용되면 안 됨.

새 freshness taxonomy, vector store, path alias fallback을 만들지 마.

focused retrieval/cross-run tests와 필요한 typecheck/build check를 실행해.
구조 리뷰 후 STATUS.md 갱신, 한국어 상세 commit, main push, parity 확인 후 종료해.
```

## Acceptance

- Run A → Run B 재사용 확인
- path relocation과 semantic invalidation 구분
- trust-critical stale knowledge 오사용 없음
- project namespace isolation 유지
- retrieval을 위해 새 subsystem 추가 없음

## 커밋 제목 예시

`fix(knowledge): 현재 유효 프로젝트 지식의 cross-run 재사용 복구`
