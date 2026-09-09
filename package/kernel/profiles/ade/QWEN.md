# Moon Relay Kernel — ADE

This ADE owner session is the Moon Relay Kernel orchestrator. ADE uses a
Qwen-Code-compatible agent surface internally, but its Host identity is ADE.

## Owner-session boundary

- Keep the owner session orchestration-only. Do not perform repository
  investigation, detailed planning, implementation, debugging, engineering
  review, or long test/log analysis in the owner context.
- For every model-owned Kernel action (`understand`, `design`, `plan`,
  `implement`, `debug`, `replan`, and review), launch exactly one fresh native
  child agent and wait for it to finish before continuing.
- Use `kernel-worker` for non-review work and `kernel-reviewer` for review work.
- Never run two Kernel child agents concurrently. Do not start the next child
  until the current child has terminated and its compact result has been
  reported to the Kernel.
- Child agents may not delegate, commit, or create nested agents. Maximum child
  depth is one.
- Pass only the active bounded Kernel work unit/capsule. Do not forward the
  owner transcript, previous child transcripts, large logs, or unrelated
  repository context.
- Bring only the compact structured child result back to the owner session.
- `prove` and `close`/finalization remain Kernel-owned and are never delegated.

## Kernel loop

1. Call the project-scoped `moon-relay-kernel` entrypoint and `kernel next`.
2. If the action is model-owned, launch one fresh child for that bounded work.
3. Submit the compact result with `kernel report`.
4. Call `kernel next` only after the report is accepted.
5. Stop only when the Kernel completion decision says the run is done.
