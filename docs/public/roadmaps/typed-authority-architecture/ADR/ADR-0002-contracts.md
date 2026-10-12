# ADR-0002 단일 계약과 상태 권위

## Status

Accepted for implementation planning. 구현 완료나 Kernel Review Receipt가 아니다.

## Context

현재 JSON Schema와 동적 JS 객체가 있고 타입 검사는 두 mts 계약 중심이다.

## Decision

기존 wire schema를 canonical로 유지하고 TS/validator를 파생한다. 내부 union과 port는 codec 뒤에 둔다. SQLite를 단일 권위로 유지한다.

## Consequences

generator 지원 범위와 schema/body drift를 먼저 검증한다. 한 transaction runner를 유지한다. 과거 유효 데이터 compatibility corpus가 필요하다.

## Rejected Alternatives

모든 계약을 Zod로 재작성; 수동 interface와 schema 이중 관리; projection/새 DB를 권위로 사용.

## 구현 선택: 2026-10-11

`catalog/kernel-contracts.json`에 canonical schema, version, owner, 생성 타입과 validator를 등록한다. `json-schema-to-typescript` 16.0.0을 개발 의존성으로 고정했다. 이 계열은 Node 20에서 실행된다. 타입 생성은 `unknownAny`를 사용한다. [generator 문서](https://github.com/bcherny/json-schema-to-typescript)에서 지원 범위와 타입으로 표현할 수 없는 제약을 확인했다.

Ajv 8.20.0과 ajv-formats 3.0.1은 runtime 검증 의존성이다. Draft 7과 2020-12는 별도 instance로 검증한다. 외부 HTTP `$ref`는 생성에서 차단한다. [Ajv draft 안내](https://ajv.js.org/json-schema.html)를 따른다. enum, union, nullable, 추가 필드 정책은 생성 타입에 연결한다. 정수, format, 조건부 제약 등 TS가 완전히 표현하지 못하는 규칙은 runtime validator가 검사한다.

Task snapshot, Work authority, durable state와 Review Receipt는 생성 DTO를 실제 생성·읽기 경계에서 사용한다. Knowledge identity/status projection은 생성 Record의 필요한 필드만 사용한다. type/status/trustTier vocabulary도 schema에서 생성한다. 기존 schema가 빠뜨린 현재 record 종류와 `quarantined`, review의 `operator_approved`를 현재 accepted payload에 맞춰 보강했다. wire version, SQL transaction, 승인과 completion 정책은 유지한다.

`build:contracts`는 타입과 runtime schema 정의를 생성한다. 일반 build는 이를 자동 승인하지 않고 drift를 거부한다. 기존 생성 도구가 없는 `npm ci`는 compiler CLI를 먼저 실행한다. 부정 타입 fixture, refs/union/nullability/closed-object corpus, schema·생성 타입 변조와 이전 runtime 보존 검사가 이 경계를 확인한다. 이 기록 자체는 Kernel 완료 근거가 아니다.
