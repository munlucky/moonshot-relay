# Agent-directed recovery in the native Kernel loop

An unexpected condition is a work input. The Kernel describes what is known,
what authority is still valid, and how to inspect and repair it. The agent
investigates the cause; the Kernel retains binding, scope, proof and completion
authority. The same procedure handles unfamiliar errors without a catalog of
special-case fallbacks or a separate recovery state machine.

## Observe, repair, revalidate, continue

1. Inspect the failure receipt's `recovery` capsule. If current evidence is
   missing, run `kernel next [run-id] --diagnose --json`. Use explicit
   `--project-root` and `--runtime-home` when resolving a binding problem.
2. Compare Run/worktree/owner identity, revisions, changed files, dependencies
   and command output. Identify whether the cause is a harness defect, local
   environment change, a project defect or an actual missing user decision.
   An unknown error code still gets a diagnosis work unit.
3. Repair within the current next work unit's `allowedPaths`. A verified
   recovery scope never expands that permission. With missing authority or
   another owner, inspection is read-only; obtain a valid native next work
   unit, use a supported binding procedure, or choose an isolated worktree.
   For out-of-scope repairs, revise a bounded task contract through next.
4. Observe again after repair. Pass the last capsule as
   `--previous-recovery-json <file>` to `next --diagnose` for progress comparison.
   Three unchanged comparisons produce `mode=escalate`: report a concrete
   blocker with the attempted repair and evidence instead of repeating commands.
5. Resume the capsule's `commands.resume` through native next. If no Run exists,
   supply the corrected task contract. Report actual changed paths and request
   the currently bound verification commands. Only final Kernel `done` is
   completion; diagnosis or an agent's explanation is never verification proof.

The previous capsule is a progress hint, not trusted authority. Omitting or
editing it cannot grant mutation rights, mark proof passed, or reset Run history.
The repeated-condition budget applies to comparisons supplied to diagnosis;
the owner must retain the last capsule across retries.

## Derived-state reconciliation

`kernel next --diagnose --reconcile-derived-state --json` may quarantine
address-book records proved absent from an existing, readable authoritative
Run DB. This preserves the reference for investigation and allows clean
rediscovery. It never deletes Runs, changes accepted proof, steals a lease,
or creates a DB to make a stale reference appear valid. Missing/corrupt stores,
binding mismatches, and live records stay visible for agent inspection.

Failed bootstrap also reconciles the locator belonging to the rolled-back
initialization. Explicit Run targets remain explicit. A Run found by automatic
discovery is not injected as an explicit predecessor when starting a new task.

## Failure and proof boundaries

CLI errors retain the original error code and nonzero exit status and include
a recovery capsule. Existing blocked and contract-rejected control-plane
responses expose the same work description. `next --diagnose` reads Run and
owner state without migrations or lease acquisition; derived reconciliation
is the only optional write, and requires the Kernel track.

Repair proposals must not directly edit runtime SQLite, forge receipts, discard
local edits, weaken verification, or claim another session's owner binding.
Safety denials remain inspect-only. A workspace or authority change produces
a fresh fingerprint and invalidates the old description; native next/report
then decides which proof must be rerun.

## Account adoption with user skill ownership

For a catalog skill that already exists outside the Kernel profile manifest,
`profile-install --account-root --preserve-unmanaged-skills` preserves the whole
user-owned skill directory and records its name in `preservedUnmanagedSkills`.
It never claims those files or treats them as Kernel managed proof. The Kernel
entrypoint remains mandatory, and managed file drift still uses normal collision
admission. Later refreshes remember explicitly preserved names; default installs
continue to reject newly discovered conflicting unmanaged skills.
