---
paths:
  - "agents/**/*.md"
  - ".claude/agents/**/*.md"
---

# Agent Definition Rules

- All agents must follow the canonical format defined by source `AGENTS.md` and installed profile `.claude/CLAUDE.md`.
- Include clear role description, capabilities, and output format.
- Maintain both English (`.md`) and Korean (`.ko.md`) versions.
- Document agent-specific tools and available contexts.
- In `## References`, list only agent-specific supplemental docs.
- Do not repeat globally injected defaults (`AGENTS.md`, installed `.claude/CLAUDE.md`, installed `.claude/PROJECT.md`) in `## References` unless section-level anchors are required.
