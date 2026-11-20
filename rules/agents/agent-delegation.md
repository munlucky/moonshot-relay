---
paths:
  - "agents/**/*.md"
  - "skills/**/*.md"
  - ".claude/agents/**/*.md"
  - ".claude/skills/**/*.md"
---

# Agent Delegation Rules

Multi-agent fanout is default-deny. Delegation can use one worker or a permitted team only after the local fanout contract is explicit.

## Delegate When Needed

- Complex feature/refactor -> `moonshot-orchestrator` first.
- Unclear requirements -> `requirements-analyzer`.
- Build/test failures -> `build-error-resolver` or `completion-verifier`.
- Security concerns -> `security-reviewer`.
- Documentation alignment -> `documentation-agent`.

## Do Not Delegate

- Simple read-only Q&A.
- Small direct edits with clear scope.
- Multi-agent fanout without an explicit `agentFanoutContract`.
- Nested teams, recursive subagent spawning, or complexity-only implementation fanout.

## Delegation Quality Bar

- Pass clear scope, expected output, and constraints.
- Pass minimal context (paths/summaries, not full history).
- Verify delegate output before finalizing.
- For any permitted fanout, record source, purpose, max workers, tool boundary, owned paths, merge strategy, and verification commands.
