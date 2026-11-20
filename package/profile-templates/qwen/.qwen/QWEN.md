# Moonshot Relay Qwen Profile TOC

Last-Reviewed: 2026-06-06

`.qwen/` is a service runtime profile, not canonical source. Keep this Tier 1 file as a short TOC.

1. `QWEN.md` is the Qwen Code profile TOC.
2. Store durable policy in canonical source docs first; use profile-local `rules/` for Qwen service behavior and `${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}/docs/public/guidelines/` for public guidelines.
3. Keep always-loaded context minimal and under budget.
4. Update canonical source docs first, then refresh TOC links.
5. Run the active knowledge repository audit after structural doc changes when that support entrypoint is installed.
6. Resolve shared runtime assets through `MOONSHOT_RELAY_HOME` (`%MOONSHOT_RELAY_HOME%` in cmd.exe, `$env:MOONSHOT_RELAY_HOME` in PowerShell, `${MOONSHOT_RELAY_HOME}` in bash/zsh; default `~/.moonshot-relay`).
7. Runtime contract: `QWEN.md` + `verification.contract.yaml`.
8. Generated state, logs, caches, traces, browser artifacts, sqlite state, memorygraph data, and verdict JSON are excluded from package payloads.

## Default Document Paths

```yaml
documentPaths:
  tasksRoot: ".moonshot-relay/docs/tasks"
  agreementsRoot: ".moonshot-relay/docs/agreements"
  guidelinesRoot: "${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}/docs/public/guidelines"
```

## Project-Local Knowledge Anchors

When a workspace root `AGENTS.md` or `QWEN.md` declares `knowledgeAnchors`, treat those anchors as always-loaded discovery metadata for Moonshot work in that workspace.

`moonshot-architecture` must consult applicable anchors before producing or updating an architecture package. Load only the referenced agreement documents needed for the current scope, and record consulted anchor IDs and consumed paths in the architecture package.

Project-specific anchor entries belong in the consuming project, not in this installed runtime profile.

## References

If the active runtime does not auto-expand `@path` or shell variables, read these referenced files on demand from the installed profile or resolved `MOONSHOT_RELAY_HOME` (default `~/.moonshot-relay`) when needed:

- `@verification.contract.yaml`
- `@rules/agents/agent-definition.md`
- `${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}/docs/public/guidelines/knowledge-repository-ops.md`
- `${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}/docs/public/guidelines/provider-neutral-model-routing.md`
- `${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}/docs/public/guidelines/resumable-session-layer.md`
