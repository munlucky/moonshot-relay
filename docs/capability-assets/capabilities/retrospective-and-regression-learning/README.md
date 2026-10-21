# Retrospective and regression learning

- **ID**: `retrospective-and-regression-learning`
- **Category**: `KNOWLEDGE`
- **Status**: `OPTIONAL`
- **Catalog Version**: `4`
- **Baseline Version**: `2.1`

## Summary
실패·회고 signal을 수집하고 regression candidate로 만들되 명시적 review 전에는 authority로 승격하지 않는다.

## Current Ownership Boundary

C9 ownership audit 기준 현재 자산은 네 범주로 구분한다.

- **Active advisory/production tooling**: `tools/retro/**`, `scripts/knowledge-improvement-lifecycle.mjs`, `scripts/awtl-memory-promotion.mjs`. 사용자 요청 또는 명시적 promotion 흐름에서 사용되지만 Kernel completion·Knowledge persistence 권위는 소유하지 않는다.
- **Active Host/offline eval tooling**: `src/host-tooling/kernel-eval/historical-{improvement,actions,replans,replay}.ts`와 `model-prompt-replay.ts`. current-generation 문제 분류와 single-variable replay를 담당하며 `promotionAuthority=false`를 유지한다.
- **Compatibility projection**: `scripts/kernel/eval/*.js`와 `scripts/kernel/optimization-cycle.mjs`처럼 typed source에서 생성되는 runtime/package projection. 소스 Authority가 아니므로 중복 구현으로 간주하지 않는다.
- **Historical/dead asset**: `archive/scripts/legacy-phase-adapters/**` 아래 구 Relay/AWTL 구현. 현재 runtime consumer는 없고 비교·교훈 자산으로만 보존한다.

현재 실제 corpus에는 C10 replay 대상 `CANDIDATE`가 0건이므로 active/compatibility 자산 삭제 조건은 아직 충족되지 않았다. 첫 실제 current-generation candidate replay가 완료된 뒤 consumer/import graph를 다시 측정한다.

## Subcapabilities Traceability
### `daily-retro-collection` (OPTIONAL)
- **Name**: Daily retro collection
- **Role**: 일일 회고 및 장애 신호 수집
- **Product Relevance**: Agent Workflow: true, Knowledge Lifecycle: true
- **Implementation References**:
  - `tools/retro/retro-cli.mjs` (current source)
  - `tools/retro/daily-retro.mjs` (current source)
  - `skills/moonshot-retro/SKILL.md` (current source)
- **Proof References**:
  - `retro-collect`
  - `retro-redaction`

### `improvement-proposals` (OPTIONAL)
- **Name**: Improvement proposals
- **Role**: 회고 기반 개선 제안 및 이슈 초안 작성
- **Product Relevance**: Agent Workflow: true, Knowledge Lifecycle: true
- **Implementation References**:
  - `tools/retro/improvement-proposer.mjs` (current source)
  - `scripts/knowledge-improvement-lifecycle.mjs` (current source)
  - `scripts/awtl-memory-promotion.mjs` (current source)
- **Proof References**:
  - `retro-no-promotion`


## Proof Tests
- **retro-collect**: `tests/retro-collect-contract.test.mjs` (referenceStatus: `verified`, executionStatus: `historical-pass`) — command: `test`
- **retro-redaction**: `tests/retro-redaction-contract.test.mjs` (referenceStatus: `verified`, executionStatus: `historical-pass`) — command: `test`
- **retro-no-promotion**: `tests/retro-no-promotion-authority-contract.test.mjs` (referenceStatus: `verified`, executionStatus: `historical-pass`) — command: `test`

## Decision
- **Disposition**: `retain`
- **Rationale**: 반복 실패를 잊지 않게 하는 OPTIONAL learning asset이지만 runtime 권위와 분리한다.
