# 계획 검토 기록

## Status

Ready for implementation planning. 작성 에이전트가 현재 코드와 요구사항의 일관성을 자체 점검했다. 독립 에이전트 리뷰나 Kernel Review Receipt가 아니다. 실행 결과와 완료 승인은 아직 없다.

## 검토와 반영

| 확인 항목 | 발견한 모호성 | 최종 반영 |
| --- | --- | --- |
| 목표 | 전체 TS 비율만 성공 기준이 될 수 있음 | 소유권과 네 가지 작은 변경 시험을 우선 기준으로 지정 |
| Authority | read model을 실제 쓰기 권위로 오해할 수 있음 | 실제 write API·transaction·의미 owner의 분리 작업 명시 |
| 의존 방향 | 입력 도식이 Work→Trust→Knowledge 계층으로 읽힘 | 동등한 세 Authority와 coordinator로 확정 |
| Host | completion 참조 자체를 금지하면 정상 소비도 막힘 | 결정 소비와 결정 생성·수정 권한 구분 |
| build | ts→mjs 후처리가 표준 구조의 목표가 될 수 있음 | tsc ESM js + public mjs generated shim 선택 |
| bootstrap | TS build tool을 실행하려고 자기 산출물이 먼저 필요할 수 있음 | compiler CLI의 tools 선행 emit과 runtime lifecycle 분리 |
| source 범위 | 197개만 전환하면 installer/support가 남음 | runtime 호출·manifest·spawn·profile 참조 폐쇄집합을 범위로 지정 |
| SQLite | 디렉터리 분리로 transaction이 쪼개질 수 있음 | 한 DB/session/transaction 및 crash fault injection 명시 |
| public 계약 | union 전환이 wire/DB 값을 바꿀 수 있음 | versioned codec과 기존 shape 보존 |
| completion | 이전 완료 로그가 새 구현 증거로 재사용될 수 있음 | 새 source/artifact digest에 검증을 결합 |
| commit admission | revision 6/4 불일치가 단순 상태 이름 오류로 축소될 수 있음 | Trust에서 정상·stale provenance 양쪽을 재현하고 검증 |
| 호환 경로 | 모든 shim 삭제가 public 명령을 깨뜨릴 수 있음 | public generated shim과 내부 임시 shim 구분 |
| 설치 | help 실행만으로 runtime 전체를 검증할 수 없음 | source 없는 next/report/resume·SQLite·native dependency·upgrade/rollback 추가 |
| 단순성 | state-store 분리가 generic framework 추가로 변할 수 있음 | 실제 owner SQL 연산만 추출하고 기존 Journal 비권위 유지 |

## 검증 범위와 미확정 실행 사실

계획 문서 validator, local link, source inventory, 요구사항 연결, seed digest를 확인한다. 결과는 최종 전달 시 실제 실행 결과로 보고한다. 계획의 검토 상태가 V01~V10의 구현 PASS를 뜻하지 않는다.

TASK-001의 함수별 owner·dynamic closure 확정과 TASK-002의 schema generator 호환성 검증은 구현 선행 작업이다. 현재 전체 197개 함수 본문을 독립적으로 검토했다는 주장은 하지 않는다. 이 작업을 생략하고 전체 rename부터 시작하지 않도록 계획의 시작 조건에 묶었다.
