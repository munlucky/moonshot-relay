# Moonshot Relay Agent TOC

Last-Reviewed: 2026-06-06

This repository's canonical source is the tracked root-level harness source, not the local `.claude/`, `.codex/`, or `.qwen/` runtime profiles.

## Source Boundaries

- Kernel/Host canonical code: `src/`; build mapping and dependency authority: `package/source-layout.json`. Run `npm ci` in a clean checkout and edit source, not generated runtime files.
- Other canonical source (excluding generated outputs): `skills/`, `agents/`, `rules/`, `bin/`, `tools/`, `schemas/`, `templates/`, `tests/`, `docs/public/`, and allowlisted support scripts under `scripts/`.
- Local runtime profiles: root `.claude/`, `.codex/`, and `.qwen/`. These may contain generated verdicts, local profile output, or installed compatibility files and are not required for a clean source checkout.
- Shared runtime home: resolve through `MOONSHOT_RELAY_HOME`; default `~/.moonshot-relay`.

## Runtime Contract

- Installed Claude profile entrypoint: `.claude/CLAUDE.md`.
- Installed Codex profile entrypoint: `.codex/AGENTS.md`.
- Installed Qwen profile entrypoint: `.qwen/QWEN.md`.
- Source checkout entrypoint: this file.
- Verification contract source: `schemas/verification.contract.yaml`, materialized to profile `verification.contract.yaml`.

## Default Document Paths

```yaml
documentPaths:
  tasksRoot: ".moonshot-relay/docs/tasks"
  agreementsRoot: ".moonshot-relay/docs/agreements"
  guidelinesRoot: "docs/public/guidelines"
```

## Project-Local Knowledge Anchors

Projects may declare always-loaded `knowledgeAnchors` in their own `AGENTS.md` to expose durable agreement packages without copying full document bodies into every prompt.

A knowledge anchor is generic metadata, not a Moonshot Relay source entry:

```yaml
knowledgeAnchors:
  - id: "PROJECT-SCOPED-STABLE-ID"
    title: "Short human-readable title"
    package: ".moonshot-relay/docs/agreements/<package-id>"
    startHere: ".moonshot-relay/docs/agreements/<package-id>/ARCHITECTURE_BRIEF.md"
    index: ".moonshot-relay/docs/agreements/README.md"
    keywords: ["domain", "component", "workflow"]
    summary: "Compact prompt-safe synopsis."
    mustConsultFor:
      - "architecture/planning/implementation condition"
```

`moonshot-architecture` must inspect applicable project-local anchors before architecture package generation, record which anchors were consulted, and load only the specific referenced agreement documents required for the current scope.

## References

- `README.md`
- `docs/public/development.md`
- `docs/public/repository-layout.md`
- `docs/public/installer-usage.md`
- `docs/public/guidelines/knowledge-repository-ops.md`
- `docs/public/guidelines/provider-neutral-model-routing.md`
- `docs/public/guidelines/resumable-session-layer.md`
- `rules/agents/agent-definition.md`
