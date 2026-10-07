# Provider session and execution boundary

- **ID**: `provider-session-and-execution-boundary`
- **Category**: `EXECUTION`
- **Status**: `HOST`
- **Catalog Version**: `4`
- **Baseline Version**: `2.1`

## Summary
Host/provider session, execution capsule, workspace와 transport의 경계를 분리한다.

## Subcapabilities Traceability
### `host-session-binding` (HOST)
- **Name**: Host session binding
- **Role**: Host/Provider 세션 식별 및 런타임 연결
- **Product Relevance**: Agent Workflow: true, Knowledge Lifecycle: false
- **Implementation References**:
  - `scripts/kernel/run/host-session.mjs` (current source)
  - `scripts/kernel/run/session-binding.mjs` (current source)
  - `skills/moonshot-in-session-coordinator/SKILL.md` (current source)
- **Proof References**:
  - `host-loop`
  - `multi-provider-session`

### `execution-capsule-transport` (HOST)
- **Name**: Execution capsule transport
- **Role**: 실행 캡슐 격리 및 transport 경계 보장
- **Product Relevance**: Agent Workflow: true, Knowledge Lifecycle: false
- **Implementation References**:
  - `scripts/kernel/run/session-holder.mjs` (current source)
  - `scripts/kernel/run/execution-capsule.mjs` (current source)
  - `scripts/kernel/bridge/mcp.mjs` (current source)
  - `skills/moonshot-teams-runner/SKILL.md` (current source)
- **Proof References**:
  - `execution-capsule`

### `step-worktree-isolation` (HOST)
- **Name**: Step worktree isolation
- **Role**: 스텝 단위 워크트리 생성 및 격리
- **Product Relevance**: Agent Workflow: true, Knowledge Lifecycle: false
- **Implementation References**:
  - `scripts/host/kernel/workspace/physical-worktree.mjs` (current source)
  - `skills/workspace-isolation-gate/SKILL.md` (current source)
- **Proof References**:
  - `host-loop`


## Proof Tests
- **host-loop**: `tests/kernel-host-loop-e2e.test.mjs` (referenceStatus: `verified`, executionStatus: `historical-pass`) — command: `test`
- **multi-provider-session**: `tests/kernel-multi-provider-session.test.mjs` (referenceStatus: `verified`, executionStatus: `historical-pass`) — command: `test`
- **execution-capsule**: `tests/kernel-execution-capsule.test.mjs` (referenceStatus: `verified`, executionStatus: `historical-pass`) — command: `test`

## Decision
- **Disposition**: `retain`
- **Rationale**: 현재 Kernel의 provider-independent core와 Host-owned execution을 연결하는 HOST capability다.
