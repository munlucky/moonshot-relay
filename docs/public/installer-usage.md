# Installer Usage

For a source checkout, run `npm ci` first. It builds the Kernel/Host runtime from `src/`. After source edits, run `npm run build`. Installers reject stale build output. Published runtime packages already contain executable `.mjs` files and do not require TypeScript. See [development.md](development.md).

`install-claude.sh` is a macOS/Git Bash compatibility installer for Moonshot Relay runtime profiles. The primary cross-platform account-root installer is `node bin/moonshot-relay.mjs install --runtime all` or `npx -y github:munlucky/moonshot-relay install`. Use `--project` only when a downstream repository needs project-local `.claude/` and `.codex/` compatibility payloads.

The default mode is account-root installation into the shared Moonshot Relay home (`~/.moonshot-relay`) plus the local Claude/Codex/Qwen homes (`~/.claude`, `~/.codex`, `~/.qwen`) and the Antigravity IDE profile (`~/.gemini/antigravity`) with its global skill discovery root (`~/.gemini/config`).

The shared Moonshot Relay home preserves canonical `skills/**` for internal references and source parity. Claude/Codex/Qwen profile-local and Antigravity global `skills/` discovery is governed by `package/runtime-surface.json`: `product-orchestrator`, `moonshot-architecture`, `moonshot-orchestrator`, `moonshot-phase-runner`, `moonshot-plan-writer`, `commit-moonshot`, `session-logger`, and `explain-diff-html`. Reinstalling prunes canonical source skills that are no longer in the service profile payload, while unrelated user-installed skills remain preserved.

## Kernel Codex command-skill default

When Codex `/` command discovery should use the Kernel skillset by default, install the direct account-root profile with the official Kernel installer:

```sh
node bin/moon-relay-kernel.mjs profile-install \
  --runtime codex --account-root \
  --target-root "${CODEX_HOME:-$HOME/.codex}" \
  --source-root .
```

This materializes the Kernel command skills, account guidance, project-only non-blocking track hook, and checksum manifest directly under the Codex account root. Known Moonshot Relay workflow skills are moved to a dated Kernel backup so the account discovery root exposes the Kernel surface without losing recovery data. Unselected ordinary Codex tasks are not forced through Kernel. This direct profile path does not use the Relay↔Kernel switcher.

Shared runtime references must resolve through `MOONSHOT_RELAY_HOME`. In `cmd.exe` this is `%MOONSHOT_RELAY_HOME%`, in PowerShell it is `$env:MOONSHOT_RELAY_HOME`, and in bash/zsh it is `${MOONSHOT_RELAY_HOME}`. Antigravity global skill discovery resolves through `ANTIGRAVITY_SKILLS_HOME`, defaulting to `~/.gemini/config`. If the variable is unset, installers and skills use the account default `~/.moonshot-relay`.

## Compatibility Window

The installer keeps runtime-discovered profile output stable for skills, agents, and Claude rules. Shared runtime assets such as tools, schemas, templates, docs, and support scripts live under `~/.moonshot-relay`. Workflow orchestration no longer installs `scripts/**` wholesale, so downstream docs or skills should depend on package-contract-listed support scripts rather than profile-local script paths.

The installer must not treat `.claude/skills`, `.claude/agents`, `.claude/scripts`, `.claude/bin`, `.claude/tools`, `.claude/schemas`, or `.claude/templates` in this repository as canonical source. Durable edits start in `skills/`, `agents/`, `rules/`, the allowlisted support files under `scripts/`, `bin/`, `tools/`, `schemas/`, `templates/`, `tests/`, `docs/public/`, or explicitly tracked source-design phase plans under `docs/implementation/<plan-slug>/`. Ordinary work planning defaults to `${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}/state/projects/<projectId>/planning/packages/<plan-slug>/`. Because new `docs/implementation/**` files are ignored by default, tracked-source plan packages require a slug-specific `.gitignore` exception from the bridge or a deliberate force-add.

Project-local installs are compatibility output. Run `bash install-claude.sh --project` from supported macOS/Git Bash shells to materialize them into the current repository. In WSL/Linux bash environments where `install-claude.sh` reports `unsupported shell: Linux`, use `node bin/moonshot-relay.mjs install --runtime all` or `node scripts/install-account-root-harness.mjs --runtime all`.

Project-local runtime bridges are explicit downstream adoption output. Run this from a repository that needs local phase-runner entrypoints:

```sh
moonshot-relay bridge --target . --plan-package docs/implementation/<plan-slug>
```

The bridge writes thin project-local entrypoints for `scripts/runtime-state.mjs`, `scripts/prepare-phase-runner-state.mjs`, `scripts/knowledge-context-build.mjs`, and `tools/sandbox/policy.mjs`. Each entrypoint delegates to `${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}` and defaults `MOONSHOT_RELAY_STATE_ROOT` to `.moonshot-relay/state`, so sandboxed project runs do not need to write into the account-root state directory. It also writes `verification.contract.yaml` and `.moonshot-relay/.gitignore`. When `--plan-package` is provided, the bridge adds `.gitignore` exceptions for that slugged `docs/implementation/<plan-slug>` package so plan, QA, scorecard, and handoff evidence can be tracked intentionally.

GitHub-based `npx` can run the same account-root installer without a source checkout:

```sh
npx -y github:munlucky/moonshot-relay install
```

Agent Skills CLI bootstraps the root `skills/` catalog and installs the `moonshot-relay-setup` skill:

```sh
npx skills add munlucky/moonshot-relay
```

This command does not execute arbitrary repository installers and may expose the source catalog during bootstrap. After it completes, invoke `moonshot-relay-setup` to run the account-root installer and materialize the smaller Claude/Codex/Qwen runtime discovery surface under `~/.moonshot-relay`, `~/.claude`, `~/.codex`, and `~/.qwen`. Use `node bin/moonshot-relay.mjs install --runtime all` when running directly from a source checkout, or `npx -y github:munlucky/moonshot-relay install` when the desired result is a one-command full account-root install. Use `bash install-claude.sh` only for the supported macOS/Git Bash compatibility path.

## Contributor Flow

For a source change:

1. Edit the canonical root directory first.
2. Update public docs if installed behavior changes.
3. Run the package and migration checks from the active phase contract.
4. Use `node bin/moonshot-relay.mjs install --dry-run --runtime all` to confirm account-root output. Use `bash install-claude.sh --project --dry-run` only from supported macOS/Git Bash shells when project-local compatibility output changes.

For harness/package/profile changes that will be adopted into the live account root, use the Operational Adoption Closeout before the live install:

1. Complete an independent completion audit and an independent operational adoption audit.
2. Run `node scripts/doctor.mjs check --json`.
3. Run `node scripts/skills-audit.mjs audit --lock skills.lock.json --runtime-surface package/runtime-surface.json --json`.
4. Run `npm run test:lab`, `npm run test:package`, `npm run test:eval`, and `npm test`.
5. Run `node package/build-package.mjs --runtime all --dry-run --json`.
6. Run `node bin/moonshot-relay.mjs install --runtime all --json` only after the source gates pass.
7. Require the installer JSON to include `installId`, `verification[]` with no missing or mismatch entries, and `profileSurfaceParity[]`; Codex managed canonical pruning must report `profileSurfaceParity[runtime=codex].extraCanonicalCount=0`.
8. Run the installed doctor against the installed common payload, not the source checkout: `node "$env:MOONSHOT_RELAY_HOME\scripts\doctor.mjs" check --repo-root "$env:MOONSHOT_RELAY_HOME" --lock "$env:MOONSHOT_RELAY_HOME\skills.lock.json" --runtime-surface "$env:MOONSHOT_RELAY_HOME\package\runtime-surface.json" --json`.
9. If commit/push closeout is requested, use `commit-moonshot` and verify `HEAD == origin/<branch>` after push.

Do not edit generated package payloads or runtime state to make a test pass. Generated state includes logs, caches, traces, browser artifacts, sqlite files, memorygraph data, and verification verdict JSON.

Durable source roadmaps that define harness direction or review contracts are tracked under `docs/public/roadmaps/`, including `docs/public/roadmaps/harness-control-plane-modernization/`. Source-local implementation plan packages may be tracked under `docs/implementation/<plan-slug>/` only in explicit tracked-source mode with a slug-specific allowlist. Normal plan-writer and review-loop artifacts belong under the account-root project planning namespace. Runtime execution scratch under account-root execution, `docs/implementation/**/execution/`, `docs/implementation/**/close/`, and `docs/implementation/**/archive/` must remain untracked and excluded from package payloads.

## GitHub Required Checks

Branch protection is a repository setting, not something this source package can apply by itself. Protect `main` with the following required checks:

- `CI / Node 20.x on ubuntu-latest`
- `CI / Node 20.x on windows-latest`
- `CI / Node 20.x on macos-latest`
- `CI / Node 22.x on ubuntu-latest`
- `CI / Node 22.x on windows-latest`
- `CI / Node 22.x on macos-latest`
- `CodeQL / Analyze JavaScript`
- `Dependency Review / Pull Request`

Require pull request review for changes under `scripts/`, `skills/`, `agents/`, `schemas/`, `package/`, `.github/`, and `docs/public/`. Do not allow direct pushes to `main` or bypasses for harness-critical roots.
Enable Dependabot alerts/security updates, secret scanning, and push protection in repository settings.

Track release gate status separately:

- `source-ci-ready`: tracked CI/security source exists, parses, and local dry-runs pass.
- `github-settings-applied`: branch protection, CODEOWNERS review, dependency review, secret scanning, and push protection are applied in GitHub UI/API with evidence.
- `release-protected`: source checks pass and GitHub settings evidence is attached.

Source files alone can only close `source-ci-ready`.
Do not claim `release-protected` from `.github/` files without GitHub settings/API evidence.

## Expected Dry-Run Signal

The default dry run should show `mode: account-root-direct` and target `~/.moonshot-relay`, `~/.claude`, `~/.codex`, and `~/.qwen`. A project dry run should show that the installer would create or update the downstream `.claude/` profile while preserving protected project-local files such as `PROJECT.md`, local settings, custom files, and environment files.

A bridge dry run should show only project-local bridge files and optional `.gitignore` plan-package exceptions. It must not copy shared runtime source, `node_modules`, generated state, or sqlite files into the downstream project.

## Rollout Smoke Levels

Keep rollout evidence separated by target:

- `source-smoke`: run from the checkout with source `scripts/runtime-state.mjs`.
- `package-smoke`: run from materialized `package/moonshot-relay/profile/scripts/runtime-state.mjs`.
- `temp-home-smoke`: install into explicit temp `--moonshot-home`, `--claude-home`, `--codex-home`, `--qwen-home`, `--antigravity-home`, and `--antigravity-skills-home` targets, then run the installed `runtime-state.mjs`.
- `live-account-root-smoke`: run only after explicit adoption approval and state preservation evidence.

`source-smoke`, `package-smoke`, and `temp-home-smoke` can close package readiness.
They cannot prove live adoption.
Live account-root adoption is a separate controlled step.

## State Preservation

The account-root installer must preserve:

- `${MOONSHOT_RELAY_HOME}/state/**`
- Claude protected profile state such as `settings.json`, `memory.json`, `sessions/`, `cache/`, `plugins/`, `projects/`, and telemetry state
- Codex protected profile state such as `auth.json`, `config.toml`, `sessions/`, `cache/`, `plugins/`, `memories/`, and sqlite state
- unrelated user-installed skills and agents

Package payloads must continue excluding generated DB/WAL/SHM files, verdict JSON, traces, logs, caches, browser artifacts, memorygraph DBs, and profile-local state.

## Rollback Checklist

Before live adoption, capture:

- install command and `installId`
- dry-run JSON for all runtimes
- temp-home smoke JSON
- list of preserved state roots
- backup directory paths from the install manifest when backup is enabled
- command to restore from backup or rerun the previous released installer

If native dependency smoke returns `missing_native_module`, record it as `typed_degraded_authority_blocked`.
Do not count degraded native dependency evidence as runtime availability.
