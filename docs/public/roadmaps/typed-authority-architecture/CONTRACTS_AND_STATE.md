# 계약, 외부 입력, SQLite 상태 경계

## 계약의 단일 정의

기존 `schemas/kernel.*.schema.json`의 직렬화 계약은 schema-first를 기본으로 한다. 각 계약은 canonical schema 경로, schema version, 소유자, producer, consumer, 검증 함수, 생성 타입을 registry에 한 번 등록한다. 현재 schema에 `string`으로만 표현한 상태 값이나 빠진 조건은 실제 accepted payload와 비교한 뒤 보강한다. 코드와 schema가 다른 상태에서 타입 생성만 하고 정합성이 확보됐다고 판단하지 않는다.

생성기는 `$ref`, union, optional/nullable, `additionalProperties`, draft 차이를 보존해야 한다. 대표 계약의 valid/invalid corpus로 generator와 validator의 지원 범위를 먼저 검증한다. 특정 라이브러리 이름은 목표가 아니다. 구현 TASK-002에서 기존 자산을 지원하는 generator/validator를 선정하고 lockfile에 고정한다. 이 선택이 schema 전체 재작성이나 새 public version을 요구하면 ADR을 갱신한다.

wire DTO와 내부 타입은 구분한다. 기존 wire/persistence shape는 보존하고 codec 뒤에서 discriminated union을 사용한다. 내부 port interface는 TS를 canonical 정의로 둘 수 있다. 같은 직렬화 계약을 JSON Schema와 interface로 각각 수동 관리하지 않는다. 구조 검증 뒤 Authority의 의미 검증을 수행한다.

| 계약 | 소유자 | 현재 근거 | 필수 의미 검증 |
| --- | --- | --- | --- |
| Task / Work Unit / Run / Cursor | Work | kernel.task-contract, kernel.runtime-state, kernel.workflow-state schema | run·step·revision·allowedPaths·binding 일치 |
| Execution Capsule / Mutation Provenance | Work | kernel.execution-capsule, kernel.attempt-provenance schema | source/workspace identity, CAS, current attempt |
| Evidence / Review / Completion | Trust | kernel.review-receipt, kernel.release-evidence, proof 코드 | 실제 실행, freshness, required coverage, reviewer independence |
| Knowledge Candidate / Record / Commit | Knowledge | kernel.knowledge-* schema | project namespace, user approval, revision, supersession |
| Host Request / Result / Usage | Host boundary | run/host-execution-contract, kernel.model-route/model-usage | capability, native lineage, result origin, typed failure |
| Install manifest / Profile | Delivery | kernel.runtime-manifest, installer/profile 코드 | containment, runtime dependency, content hash |

## 외부 입력 경계

| Input | 검증 위치 | 실패 동작 |
| --- | --- | --- |
| argv / stdin / MCP report | CLI/MCP codec | 구조화 오류·기존 exit contract, 실행과 쓰기 없음 |
| env / JSON / YAML / policy | Host config loader | 필드·경로 오류를 노출, 묵시적 default 승격 금지 |
| SQLite JSON row | owner별 persistence codec | 손상/version 오류; projection으로 권위를 복원하지 않음 |
| provider/tool response | provider adapter | `unknown`에서 schema parse, typed failed result |
| child process stdout/stderr/exit | Host execution adapter | timeout/cancel/nonzero를 성공과 구분 |
| account-root state / receipt | 공식 상태 경계 | identity·digest·version·freshness 확인 |
| install manifest / archive entry | Host install | path traversal/symlink/누락·변조를 쓰기 전에 거부 |
| session transcript / Code Index | Host knowledge input | redaction·source provenance·크기 제한 후 전달 |

raw JSON을 `as Run`으로 넘기지 않는다. 범용 `Record<string, any>`를 계약 대체물로 사용하지 않는다. 타입 assertion은 실제 narrowing 근거를 가진 제한된 adapter 내부에서만 허용한다. 실패 payload에 비밀값·raw transcript를 넣지 않는다.

## 상태와 트랜잭션

현재 `state-store.mjs`를 기능별 DB로 분리하지 않는다. 하나의 connection factory와 transaction runner를 유지한다. WorkStore, TrustStore, KnowledgeStore, Host technical state access는 실제 사용 연산만 제공한다. generic Repository framework는 추가하지 않는다.

쓰기 권한은 다음과 같이 구분한다.

- Work는 run/step/cursor/binding/mutation을 변경한다.
- Trust는 obligation/evidence/review/completion의 수락된 결과를 변경한다.
- Knowledge는 candidate/record/commit/revision을 변경한다.
- Host는 기술 실행·세션 관찰을 기록한다. 결과는 Authority의 수락 이전에는 단순 관찰이다.

한 `report`의 원자적 변경은 하나의 transaction에서 수행한다. 기존 idempotency key, revision CAS, lease 검사, successor lineage를 유지한다. 실행 전 intent commit → 외부 실행 → 최신 revision 재검사 → 수락 결과 commit으로 장시간 실행과 DB transaction을 분리한다. crash/retry에서 이중 실행·이중 완료를 막는다.

lease와 physical process의 소유권은 다를 수 있다. Work의 명령 허용 판단과 Host의 PID/native session 정리 권한을 혼동하지 않는다. PID만으로 다른 작업의 process를 종료하지 않는다. 기존 owner/session/workspace fencing을 보존한다.

## version과 migration

기본은 DB schema·wire 값 보존이다. 새로운 내부 union tag가 곧 기존 DB column 변경을 의미하지 않는다. 타입 검증 강화로 과거 유효 데이터가 거부되는 경우 codec과 historical fixture로 호환성을 검토한다. optional 필드의 누락·null·default 차이를 기록한다.

SQL migration이 필요한 경우 별도 delta에 schema version, upgrade, rollback 가능 범위, crash recovery, 데이터 checksum을 정의한다. 기존 receipt의 digest 규칙·revision을 임의 재계산하거나 덮어쓰지 않는다. 오래된 근거는 오래된 근거로 유지하고 공식 실행 경로로 새 근거를 만든다.

이번 대화에서 발견한 completion revision 6 / mutation provenance revision 4 사례는 synthetic fixture로 재현한다. 실제 계정 DB나 provider 세션을 저장소 fixture로 복사하지 않는다. 정상 일치 사례와 불일치 거부 사례를 함께 검증한다.
