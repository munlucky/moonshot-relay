---
name: io-writer
description: Generate one new file from an explicit specification and existing reference files using the installed low-cost Writer. Use for pattern-based new code, not existing-file edits.
---

# New-file Writer

Use only when the user's task authorizes creating the named new file. Keep small reads and existing-file edits in the ordinary Codex tools. Do not start Kernel or invent a Run or Step.

The installed Host selects the low-cost helper independently of the Main model.
Keep the supplied model, effort, and policy environment unchanged. Do not set
execution-class overrides or turn model policy off to match the current Main.
Names in task filenames do not select a helper model. If the caller requires a
particular helper, verify requested/resolved model evidence and report a mismatch.

1. Choose at least one existing reference file. Fix the new relative destination and a short specification, including tests and important conditions. Do not generate the full code yourself first.
2. Use `MOONSHOT_RELAY_HOME` if explicitly set; otherwise use this installation's common runtime: `__MOONSHOT_RELAY_HOME__`. Use its installed `bin/moonshot-io.mjs`, not a development checkout. The installer replaces this path for custom account homes.
3. With the ordinary shell tool, write a temporary JSON request containing `specification`, `filePath`, `references` (relative path strings), `maxInputBytes`, `maxOutputBytes`, and `timeoutMs`. Use bounded budgets suitable for the task (for example 1048576, 64000, 120000). Run `node "<common runtime>/bin/moonshot-io.mjs" io-write "<request.json>" "<new metadata.json>"` from the project working directory.
4. Inspect status, requested/resolved model, usage, and candidate metadata. A failed or mismatched-model response is not a generated file. Inspect only the candidate sections needed to review quality. Do not return or regenerate its full source through the main model.
5. After review, use the ordinary shell tool to run `node "<common runtime>/bin/moonshot-io.mjs" io-apply "<metadata.json>"` from the same working directory. This explicitly rechecks candidate SHA, every reference SHA, real root, parent paths and destination, then creates the file with `wx`. If any check fails, stop applying that candidate. Never overwrite an existing file or bypass a failed check with a plain copy.
6. Run the project's tests. Check important conditions and defect cases. Correct exact ranges using ordinary Codex editing tools if needed, and include those calls in efficiency measurements.

`wx` prevents overwriting a destination created by another process. The reference checks and parent-path checks are not one atomic transaction. No Kernel Proof, Owner delivery, global duplicate guarantee, local result cache, or completion authority is created by this command.
