# `.codex` Development Profile

`.codex/` is this repository's local Codex development profile. It is kept for active agent usability during the repository layout migration, not as the canonical source for reusable workflow assets.

## Source Boundaries

Canonical source belongs in the root-level directories declared by `package/package-contract.yaml`:

- `skills/`
- `agents/`
- `rules/`
- `scripts/`
- `schemas/`
- `templates/`
- `tests/`
- `docs/public/`

The `.codex/skills`, `.codex/agents`, and `.codex/rules` trees are Codex service-profile exposure. Common harness scripts, schemas, templates, CLI entrypoints, runtime tools, and public docs are installed under `${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}`. Claude `.claude/skills`, `.claude/agents`, and `.claude/rules` are Claude service-profile exposure, not Codex source. When editing durable skills, agents, rules, scripts, schemas, templates, or tests, update the canonical root first and materialize profile output from that source.

## Always-Loaded Profile

- `.codex/AGENTS.md` stays a short TOC for active Codex runtime instructions.
- `.codex/config.toml` stores Codex runtime integration examples.
- `.codex/skills/**`, `.codex/agents/**`, and `.codex/rules/**` expose Codex service behavior.
- `.codex/verification.contract.yaml` remains the Codex profile verification contract path during migration.
- Provider/model selection is Host-owned. Do not duplicate model IDs, reasoning effort, pricing guards, or temporary provider workarounds in the always-loaded profile.
- Project-specific execution rules belong in the consuming project's `AGENTS.md` or a selected skill, not in the account-wide profile.

## Generated State

Generated state is not source and is never part of package payloads. Excluded state includes logs, cache, traces, browser artifacts, browser runtime materialization, sqlite runtime state, memorygraph data, temporary directories, audit outputs, and transient verification verdict JSON.

Use `tests/package-materialization.test.mjs` to verify the development profile boundary and generated state exclusions.
