---
name: io-writer
description: Generate and save one new file with the installed low-cost Writer when explicitly delegated or testing I/O delegation. Default adoption is pending measured economics. Not for existing-file edits.
---

# New-file Writer

Use for explicit delegation or evaluation while economic adoption is pending. The user's task must authorize creating the named new file. Keep small reads and existing-file edits in ordinary Codex tools. Do not start Kernel or invent a Run or Step.

The installed Host selects the low-cost helper independently of the Main model.
Keep the supplied model, effort, and policy environment unchanged. Do not set
execution-class overrides or turn model policy off to match the current Main.
Names in task filenames do not select a helper model. If the caller requires a
particular helper, verify requested/resolved model evidence and report a mismatch.

1. Choose existing reference paths, the new relative destination, and a short specification with important conditions. Do not first generate the full code or reread all references just to delegate.
2. Use `MOONSHOT_RELAY_HOME` if explicitly set; otherwise use this installation's common runtime: `__MOONSHOT_RELAY_HOME__`. From the project directory, pipe one JSON request to `node "<common runtime>/bin/moonshot-io.mjs" io-write - --apply`. Fields: `specification`, `filePath`, `references` (relative path strings), `maxInputBytes`, `maxOutputBytes`, `timeoutMs`. Example budgets: 1048576, 64000, 120000. Check the short result, model identity and usage. `created` means the file was saved, not that its code passed tests. No separate metadata read or io-apply call is required. On failure, preserve the diagnostics and stop; never regenerate automatically or bypass a failed file check.
3. Perform the review, project tests, and exact-range edits needed for the original task with ordinary Codex tools. Do not require a full candidate read or an additional review package. Include necessary reads, tests and repairs in efficiency measurements.

The Host keeps candidate generation, SHA/path checks and `wx` saving in one call. `wx` prevents destination overwrite; reference and parent checks are not one atomic transaction. `io-write` without `--apply` and explicit `io-apply` remain available for candidate-only callers. Kernel always retains its bound candidate and Owner path. No local result cache is created.
