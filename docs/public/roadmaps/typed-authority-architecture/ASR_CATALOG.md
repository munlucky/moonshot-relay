# 아키텍처 중요 요구와 품질 시나리오

| ASR ID | Requirement IDs | Scenario IDs | 결정 | Verification Signal |
| --- | --- | --- | --- | --- |
| ASR-001 | REQ-001 | QAS-001 | ADR-0001 | V01 |
| ASR-002 | REQ-002 | QAS-002 | ADR-0002 | V02 |
| ASR-003 | REQ-003 | QAS-003 | ADR-0004 | V03 |
| ASR-004 | REQ-004 | QAS-004 | ADR-0001 | V04 |
| ASR-005 | REQ-005 | QAS-005 | ADR-0002 | V05 |
| ASR-006 | REQ-006 | QAS-006 | ADR-0001 | V06 |
| ASR-007 | REQ-007 | QAS-007 | ADR-0004 | V07 |
| ASR-008 | REQ-008 | QAS-008 | ADR-0003 | V08 |
| ASR-009 | REQ-009 | QAS-009 | ADR-0004 | V09 |
| ASR-010 | REQ-010 | QAS-010 | ADR-0003 | V10 |

| Scenario ID | Stimulus | Expected Response |
| --- | --- | --- |
| QAS-001 | 기능·writer·payload의 소유권을 빠짐없이 지정한다. | 미분류 활성 항목 0 |
| QAS-002 | 계약을 한 정의에서 생성하고 strict TS와 입력 검증을 연결한다. | 타입·schema·생성 drift의 부정 검증 |
| QAS-003 | Work를 세로 전환하고 resume·cursor·scope·CAS를 보존한다. | 재시작·replan·mutation fencing 회귀 |
| QAS-004 | Trust가 증거·review·completion 수락을 독점하고 closeout 근거와 일치한다. | 정상 수락 및 stale provenance 거부 |
| QAS-005 | Knowledge의 SQLite 권위와 승인·revision·supersession을 보존한다. | 동시성·projection 손상·namespace 회귀 |
| QAS-006 | Host가 외부 실행을 소유하고 Kernel은 provider 독립 계약을 사용한다. | 금지 import·외부 입력·native smoke |
| QAS-007 | Control Plane과 persistence를 분리하며 원자성·idempotency를 유지한다. | 직접 SQL/spawn 0 및 crash rollback |
| QAS-008 | 표준 ESM artifact를 기존 공개 진입점으로 설치하고 실행한다. | source 없는 archive/direct install hash parity |
| QAS-009 | 활성 코드·테스트·개발 도구를 TS로 정리하고 변경 위치를 고정한다. | 잔여 예외 정리 및 네 가지 변경 시험 |
| QAS-010 | 현재 artifact의 깨끗한 전체 검증과 운영 인계를 완료한다. | 지원 matrix와 upgrade/rollback 증거 |

동작하는 하네스의 변경 영향이 owner 안에 모이는지를 평가한다. 전환 파일 비율은 합격 기준이 아니다.
