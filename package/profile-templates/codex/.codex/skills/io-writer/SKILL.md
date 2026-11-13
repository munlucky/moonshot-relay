---
name: io-writer
description: Use Luna to prepare a clearly specified new file and apply its isolated candidate with the ordinary Codex shell tool.
---

# New-file Writer

The user selects the Writer by submitting this request in a Codex session with
the installed Moonshot Relay Writer hook enabled and Full Access selected:

```text
Writer: path/to/new-file.mjs
References: path/to/guide.md, path/to/example.mjs

Describe the new file, its behavior, and acceptance conditions.
```

Use one new relative destination and at least one existing relative reference.
Separate references with a comma and a space.

If the hook returns a candidate, run its existing `io-apply` command once with
the ordinary shell tool from the current project directory. Report the saved
path and actual result. A failed generation or apply should be reported with
its status. Keep any user-requested tests or review in ordinary Codex tools.

If a user invokes the Skill without the required request form, show the form
and the permission mode it requires.
