# 요구사항 목록

상위 목표는 사용·개선 비용 감소다. 각 요구는 PLAN의 한 작업과 검증 신호에 연결한다.

| Requirement ID | Statement | Owner | Verification Signal | 합격 기준 |
| --- | --- | --- | --- | --- |
| REQ-001 | 기능·writer·payload의 소유권을 빠짐없이 지정한다. | Architecture | V01 | 미분류 활성 항목 0 |
| REQ-002 | 계약을 한 정의에서 생성하고 strict TS와 입력 검증을 연결한다. | Build | V02 | 타입·schema·생성 drift의 부정 검증 |
| REQ-003 | Work를 세로 전환하고 resume·cursor·scope·CAS를 보존한다. | Work | V03 | 재시작·replan·mutation fencing 회귀 |
| REQ-004 | Trust가 증거·review·completion 수락을 독점하고 closeout 근거와 일치한다. | Trust | V04 | 정상 수락 및 stale provenance 거부 |
| REQ-005 | Knowledge의 SQLite 권위와 승인·revision·supersession을 보존한다. | Knowledge | V05 | 동시성·projection 손상·namespace 회귀 |
| REQ-006 | Host가 외부 실행을 소유하고 Kernel은 provider 독립 계약을 사용한다. | Host | V06 | 금지 import·외부 입력·native smoke |
| REQ-007 | Control Plane과 persistence를 분리하며 원자성·idempotency를 유지한다. | Architecture | V07 | 직접 SQL/spawn 0 및 crash rollback |
| REQ-008 | 표준 ESM artifact를 기존 공개 진입점으로 설치하고 실행한다. | Delivery | V08 | source 없는 archive/direct install hash parity |
| REQ-009 | 활성 코드·테스트·개발 도구를 TS로 정리하고 변경 위치를 고정한다. | Developer Experience | V09 | 잔여 예외 정리 및 네 가지 변경 시험 |
| REQ-010 | 현재 artifact의 깨끗한 전체 검증과 운영 인계를 완료한다. | Delivery | V10 | 지원 matrix와 upgrade/rollback 증거 |

기존 공개 동작 보존은 모든 요구에 적용한다. 새 제품 기능과 live 배포는 자동으로 이 요구에 포함되지 않는다.
