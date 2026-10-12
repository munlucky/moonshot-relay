# ADR-0004 세로 전환과 변경 용이성 검증

## Status

Accepted for implementation planning. 구현 완료나 Kernel Review Receipt가 아니다.

## Context

약 4.4만 줄의 동작 보존과 여러 설치 경로가 연결된다. 기존 큰 state-store와 coordinator의 원자성이 중요하다.

## Decision

Work, Trust, Knowledge를 public path·Host port·DB·test까지 연결해 순서대로 전환한다. 각 단계의 canonical writer는 하나다. 마지막에 네 가지 작은 policy 변경으로 수정 범위를 검증한다.

## Consequences

중간 혼합 graph와 registry가 필요하다. 임시 shim은 caller가 사라진 뒤 제거한다. 기존 lifecycle Journal은 transaction fact이며 새 event-sourcing authority로 사용하지 않는다.

## Rejected Alternatives

전 파일 rename 후 any 추가; 모든 contract/utility부터 수평 전환; 새 workflow/event framework; 줄 수만으로 완료 판정.
