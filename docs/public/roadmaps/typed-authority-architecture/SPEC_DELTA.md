# 현재 계약과 목표 변경

Current baseline: e328127. 아래는 Migration 제안이며 현재 구현된 결과가 아니다. public wire/DB 의미는 기본 보존한다.

| Delta ID | Requirement IDs | 변경 | Compatibility / Rollback |
| --- | --- | --- | --- |
| DELTA-001 | REQ-001 | 기능·writer·payload의 소유권을 빠짐없이 지정한다. | 공개 동작 fixture 보존; 마지막 통과 slice로 복구 |
| DELTA-002 | REQ-002 | 계약을 한 정의에서 생성하고 strict TS와 입력 검증을 연결한다. | 공개 동작 fixture 보존; 마지막 통과 slice로 복구 |
| DELTA-003 | REQ-003 | Work를 세로 전환하고 resume·cursor·scope·CAS를 보존한다. | 공개 동작 fixture 보존; 마지막 통과 slice로 복구 |
| DELTA-004 | REQ-004 | Trust가 증거·review·completion 수락을 독점하고 closeout 근거와 일치한다. | 공개 동작 fixture 보존; 마지막 통과 slice로 복구 |
| DELTA-005 | REQ-005 | Knowledge의 SQLite 권위와 승인·revision·supersession을 보존한다. | 공개 동작 fixture 보존; 마지막 통과 slice로 복구 |
| DELTA-006 | REQ-006 | Host가 외부 실행을 소유하고 Kernel은 provider 독립 계약을 사용한다. | 공개 동작 fixture 보존; 마지막 통과 slice로 복구 |
| DELTA-007 | REQ-007 | Control Plane과 persistence를 분리하며 원자성·idempotency를 유지한다. | 같은 DB transaction 유지; slice별 source 복구 |
| DELTA-008 | REQ-008 | 표준 ESM artifact를 기존 공개 진입점으로 설치하고 실행한다. | 기존 public mjs shim 유지; 이전 artifact로 복구 |
| DELTA-009 | REQ-009 | 활성 코드·테스트·개발 도구를 TS로 정리하고 변경 위치를 고정한다. | 공개 동작 fixture 보존; 마지막 통과 slice로 복구 |
| DELTA-010 | REQ-010 | 현재 artifact의 깨끗한 전체 검증과 운영 인계를 완료한다. | 공개 동작 fixture 보존; 마지막 통과 slice로 복구 |

Evidence: source graph, typecheck 범위, Authority read model 및 실제 writer를 CURRENT_ARCHITECTURE에 연결했다. 데이터·schema version 변화가 필요하면 별도 DELTA를 추가하고 타입 전환과 구분한다.
