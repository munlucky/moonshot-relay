# ADR-0001 기능 소유권과 의존 방향

## Status

Accepted for implementation planning. 구현 완료나 Kernel Review Receipt가 아니다.

## Context

현재 read model 경계와 실제 실행·쓰기 구현이 같은 위치를 갖지는 않는다. Kernel의 proof/Git 실행과 Host의 Kernel internal 참조가 남아 있다.

## Decision

Work/Trust/Knowledge의 의미 권한, Host의 외부 실행, Composition의 연결을 분리한다. 단일 패키지에서 import와 write guard로 강제한다.

## Consequences

추가 client/store port가 필요하다. 실제 연산만 노출하고 generic framework는 만들지 않는다. Host는 decisions의 소비자다.

## Rejected Alternatives

폴더 이동만 수행; 세 Authority를 직렬 dependency로 구성; provider 구현을 Kernel에 유지.
