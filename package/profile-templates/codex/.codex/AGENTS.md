# Moonshot Relay Codex Profile TOC

Last-Reviewed: 2026-10-25

`.codex/` is an installed Codex runtime profile, not canonical source. Keep this file small. Codex also loads project and directory-local `AGENTS.md` files; let the nearest applicable project instruction own project-specific behavior.

## Core Working Rules

1. Execute the requested goal at the intended scope. Prefer the smallest change that fully satisfies the requirement.
2. Inspect the existing implementation and reuse established abstractions before adding a new layer, state machine, fallback, compatibility path, or policy rule.
3. Do not encode one project, one failure, one environment, or one model into shared harness behavior unless the boundary is genuinely general and verified.
4. Treat repeated special-case rules as an architecture signal. Fix the owning boundary when possible instead of accumulating prompt restrictions.
5. Make routine implementation decisions autonomously. Add planning, decomposition, subagents, independent review, or extra verification only when the task, project contract, or active Kernel action requires them.
6. Verify proportionally: use focused checks while implementing, then run the broader checks required by the project's actual completion contract. Do not rerun expensive proof only to reassure yourself.
7. When execution is interrupted or fails unexpectedly, distinguish a repository/harness defect from a local environment problem. Preserve evidence and remaining uncertainty; do not hide the failure with a new fallback.
8. Keep generated state, logs, caches, traces, browser artifacts, SQLite state, and verdict output out of canonical source unless the project explicitly defines them as deliverables.
9. When a selected skill or runtime owns workflow state, evidence, or completion authority, follow that authority instead of recreating the same process in this profile.

## Source and Runtime Boundaries

- Durable Moonshot Relay policy belongs in canonical repository source first; installed profile files are derived runtime material.
- Resolve shared runtime assets through `MOONSHOT_RELAY_HOME` (default `~/.moonshot-relay`).
- Runtime contract: `AGENTS.md` + `verification.contract.yaml`.
- Provider/model selection is Host-owned. Keep provider-specific model names, prices, routing heuristics, and temporary capability workarounds out of this global instruction file.

## References

- `@verification.contract.yaml`
- `@rules/agents/agent-definition.md`
- `${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}/docs/public/guidelines/provider-neutral-model-routing.md`
- `${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}/docs/public/guidelines/kernel-agent-recovery.md`
