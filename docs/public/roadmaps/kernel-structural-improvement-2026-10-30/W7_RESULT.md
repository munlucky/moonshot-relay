# W7 결과 — Knowledge/Context 조회 및 관련성

- 기준 `main / 30b49cf4` (W6 상태). 판정 **KEEP/NO-CHANGE**: 관련성·Byte Identity 검증 PASS, 새 영속 Cache/Index의 품질·속도 개선 미입증.

## 기존 Context 신뢰 경계

- `listKnowledgeRecords`는 `project_id`와 `status`로 먼저 SQL 필터링한다. 실제 운영 백업의 SQLite query plan도 `sqlite_autoindex_knowledge_records_1 (project_id=?)`를 사용한다. 이후 기록 JSON을 파싱하고 stage/freshness/rank·`canonical_duplicate`를 적용한다.
- `kernel-stage-knowledge-remediation`, `kernel-knowledge-stable-segment`, `kernel-knowledge-freshness-load`, `kernel-context-record-order`, `kernel-context-byte-identity`, `kernel-context-compiler`, `kernel-knowledge-reuse-e2e`, `kernel-knowledge-context`: **42/42 PASS**. 같은 revision/scope의 안정적인 순서와 byte identity를 검증한다.

## W0 Online Backup 조회 비용 표본 (읽기 전용)

`knowledge_records`에서 프로젝트별 동일 조건(`status IN ('verified','committed')`)의 SQL 조회와 Python `json.loads`를 **60회 측정**했다(선행 2회 워밍업). Linux 공유 마운트 SQLite read-only, 로컬 Python/SQLite 메서드 시간으로서 Kernel JS 전체 실행 wall time과 동일하지 않다.

| 프로젝트별 기록 수 | SQL read p50/p95 | JSON parse p50/p95 | JSON 합계 |
|---:|---:|---:|---:|
| 1,670 | 3.221 / 4.582ms | 13.194 / 20.280ms | 1,570,149 bytes |
| 120 | 0.229 / 0.449ms | 1.132 / 1.633ms | 242,686 bytes |
| 1 | 0.006 / 0.015ms | 0.006 / 0.010ms | 2,111 bytes |

큰 프로젝트의 전체 JSON 파싱 비용은 실제 존재한다. 그러나 stage별 DB projection으로 줄일 수 있는 바이트/관련성·Trust 동등성과 전체 작업 지연 개선은 측정하지 않았다. 잘못된 Knowledge 선택·부적절한 기록 누락 없이 더 작은 SQL을 구성할 구체 입력이 없어 신규 타입 필터/인덱스/캐시를 현재 도입하지 않는다. 1,915개 과거 failure record 정리는 W5-B 선택 보류를 따른다.

**결론:** Context relevance, trust 및 Byte Identity 검증 범위 SOURCE PASS; 성능 최적화 **KEEP**. 원본 캐시 무효화 권위나 프로젝트별 별도 특례를 추가하지 않았다. W9에서 실제 Kernel `next`/proof/prompt 시간을 따로 검증한다.
