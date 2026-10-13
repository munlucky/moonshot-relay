# Governed Git closeout and agent recovery

Standalone `kernel-commit` and native finalization share the Kernel closeout
orchestrator and Host Git operations. They retain one completion authority,
one pre-push checkpoint and one durable Git receipt. A failure enters the
[common agent recovery loop](kernel-agent-recovery.md); a new error code does
not require a new fallback workflow.

The staging inventory uses NUL-delimited Git status with all untracked files,
preserving exact filenames and both sides of renames. Host staging uses literal
pathspecs and an isolated index. Pre-staged user changes cause an explicit stop;
they are never silently incorporated or discarded. Branch updates compare the
expected HEAD, including an absent ref for the first commit.

Normal admission includes the accepted lineage's passed implementation waves,
not only the final report. Source identity, mutation revision, completed
decision and the full current workspace must still match. Failed attempts
cannot add paths to the admitted inventory.

For a new repository, an explicit `--initial-paths-json` JSON array declares
the full initial source inventory. It requires an explicit accepted Run and
an unborn branch. Every path must match the current inventory and Run scope.
Additional baseline files must retain their original content and index state;
foreign additions, missing entries, changed baselines and workspace drift are
rejected. The receipt records this inventory and its mutation admission.

The shared staging boundary permits `.env.example` documentation only after
checking it is a small regular file with placeholders for credential values.
Credential-bearing templates, symlinks, provider state, databases and live
environment files remain denied.

The Kernel records `commit_created` before attempting a push. The first push
sets the upstream branch, and the receipt requires remote SHA parity. After
fixing a remote or local prerequisite, repeat `kernel-commit --run-id <id>
--push`. Only the clean current commit already recorded for that project may
resume; unreceipted or externally advanced HEAD cannot be pushed through this
path. Retry preserves the commit and obtains fresh remote evidence.

Diagnosis is a work description, not proof. The agent inspects owner, scope,
workspace and dependencies, repairs within a valid next work unit, revalidates
and resumes. Authority changes require a fresh native next/report boundary;
three unchanged diagnosis comparisons escalate a concrete blocker. Neither
ordinary Git fallback nor edited SQLite/receipts are part of recovery.
