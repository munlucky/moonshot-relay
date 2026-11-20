---
name: session-logger
description: Record decisions, issues, and handoff notes during or after work.
policyClauseIds:
  - session-logger.policy.use-when
  - session-logger.policy.routing
  - session-logger.policy.hard-stops
  - session-logger.policy.output-contract
policyDigest: 4b7cc941d22e448f65a900a26592f0a37bd7340222a4f2275b032561d46e83e4
layer: agent_extending
loads:
  - session-state
  - handoff-artifacts
deepReferences:
  - references/compatibility-contract.md
  - .moonshot-relay/docs/solutions/README.md
outputArtifacts:
  - HANDOFF.md
  - session-log
  - solution-asset
---

# Session Logger Skill

Use this skill when the user explicitly wants session or handoff logging, or when a workflow reaches a finish/handoff stage.

## Role

- keep active session state resumable
- record decisions, issues, and next steps
- prefer compact summaries over long timelines

## Default outputs

- prefer `docs/daily/YYYY-MM-DD/{runtime}.md` when the repo uses `docs/daily/README.md`
- otherwise use `{tasksRoot}/{feature-name}/session-logs/day-YYYY-MM-DD.md`
- handoff target is `analysisContext.artifacts.handoffPath` or `{tasksRoot}/{feature-name}/HANDOFF.md`

## Minimum logging contract

- work start: goal, branch, initial scope
- decision: short reason and chosen path
- issue: problem, fix, rerun signal
- correction lesson: user correction, reusable pattern, affected guardrail, and whether a durable update was made or skipped
- completion: verification result and next step

## Explicit Invocation

Use only when explicitly requested or required by an active workflow contract.

## Procedure

- Keep logs within document ceilings; archive raw timelines and keep handoffs summary-first.
- Build compact finish-stage project knowledge context and record only status, evidence pointers, and reusable decisions.
- Keep finish logging read-only unless graph refresh is explicit; promotion candidates never authorize harness writes.
- Append corrections and promote reviewed remediation patterns only when justified.

## Hard Stops

Apply the existing operating-rule safety boundaries; this heading is typed for public-surface discovery.

## Output Contract

Return written paths, record types, and any skipped or blocked reason.

## Project Knowledge Context Contract

Logs may reference compact knowledge status and provenance, never raw account-root knowledge state.

## References

- [Compaction](../../docs/public/guidelines/session-compaction.md)
- [Logger guide](../../docs/public/reference/session-logger-reference.md)
- [Docs rules](../../rules/docs/documentation.md)
- [Communication](../../rules/communication.md)
- [Output format](../../rules/output-format.md)
