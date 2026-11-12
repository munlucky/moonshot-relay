---
name: io-writer
description: Delegate a clearly specified new file to the native Codex Luna subagent when explicitly requested.
---

# Native Writer

Use for an authorized new file with a clear specification. Keep small edits and final development decisions with Main. Keep the user's Main model, effort, permissions and conversation.

1. Call native `spawn_agent` with `model: "gpt-6-luna"`, `reasoning_effort: "medium"`, `fork_turns: "none"`. Send the specification, reference paths, new destination and acceptance conditions. Leave reference reading and file creation to Luna.
2. Ask Luna to use existing Codex tools, create only the named file, check it against the acceptance conditions and return its path with a short result. Include the checks actually run and any remaining acceptance questions. It should report an existing destination or a blocked operation. Wait with a timeout suited to the work, such as 60 seconds, before starting review. Avoid repeated short polling.
3. Main uses the result for the needed review, project tests and corrections. Ask the same child for missing details and inspect relevant parts when needed. Avoid repeating the source analysis or regenerating the file merely to confirm creation.

The child uses existing Codex permissions and approval rules. The named scope is a task instruction. Include Main and Luna usage, review and corrections when evaluating efficiency. Preserve diagnostics on failure.
