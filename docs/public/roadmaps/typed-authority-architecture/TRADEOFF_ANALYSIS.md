# 대안과 비용

## Architecture options

| 대안 | 이점 | 비용·위험 | 결정 |
| --- | --- | --- | --- |
| 현재 구조에서 JSDoc/checkJs만 확대 | 실행 경로 변경이 작음 | 전체 계약·소유권·원본 표준화 목표를 충족하기 어려움 | 최종 구조로 선택하지 않음 |
| 전체 mjs를 ts로 일괄 rename | 초기 파일 전환이 빠름 | any/assertion으로 오류를 덮거나 동작 변경을 한 번에 섞을 위험 | 선택하지 않음 |
| 단일 패키지의 typed authority + 세로 전환 | 현재 자산 재사용, 실제 경로별 검증 가능 | 혼합 graph와 한시적 adapter 관리 필요 | 선택 |
| 다중 workspace package | 강한 package 경계와 별도 배포 가능 | 버전·빌드 순서·배포 운영 비용 증가, 현재 독립 릴리스 요구 없음 | 현재 단계에서 선택하지 않음 |
| 새 workflow/event/DI framework | 공통 실행 추상화 제공 | 상태·완료 권위 중복과 기존 semantics 이식 비용 | 선택하지 않음 |
| 모든 출력을 mjs로 강제 | 기존 확장자 형태 유지 | 표준 ts emit 뒤 import·파일명 처리가 추가됨 | public shim에만 적용 |
| ESM js + public mjs generated shim | 표준 compiler 경로, 공개 명령 호환 | asset locator, CLI main, package type 검증 필요 | 선택 |
| 전체 bundle | 파일 배포 단순화 가능 | import.meta.url·dynamic loading·native SQLite·debug 영향 확대 | 현재 단계에서 선택하지 않음 |

## 계약 선택

기존 JSON Schema를 먼저 재사용한다. 일부 schema가 충분히 구체적이지 않으면 accepted payload와 테스트를 기준으로 보완한다. schema-first가 모든 내부 타입을 JSON으로 표현하라는 뜻은 아니다. 내부 port는 TS interface로 두고 wire codec을 통해 연결한다.

Zod 등 code-first 계약도 개별 신규 계약에서 검토할 수 있지만, 이 계획의 기본은 기존 schema를 canonical로 유지하는 것이다. code-first로 바꾸려면 해당 계약의 canonical owner를 하나로 변경하고 생성 방향·compatibility corpus를 ADR에 명시한다. 두 정의를 병행하지 않는다.

## 복잡도 관리

추가하는 추상화는 실제 policy/effect 경계와 서로 다른 소비자가 있을 때만 도입한다. generic repository, service locator, global event bus를 기본 구성으로 만들지 않는다. 새로운 authority·DB·public orchestration command는 추가하지 않는다.

기존 `state-store`의 기술 분리는 코드 파일 수를 늘릴 수 있다. owner별 변경 영향과 transaction 보존이 개선된다면 허용한다. 이름만 다른 wrapper를 늘리거나 같은 policy를 두 곳에서 계산하면 실패다. import cycle은 최종 0개이며 명시적 기존 예외 두 개도 해소한다.

## 위험과 대응

| 위험 | 조기 검출 | 대응 |
| --- | --- | --- |
| 타입이 실제 wire/state와 다름 | schema와 historical valid/invalid corpus | codec 보완; version 변화는 별도 delta |
| migration 중 두 구현이 상태를 씀 | writer inventory와 owner guard | 각 public path의 canonical writer 하나만 활성화 |
| Host로 실행 이동 중 수락 권한도 이동 | stale/review/command authorization 회귀 | Trust policy와 Host execution port 분리 |
| state-store 분리로 원자성이 깨짐 | 중간 SQL 실패·crash injection | 동일 transaction runner와 CAS 사용 |
| 새 출력에서 자산·CLI 경로가 깨짐 | source 없는 install과 next/report/resume | public shim·main 계약·asset locator |
| compiler/tool bootstrap 순환 | generated 파일 없는 checkout 실행 | compiler CLI로 tools project를 먼저 emit |
| 설치가 다른 artifact를 재생성 | 파일 manifest와 hash 비교 | 검증한 runtime artifact를 그대로 복사 |
| 현재 Node/OS 지원 범위를 잘못 주장 | CI matrix·engine·native dependency 대조 | 지원 계약을 확정하고 각 필수 조합 검증 |
| 구조 변경에 새 기능이 섞임 | task별 spec delta 검토 | feature request와 구조 작업을 별도 변경 단위로 분리 |

도구 선정은 TASK-002의 bounded compatibility probe다. 입력은 기존 대표 schema와 Node 지원 계약이다. 출력은 고정 버전, 생성 정합성, malformed 입력 거부, 추가 runtime dependency 목록이다. 지원 범위에 맞지 않는 도구를 채택하고 schema를 무리하게 단순화하지 않는다.
