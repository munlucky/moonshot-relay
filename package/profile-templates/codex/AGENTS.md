# Moon Relay Kernel — Codex Repository Contract

Durable repository guidance for Codex sessions on a Kernel track. Loaded on
every session, so it stays short. Execution settings are decided per turn by the
Host and are deliberately absent from this file.

## Repository Structure

- `bin/` — CLI entrypoints (`moon-relay-kernel.mjs`, `moonshot-relay.mjs`).
- `src/kernel/` — canonical Kernel core: contract, capsule, evidence, knowledge, state.
- `src/host/kernel/` — canonical Host prompt, provider policies, adapters.
- `scripts/kernel/` and `scripts/host/kernel/` — generated runtime outputs; edit `src/`, not these outputs.
- `schemas/` — published contract schemas.
- `tests/` — `node --test` suites; the active suite is defined in `package.json`.

## Commands

```bash
npm test                  # full active suite
npm run test:kernel       # Kernel suites only
npm run test:routing      # provider routing and profile contracts
node bin/moon-relay-kernel.mjs doctor
```

## Engineering Constraints

- The Kernel core stays provider-neutral: no provider model id, SDK, endpoint,
  or credential below `src/kernel/`.
- Unmeasured telemetry is `null`, never `0`.
- Preserve declared compatibility windows, supported runtimes, user data, and
  additive schema and database migrations. Remove obsolete paths only through
  an explicit, versioned replacement or migration path.
- Changes stay inside the current work unit's declared paths.

## Do Not

- Do not mutate unrelated files in the user's Codex configuration; Kernel operates
  in the native provider home without taking ownership of it.
- Do not remove a supported fallback, compatibility wrapper, or migration path
  merely to simplify the implementation. Remove it only when its support window has ended
  and its replacement and rollback path are verified.
- Do not weaken Route Admission, Review Receipt independence, or the Kernel's
  completion authority to make a check pass.
- Do not run verification commands as a substitute for Kernel evidence.

## Done and Verification

Work is done when the Kernel returns the `done` action. Name the verification
commands for the current obligation; the Kernel runtime executes them and owns
the result. Detailed planning, review, and architecture procedure lives in the
Kernel skills, not in this file.
