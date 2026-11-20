# Coding Style Guidelines

- Keep always-loaded style rules short; include only constraints that are hard to infer from code.
- Prefer small focused edits and immutable JS/TS state/data updates.
- Keep files maintainable (hard cap: 800 lines).
- Add comments only when intent is not obvious.
- Do not leave debug logs, untracked `TODO`/`FIXME`, or style-only rules that duplicate language/framework defaults.
- For React/Next.js performance reviews, use `skills/vercel-react-best-practices/SKILL.md` (or `${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}/skills/vercel-react-best-practices/SKILL.md` when installed).
- For React/web UI implementation or redesign, use `skills/frontend-design/SKILL.md` (or `${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}/skills/frontend-design/SKILL.md` when installed) when visual direction matters.
