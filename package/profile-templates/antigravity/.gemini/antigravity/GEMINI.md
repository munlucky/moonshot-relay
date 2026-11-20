# Moonshot Relay Antigravity Profile TOC

Last-Reviewed: 2026-07-16

`.gemini/antigravity/` is a service runtime profile, not canonical source. Keep this Tier 1 file as a short TOC.

1. `GEMINI.md` is the Antigravity profile TOC.
2. Store durable policy in canonical source docs first; use profile-local `PROJECT.md` and `rules/` for Antigravity service behavior and `${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}/docs/public/guidelines/` for public guidelines.
3. Keep always-loaded context minimal and under budget.
4. Update canonical source docs first, then refresh TOC links.
5. Resolve shared runtime assets through `MOONSHOT_RELAY_HOME` (default `~/.moonshot-relay`).
6. Runtime contract: `GEMINI.md` + `verification.contract.yaml`.
7. Antigravity global skill discovery is materialized under `${ANTIGRAVITY_SKILLS_HOME:-~/.gemini/config}/skills/`; the legacy `.gemini/antigravity/skills/` mirror remains compatibility-only.
8. Generated state, logs, caches, traces, browser artifacts, sqlite state, memorygraph data, and verdict JSON are excluded from package payloads.

## Default Document Paths

```yaml
documentPaths:
  tasksRoot: ".moonshot-relay/docs/tasks"
  agreementsRoot: ".moonshot-relay/docs/agreements"
  guidelinesRoot: "${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}/docs/public/guidelines"
```

## Project-Local Knowledge Anchors

When a workspace root `AGENTS.md` declares `knowledgeAnchors`, treat those anchors as always-loaded discovery metadata for Moonshot work in that workspace.

Project-specific anchor entries belong in the consuming project, not in this installed runtime profile.

## References

If the active runtime does not auto-expand `@path` or shell variables, read these referenced files on demand from the installed profile or resolved `MOONSHOT_RELAY_HOME` (default `~/.moonshot-relay`) when needed:

- `@PROJECT.md`
- `@verification.contract.yaml`
- `@rules/agents/agent-definition.md`
- `${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}/docs/public/guidelines/knowledge-repository-ops.md`
- `${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}/docs/public/guidelines/provider-neutral-model-routing.md`
- `${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}/docs/public/guidelines/resumable-session-layer.md`
