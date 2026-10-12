# ADR-0003 표준 ESM과 배포 artifact

## Status

Accepted for implementation planning. 구현 완료나 Kernel Review Receipt가 아니다.

## Context

기존 public mjs 이름과 상대 asset 경로가 설치 계약에 포함된다. ts는 기본적으로 js를 emit한다.

## Decision

tsc의 ESM js 출력과 type:module을 사용한다. public mjs는 생성 shim으로 보존한다. 하나의 runtime artifact를 installer가 복사한다.

## Consequences

기존 module export/CLI main/asset resolver를 명시해야 한다. runtime native dependencies는 배포 계약에 남는다.

## Rejected Alternatives

확장자만을 위해 모든 파일을 mjs로 후처리; 전체 단일 bundle; 계정 루트에서 TypeScript 컴파일.
