# W6 결과 — Receipt/Evidence 영속 중복 및 원자성

- 기준: `main / 4bd47194` (W5 영속 Knowledge 의미 충돌 수정).
- 판정: **KEEP/NO-CHANGE (검증 범위)**. 확인한 신뢰 데이터의 무조건 축소는 보류한다. Byte/CPU 개선 성과를 주장하지 않는다.

## W0 일관성 백업 read-only 계측

`file:...?mode=ro` 및 SQLite `PRAGMA query_only=ON`으로 W0 Online Backup(약 217MiB)을 조사했다. 단위는 SQLite `length(JSON column)` 합계이며 DB 페이지 사용량과 다르다.

| 영속 테이블/필드 | Rows | JSON bytes |
|---|---:|---:|
| `knowledge_context_receipts.receipt_json` | 1,608 | 64,368,173 |
| `run_step_attempts.report_checkpoint_json` | 1,319 attempts | 32,945,682 |
| `run_step_attempts.report_result_json` | 1,319 attempts | 13,983,972 |
| `evidence_packs.pack_json` | 1,785 | 39,082,005 |
| `finalization_receipts.receipt_json` | 397 | 21,586,100 |

여러 Receipt의 크기가 큰 것은 확인됐지만, 이것만으로 동일 payload의 이중 직렬화나 복구에 불필요한 내용이라는 인과는 증명하지 못한다. `run_step_attempts`는 `run_id` 조회 인덱스, Finalization은 `run_id` 고유 인덱스를 사용한다. Evidence Pack `run_id` 조회의 query plan은 SCAN이며, 1,785개 행에서 실제 성능 악화나 새 인덱스 이익이 측정되지 않아 임의 생성하지 않았다.

## 신뢰 회귀

- SQLite Adapter Contract, State Authority, Evidence Pack, Finalization Report Resume, State Projection, Knowledge Transaction Recovery: **21/21 PASS** (격리 Linux HOME/Runtime).
- 기존 감사 원본·Recovery Checkpoint·완료 authority를 보존한다. WAL/busy timeout·DB schema·새 reference writer·migration은 추가하지 않는다.
- 실제 read/parse/serialise 비용 감소 및 구형 데이터 crash/replay 동등성이 확인되는 후보가 없으므로 성급한 압축 대신 **KEEP/NO-CHANGE** 판정. W7에서는 조회 시 필터/랭킹/선택만 별도 측정한다.

전체 W0~W10의 최종 PASS와 운영 DB 물리 크기 감소는 선언하지 않는다.
