# C30 Projection interoperability 가치 판정

판정: **진행. C31에서 `scripts/knowledge-context-build.mjs` 한 consumer만 연결한다.**

## 실제 consumer

대상 consumer는 `scripts/knowledge-context-build.mjs`다. 이 도구는 account-root project knowledge를 stage별 prompt context로 만드는 현재 runtime consumer다.

현재 consumer의 파일 계약은 `policy/policy-anchors.jsonl`, `semantic/verified-facts.jsonl`, `graph/kg-relations.jsonl`, `ontology/constraints.jsonl`이다. 반면 canonical SQLite Knowledge의 현재 projection은 `policy/anchors.jsonl`, `semantic/facts.jsonl`, `graph/relations.jsonl`, `ontology/constraints.jsonl`을 modern derived projection으로 쓴다.

## 재현된 문제

canonical Knowledge record는 `status=committed`, `trustTier=verified`, `statement` 중심이다. `knowledge-context-build.mjs`는 오래된 타입별 JSONL 계약과 파일별 expected type으로 읽는다.

SQLite에 policy anchor를 저장하고 `rebuildKnowledgeProjection()`을 실행한 뒤 같은 knowledge root를 context builder가 읽도록 한 fixture에서 다음을 확인했다.

- canonical projection 생성 성공
- compatibility `semantic/verified-facts.jsonl`에 대상 policy anchor 존재
- context `policyAnchors`와 `semanticFacts`에는 대상 record 없음
- context status는 `degraded_read`
- canonical `policy_anchor status=committed`가 legacy policy contract와 맞지 않아 read error 발생

`scripts/architecture-knowledge-resolve.mjs`는 mixed compatibility file의 실제 record type을 보존해 같은 anchor를 읽을 수 있으므로, C31 범위는 실패가 재현된 context builder 하나로 제한한다.

## 필요한 데이터와 기존 export 부족

새 Knowledge authority나 새 serialization 계층은 필요하지 않다. modern projection에 이미 `id`, `projectId`, `type`, `statement`, `status`, `trustTier`, scope/source/freshness provenance 및 `revision.json`이 있다.

부족한 것은 export 데이터가 아니라 **consumer adapter**다. legacy DTO를 canonical record에서 새로 합성하면 type별 required field와 status 변환 규칙이 늘어나므로 C31에서는 기존 modern projection을 consumer가 직접 읽도록 한다.

## 예상 이득

- SQLite canonical Knowledge에서 재생성된 projection이 실제 prompt consumer까지 연결된다.
- legacy DTO 변환 하드코딩을 추가하지 않는다.
- projection 삭제/변조는 derived artifact 문제로 남고 SQLite authority를 바꾸지 않는다.
- 기존 legacy 직접 작성 fixture는 기존 경로로 계속 읽는다.
- revision/source/freshness provenance는 기존 canonical payload와 revision manifest를 사용한다.

## C31 허용 범위

- `scripts/knowledge-context-build.mjs`: modern canonical projection layout adapter
- 관련 projection/context integration tests
- projection source 자체는 기존 export가 충분하면 변경하지 않는다.

다른 Host consumer, provider, vector DB, sync service, schema migration, 양방향 sync를 추가하지 않는다.
