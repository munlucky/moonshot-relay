# Moonshot Relay Codex Profile TOC

Last-Reviewed: 2026-10-25

`.codex/` is an installed Codex runtime profile, not canonical source. Project and directory-local `AGENTS.md` files own project-specific behavior.

## Core Working Rules

1. Follow the requested goal, nearest project instructions, and active task scope.
2. Reuse existing architecture before adding a layer, state machine, fallback, compatibility path, or shared policy. Do not encode one project, failure, environment, or model into general harness behavior.
3. When a selected skill or runtime owns workflow state, evidence, review, routing, or completion, use that authority instead of recreating it in this profile.
4. Keep generated runtime state, logs, caches, traces, SQLite data, and verdict output out of canonical source unless they are explicit deliverables.

## Source and Runtime Boundaries

- Durable Moonshot Relay policy belongs in canonical repository source first; installed profile files are derived runtime material.
- Resolve shared runtime assets through `MOONSHOT_RELAY_HOME` (default `~/.moonshot-relay`).
- Runtime contract: `AGENTS.md` + `verification.contract.yaml`.
- Provider/model selection is Host-owned.

## References

Codex does not auto-expand `@path` or shell variables; read these files on demand from the installed profile or resolved `MOONSHOT_RELAY_HOME` (default `~/.moonshot-relay`) when the task requires them:

- `@verification.contract.yaml` (required before claiming verification or closeout policy)
- `@rules/agents/agent-definition.md` (reference when configuring or auditing agents)
- `${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}/docs/public/guidelines/provider-neutral-model-routing.md` (reference for model routing policy)
- `${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}/docs/public/guidelines/kernel-agent-recovery.md` (reference for run recovery)
