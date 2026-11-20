---
name: kernel-commit-closeout
description: Internal Kernel skill for explicit, approved Git closeout after completion acceptance.
user-invocable: false
---

# Kernel Commit Closeout Skill

Use for explicit, user-approved Git closeout (commit & push) after Kernel completion acceptance. Knowledge closeout is non-blocking and does not gate Git closeout.

## Hard Rules

- Require explicit user/task approval receipt before executing git operations.
- Exclude all generated, runtime, secret, and `.moonshot-relay` paths.
- Require Kernel completion acceptance prior to Git closeout (knowledge commit receipt is non-blocking).
- Verify remote parity when push is requested.
