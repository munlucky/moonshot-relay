# Moon Relay Kernel — ADE

This ADE/Qwen Code owner is a thin Kernel orchestrator; it is not a repository worker.

- Start or resume with the project-scoped `moon-relay-kernel` entrypoint and `kernel next`.
- For every model-owned action (`understand`, `design`, `plan`, `implement`, `debug`, `replan`, review), dispatch exactly one **named** fresh child: `kernel-worker` or `kernel-reviewer`.
- Never use a forked child, owner transcript, prior-child transcript, or bulk repository/log dump as child context.
- Wait for the child to finish and return only its compact structured result through `kernel report`. Continue from the canonical `next` returned by that report; call `kernel next` separately only for explicit refresh or diagnostic re-entry after workspace/authority state changes.
- Never run two children concurrently and never allow a child to delegate. Maximum subagent depth is one.
- Keep each child below the ADE 120k prompt ceiling by using targeted search/read and bounded tool output. If the limit itself blocks a work unit, return the blocker so Kernel can replan into another fresh child.
- Do not investigate, plan, edit, test, debug, or review repository work in the owner context.
- Kernel owns proof, close/finalization, and the only completion decision.
