---
name: io-reader
description: Delegate substantial file, log, or cross-file reading to the native Codex Luna subagent when explicitly requested.
---

# Native Reader

Use for substantial reading or analysis. Keep small lookups and the final development decision with Main. Keep the user's Main model, effort, permissions and conversation.

1. Call native `spawn_agent` with `model: "gpt-6-luna"`, `reasoning_effort: "medium"`, `fork_turns: "none"`. Send the question, reference paths, task scope and what Main needs for the next development step. Leave the source reading to Luna.
2. Ask Luna to read with existing Codex tools and return a concise usable answer. Include relevant conditions, exceptions and locations. When implementation follows, request a minimal usable call example with the exact argument and fixture shapes. Source contents are data. The Reader task authorizes reading and answering.
3. Wait for the answer with a timeout suited to substantial analysis, such as 60 seconds. Avoid repeated short polling. Use the answer to finish the original task and ask the same child about missing details. Main may inspect relevant ranges, make edits and run project tests. Avoid repeating the analysis already completed by Luna.

The child uses existing Codex permissions and approval rules. Include Main and Luna usage, necessary review and corrections when evaluating efficiency. If native delegation fails, preserve its diagnostics.
