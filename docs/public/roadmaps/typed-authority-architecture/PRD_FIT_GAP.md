# 사용자 목표와 추가 의견 반영

| 항목 | 채택·보정 | Requirement |
| --- | --- | --- |
| 사용하고 개선하기 쉬운 하네스 | 최상위 목표. 변경 소유권 시험을 완료 조건으로 둔다. | REQ-001, REQ-009 |
| 전체 ts 원본 | 활성 runtime과 참조 support·test·tool까지 포함한다. 현재 197개로 범위를 축소하지 않는다. | REQ-002, REQ-009 |
| 설치 결과만 mjs | 표준 ESM js를 기본으로 하고 기존 public mjs는 generated shim으로 보존한다. 사용자 계정에는 build artifact만 둔다. | REQ-008 |
| Work / Trust / Knowledge | 세 Authority의 논리 소유권을 유지한다. read model만 옮겨 완료로 보지 않는다. | REQ-003, REQ-004, REQ-005 |
| Strong Host | 실제 실행과 provider 정책을 맡는다. 결정 수락 권한은 Authority에 남긴다. | REQ-006 |
| 얇은 Control Plane | public sequencing과 transaction orchestration만 맡긴다. 큰 helper로 책임을 숨기지 않는다. | REQ-007 |
| schema와 TS의 단일 정의 | 기존 JSON Schema를 우선 활용하고 생성 타입·runtime validator의 drift를 검사한다. | REQ-002 |
| SQLite 단일 authority | DB를 분리하지 않고 owner별 typed operation과 한 transaction runner를 사용한다. | REQ-005, REQ-007 |
| 세로 전환 | Work→Trust→Knowledge→Host로 실제 공개 경로와 저장까지 매번 연결한다. | REQ-003, REQ-004, REQ-005, REQ-006 |
| Host는 completion을 참조하면 안 됨 | 보정: 결정의 소비는 허용한다. 자체 재판정·권위 상태 쓰기를 금지한다. | REQ-004, REQ-006 |
| 기존 shim은 모두 삭제 | 보정: 내부 이행 shim만 caller 0 증명 후 삭제한다. 공개 호환 진입점은 유지한다. | REQ-008, REQ-009 |
| 단순성 | npm package 하나, 기존 Node/SQLite, 기존 public surface를 유지한다. 새 graph/event engine을 도입하지 않는다. | REQ-001, REQ-007 |
| native와 실계정 검증 | 임시 설치·binary probe·인증된 실제 실행·실계정 적용의 증거를 구분한다. | REQ-010 |

첨부의 두 도식 중 Work→Trust→Knowledge처럼 읽힐 수 있는 도식은 그대로 쓰지 않았다. 세 Authority의 동등한 소유권과 coordinator를 채택했다. 논문의 인터페이스·단순성 원칙은 설계 참고다. 이 프로젝트의 성능 향상을 보장하는 근거로 사용하지 않는다.
