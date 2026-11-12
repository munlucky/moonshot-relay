# Host-owned I/O

Reviewed: 2026-11-12

## Standalone Codex I/O

The explicit `bin/moonshot-io.mjs` entrypoint provides `io-read`, `io-write` and
an explicitly requested `io-apply` without a Kernel Run or Step. These commands
reuse the same Reader/Writer execution, file hashes, no-tools
transport and Host model registry. Kernel MCP continues to require its existing
Run/Step binding; an authorization failure never falls back to standalone mode.

The Reader accepts a question and existing relative reference paths. The Writer
accepts a fixed specification, one new destination, and at least one existing
reference. Both require explicit byte and time budgets. The CLI acquires source
hashes locally. Reader returns plain `answer` text and Host-supplied snapshot
`sources` (path/hash), not validated claim citations. Missing or repeated quotes
do not fail an answer. Empty responses fail; bounded previews are `truncated`;
source changes retain a `stale` answer. Changed authority and forbidden tool
events still fail without exposing a normal answer. There is no semantic-review
or coverage completion field in the tool contract.

Writer results contain metadata and reference hashes, not the generated code.
The ordinary `io-write - --apply` command accepts stdin JSON and generates and
saves the named new file in one call. It reuses the isolated candidate and
`io-apply` checks. `created` means saved, not tested or correct. The successful
call removes only its own candidate directory; failed candidates and known
usage remain available for diagnosis. No retry or automatic repair is performed.
Candidate-only `io-write` and explicit `io-apply` remain available. Kernel never
uses the standalone apply path. `io-apply` rechecks the candidate and every reference,
the real workspace root, parent paths and destination, then creates the file
with `wx`. It does not overwrite an existing target. A failed partial write is
reported with the observed destination state; the caller must inspect it.
These checks are not a transaction across reference files and directory paths.

```text
node <common-runtime>/bin/moonshot-io.mjs io-read -
node <common-runtime>/bin/moonshot-io.mjs io-write - --apply
node <common-runtime>/bin/moonshot-io.mjs io-write request.json [metadata.json]
```

Pipe JSON with `question` or `specification`/`filePath`, existing `references`
(relative path strings), `maxInputBytes`, `maxOutputBytes`, and `timeoutMs`.
File input remains supported. Optional metadata output is preflighted before
the model call and created exclusively. A later save failure returns the received
result and usage on stdout with `metadataFailure`, and exits unsuccessfully.
Standalone CLI results omit Kernel Proof/Owner/completion fields. Necessary
review, project tests and exact edits remain ordinary Codex work, not new I/O
tool features. The account-condition comparison does not justify default adoption;
the Reader Hook stays disabled and Writer is for explicit delegation/evaluation.

Install through the existing account-root installer:

```text
node scripts/install-account-root-harness.mjs --runtime codex --codex-io-only --io-reader-min-lines 350 --json
```

`--codex-io-only` preserves the current account profile, configuration and other
skills. The common runtime is installed at `MOONSHOT_RELAY_HOME` (by default
`~/.moonshot-relay`). `CODEX_HOME` and explicit home options are supported. The
existing manifest owns each exact Reader Hook definition and its script/Writer
Skill bytes separately from the shared `hooks.json`. Modified or unowned I/O
entries are conflicts. Unrelated user hooks, even with the same matcher, remain.
Updating or downgrading removes only entries whose ownership still matches.

The narrow PreToolUse Hook recognizes plain `Get-Content`, `Get-Content -Raw`
and `cat` full-file reads. It allows small files, searches, bounded reads and
complex shell expressions. It does not call a model. It denies eligible reads
with the installed Reader command and request format only when the entrypoint,
local authentication material and bounded input path are available. Expired
authentication and service availability still require actual execution checks.
New or changed Hooks need Codex trust review; the installer does not grant trust
or modify `config.toml`. Hook errors and timeouts can allow the original tool.
The Hook is a workflow guardrail, not an OS security boundary.

Local result caching and reuse of previous validation results are out of scope.
Provider-reported cached token counts are usage measurements, not a local cache.
Account installation, new-session E2E and economic acceptance remain separate
verification gates. The development calls alone do not establish those gates.

### Thin I/O refactor evaluation, 2026-11-12

The current refactor removes mandatory Reader fact/citation validation and
connects standalone stdin Writer generation and saving in one call. Actual
account sessions confirmed plain Reader answers and one-call file creation with
requested/resolved Luna. Kernel remains bound and candidate-only. See the
[requirement audit and full results](../roadmaps/spotify-io-structural-recovery-2026-11-11/RESULTS.ko.md).

The native `0.167.0-alpha.4.1` comparison completed all 36 attempts and external
AI content reviews. Reader content passed 9/9 direct and 8/9 delegated; Writer
passed 9/9 direct and 4/9 delegated after allowed ordinary task work. Conservatively
counting a task-prompt repair deviation gives 3/9 compliant delegated Writer
completions. Raw tokens increased from 1,030,386 to 1,411,898 for Reader and from
1,099,260 to 1,741,828 for Writer. No task met all adoption conditions.

The Writer pilot passed functional return/save but failed content; continuing
the full comparison violated its stricter preregistered pilot-content gate.
One Writer repaired omissions after passing tests despite a task prompt allowing
repairs after test failure only. Both deviations and every failure remain in
the report. These are descriptive non-adoption results, not clean preregistered
adoption proof. The earlier native3 quota failures and pre-refactor v3 records
remain separate and unchanged. Hypothetical resource units are not billing or
subscription measurements.

Keep the Reader Hook disabled and Writer explicit/evaluation-only. Functional
implementation and installation do not establish quality equivalence or savings.

### Historical ordinary Codex v3 evaluation, 2026-11-11

The following records describe the pre-refactor citation/candidate workflow.
They are preserved and are not results for the new thin I/O contract.
This evaluation supersedes the older Kernel/Sol-only experiments below for
ordinary Codex adoption. It used native Codex `0.167.0-alpha.3.2`, the same
Sol/medium Main in both arms, the installed I/O profile, and one Luna helper
per delegated attempt. Reader and Writer were tested independently. Separate
installed-profile development calls also verified requested/resolved Luna
with both Sol and Terra Main models.

The protocol was registered before dispatch: three Reader and three Writer
tasks, three A/B repetitions each, alternating order, 36 Main task turns and
18 helper calls. Protocol SHA256:
`856e49aa7e2fe4e686e40c1bf1b3c1df10b8c4c846e5e39628d9bacec6509cd2`.
Adoption required every task to pass all quality gates in all repetitions,
at least 15% lower completed-task cost and no more than 25% greater completion
time. Failed attempts were retained. Exact generated-file repairs within the
original Main turn were allowed and counted; no task/helper was redispatched.

Costs are hypothetical normalized resource weights, not prices or observed
subscription charges. Sol input/cached-input/output weights were 1/0.1/8;
Luna weights were 0.25/0.025/2. Reported cache-write weights were 1.25 and
0.3125 respectively; every observed cache-write count was zero. Input counts
include cached subsets; those subsets are not added twice. All required Main
and helper usage was present. A no-cache sensitivity is also retained in the
local analysis. No local cache or validation-result reuse was introduced.

| Task | Full-quality A / B | A / B assumed units per completion | B cost change | B time change | Decision |
| --- | --- | --- | --- | --- | --- |
| Large single-file Reader | 3/3 / 0/3 | 42,017.33 / undefined | undefined | undefined | NO_ADOPT |
| Larger single-file Reader | 0/3 / 0/3 | undefined / undefined | undefined | undefined | NO_ADOPT |
| Cross-file Reader | 1/3 / 0/3 | 240,791.60 / undefined | undefined | undefined | NO_ADOPT |
| Single-reference test Writer | 3/3 / 3/3 | 37,414.13 / 71,845.60 | +92.03% | +26.44% | NO_ADOPT |
| Multi-reference test Writer | 3/3 / 3/3 | 58,277.93 / 108,160.05 | +85.59% | +34.56% | NO_ADOPT |
| Small-helper test Writer | 3/3 / 3/3 | 19,583.13 / 37,582.97 | +91.91% | +57.78% | NO_ADOPT |

All nine delegated Reader attempts stopped with `host_io_citation_invalid`;
no unsupported evidence was accepted. Direct answers were semantically
accurate in all nine reviews, but five omitted separately registered fact
symbols. Those coverage failures were not waived. Reader totals were 754,321
versus 1,314,402 input-plus-output tokens. Its lower delegated assumed-cost
subtotal is not a saving: there were zero completed delegated tasks.

Both Writer arms completed all nine tasks with the frozen normal tests,
semantic checks and 12/24/4 registered mutation checks per corresponding
task. Total raw tokens rose from 758,121 to 2,607,152; assumed units rose from
345,825.60 to 652,765.85 and measured completion time from 791,903 to
1,069,566 ms. Lower Main output alone did not offset extra Main inputs,
candidate review, helper calls and repair work.

One multi-reference Writer initially failed ten normal tests. Main repaired
the exact generated-file ranges within the original turn; final normal and
mutation gates passed. The raw collector marked its connection false because
a shell command applied successfully and then exited 1 from the first tests.
Offline audit verified the structured `created` record against the original
candidate path/hash/bytes. Raw receipts were preserved; the quality criteria,
repair policy, costs and elapsed times did not change.

The external semantic study review was performed by the current Codex AI,
not a human or independent agent. The protocol's reference to human review
was a wording error recorded in the method notes. Study construction and
external oracle-review overhead were not metered per production task.
Production Main review, helper calls, repair and deterministic gates were
included. These results establish neither savings for study overhead nor
actual subscription debit.

Both features are `ECONOMIC_NO_ADOPT` on this sample. The account Reader Hook
must remain disabled by default after connection testing. The explicit
Reader command and opt-in Writer Skill remain available; no automatic
Reader-to-Writer chain or new routing policy was added. Functional connection
and installation evidence do not establish reliable large-input Reader
quality or token savings.

### Account-root acceptance

The existing installer deployed the common runtime and three owned Codex I/O
records. The installation-time snapshot verified unchanged `config.toml`,
`AGENTS.md`, all 580 existing Skill files and previous Hook definitions.
The subsequent native `/hooks` review intentionally added trust and toggled
only the inspected Reader Hook; final configuration bytes therefore differ
from the pre-trust snapshot. No trust hash or configuration was fabricated.
The final UI showed PreToolUse installed 1 / active 0 and the existing
SessionStart installed 1 / active 1. The installer itself never grants trust.

Fresh ordinary native Codex sessions used the actual account installation,
without Kernel environment or a Run, trust bypass or `--ignore-rules`.
The installed I/O runtime matched the frozen study bytes; target-home paths
were rendered separately in the wrapper and Writer Skill.

| v3 condition | Observed result |
| --- | --- |
| C01 installation | PASS: existing installer, installed common paths, owned Hook/Skill, preservation/update/downgrade/conflict/rollback checks |
| C02 independent Reader | PASS for account connection fixture: accurate strict booleans, proof and safe/matching revision conditions; requested/resolved Luna |
| C03 actual Hook surface | PASS: native `Bash` full PowerShell read denied before execution, then one installed Reader call |
| C04 ordinary tools | PASS: small full read, bounded read, exact `rg`, existing-file one-line edit, no helper |
| C05 Writer apply | PASS: one Luna candidate, explicit installed `io-apply`, all 12 named account tests; seven installed-CLI integrity/race cases |
| C06 model separation | PASS: Sol and Terra Main installed-profile probes used requested/resolved Luna for Reader and Writer; account Sol E2E reconfirmed both |
| C07 quality counterexamples | Reader NO_ADOPT on large study tasks; Writer passed all registered normal/mutation/semantic gates; tool-event/path/hash/duplicate rejection retained |
| C08 total efficiency | Both ECONOMIC_NO_ADOPT after all 36 preregistered attempts; required usage present, actual subscription debit NOT_MEASURED |
| C09 Kernel authority | PASS regressions: bound MCP still requires its Run/Step authority; no standalone fallback; Worker delegation/proof/Owner guards unchanged |
| C10 installed new sessions | PASS for Reader connection, ordinary tools and Writer apply/tests using actual account paths |

Installed-CLI safety cases changed the reference or candidate, supplied a bad
hash, placed a junction in the destination or candidate parent, precreated the
destination, and raced two creates. All rejected unsafe application or kept
exactly one exclusive-create winner; existing/source bytes were preserved.
A separate injected partial-write test verified the explicit failure state.
This does not establish OS isolation or atomicity across references/parents.

Current code checks passed: Host/transport/MCP code closeout 180 tests with two
POSIX-only skips, standalone/integrity group seven tests, and focused package,
profile and installer group 39 tests. These groups overlap and are not a unique
test total. Typecheck, source build/drift, dependency boundaries and diff checks
passed. The first package check exposed and retained evidence of a Windows
manifest duplicate; portable path comparison fixed it and the focused rerun
passed. No generated logs, evaluation state or candidate files belong in source.

## Kernel-bound Writer

The optional Writer returns one candidate file for a **fixed Host specification**.
It runs inside the existing Run and Work Unit. It does not create a Step, writable
Worker, proof receipt, Owner mutation, report, or completion decision.

## Selection

`createLocalWorkerControl({ projectRoot, runtimeHome, env, ioWriter: {} })` enables
the Host-only `io-write` request on that control instance. Without this explicit
option, the action returns `host_io_not_enabled`. Normal `start` and `resume`
never invoke it. No model-facing tool or `canDelegate` permission is added.

Use it only when the Host already has the exact file specification and has
evidence that separating I/O helps that workload. A cheaper model is not a reason
to add another planning call. In particular, the default Codex `standard` model
policy already selects a low-cost Worker. The Writer adds no proven saving to
that ordinary path. It is a development pilot, not a default adoption policy.

Model and effort use the existing Host registry, explicit invocation overrides,
and Codex `standard` policy. Provider IDs and prices are not duplicated here.
An explicit Host can supply `ioWriter.overrides` and `ioWriter.transportOptions`.
Do not grant those options to a Worker or copy the Owner's session credentials
into a Worker environment. This API uses the existing trusted Host boundary; it
does not establish OS isolation between processes with the same user identity.

### Local CLI and Kernel MCP

The owning Host can enable the same implementation at process startup:

```text
node bin/moon-relay-kernel.mjs worker-host --project-root <worktree> --runtime-home <runtime> --enable-io-writer
node bin/moon-relay-kernel.mjs mcp-bridge --runtime-home <runtime> --enable-io-writer
```

The local JSON-lines protocol accepts the request below with `action: "io-write"`
and `runId`. Without the flag its capabilities report `ioWriter.available:false`
and generation returns `host_io_not_enabled`. Native writable Worker capability
remains separate; this flag does not enable native Worker start or settlement.

An enabled Kernel MCP Host adds the optional `ioWrite` object to the existing
`kernel_attach` schema. No extra MCP tool or Kernel Step is introduced:

```json
{
  "name": "kernel_attach",
  "arguments": {
    "workspaceRoot": "<canonical worktree>",
    "runId": "<existing active Run>",
    "ioWrite": {
      "stepId": "<current Step>",
      "expectedWorkspaceIdentity": "sha256:<current identity>",
      "filePath": "tests/new-candidate.test.mjs",
      "specification": "<fixed Host specification>",
      "references": [{"path": "src/subject.ts", "sha256": "sha256:<byte hash>"}],
      "maxInputBytes": 20000,
      "maxOutputBytes": 10000,
      "timeoutMs": 120000
    }
  }
}
```

These example budgets are caller inputs, not global selection thresholds. The
path must be a new file inside the current Work Unit's allowed paths. The request
cannot contain `contractJson`, `worker`, `report`, nested Run overrides, or
transport/model options. It never calls `next`, creates an Attempt, or advances
the Step. Failed generation returns an MCP tool error and retains available usage.
Plain `kernel_attach` remains observation. Disabled Hosts do not advertise
`ioWrite` and reject it even if a caller manually supplies the property.

The MCP handler reuses one local control per canonical workspace so repeated
requests retain the existing Writer's duplicate guard. That guard ends with the
owning handler; reconnecting to a new handler does not prove durable exclusion.
Programmatic Hosts use `createMcpBridgeHandler({ ioWriter: {} })` or
`startMcpBridgeServer({ ioWriter: {} })`. The stateless `handleMcpToolCall` helper
cannot execute I/O requests. Remote MCP clients can start this existing bridge
through their tracked execution path; a Linux container remains Linux even when
its connector is named Mac. Account-root and remote installations need their
normal release/update process before this source change is available there.

## Request and result

Supply `action: "io-write"`, the canonical `runId` and `stepId`, current
`expectedWorkspaceIdentity`, one new `filePath`, `specification`, and `references`
containing repository-relative paths and `sha256:<hex>` byte hashes. The Host
must set `maxInputBytes`, `maxOutputBytes`, and `timeoutMs` for the task. Input
budget counts specification and reference bytes; it is not a tokenizer or a
provider-context limit. Output budget applies to the complete JSON response as
well as code bytes. References are untrusted source data. Important semantics
remain the Work Unit owner's responsibility.

The response contains `candidatePath`, `filePath`, byte count, Host-computed hash,
usage, and elapsed time. Generated code is not repeated in Main's response.
The Host writes the candidate only after its read-only App Server exits. The
original workspace is not modified. Execute the candidate in an appropriate
isolated test context, then use the existing Proof and Owner delivery gates.
This Writer does not apply files or skip those gates.

Reject existing destinations, scope violations, traversal, device/ambiguous
portable names, linked paths, stale references, snapshot or Work Unit changes,
model configuration mismatch, malformed/extra output, model-created files, and
repeat dispatch for the same portable destination, Host instance and Work Unit snapshot. Failure does
not retry or start the ordinary Worker. The caller must account for that failed
call before deciding how to proceed. Failed scratch directories are temporary
diagnostic artifacts, not repository deliverables.

Every reference's exact byte hash is checked both before and after the model
call. This also covers Git-ignored references that are absent from the global
workspace identity. Input accounting uses bytes actually read, with an early
file-size check to avoid reading an already oversized file.

Different fixed new files in the same Work Unit can be requested independently.
The duplicate key includes the destination with portable separators, Unicode NFC
normalization and case folding. A failed dispatched request also consumes that
destination's slot. Changing its specification is not permission to retry it.
Candidates remain separate; generating several does not apply a combined patch.

Duplicate prevention is process-local. A restarted Host must reconcile its own
outstanding requests before invoking again. No durable exactly-once guarantee
is claimed. Neither process exit nor a read-only Turn proves writable Worker
exclusion or authorizes Owner delivery.

### Tool execution policy

Writer Turns request the transport's Host-only `toolPolicy: "none"`. The Host
reads the effective configuration to discover external catalog names, then
disables configured MCP servers, apps and plugins for the fresh thread. It does
not forward their commands, credentials or other settings in the override.
Supported native configuration disables shell, browser, computer, image, Code
Mode, delegation, skills, planning, user-input, sleep and dependency tools, web
search, hooks and goals. This does not edit the user's persistent configuration.
See the [official configuration reference](https://developers.openai.com/codex/config-reference).

An unreadable configuration fails the request. The prompt is an additional
instruction; read-only sandboxing alone is not the tool prohibition. The
transport accepts only agent/user messages and reasoning items/deltas for this
policy. Matching command, patch, MCP, web, delegation or unknown item events
poison the generation even when followed by valid JSON and a completed Turn.
Events buffered before the Turn ACK receive the same check. Server-initiated
requests are already rejected by the existing transport. Ordinary transports
retain their tool-event behavior.

The Writer transport retires its own App Server and drains its pipes before
returning a successful generation. Execution events trailing a terminal event
are still rejected. Usage observed before rejection is retained; no candidate
metadata or Owner authority is returned for a rejected generation. These guards
do not prove that arbitrary OS descendants cannot run. The review counterexample
and regression tests use a simulated server; they are not evidence of an actual
model executing an unauthorized command.

## Evidence

App Server's matching `thread/tokenUsage/updated` **total** counts all provider
requests in the fresh Turn. `last` would lose earlier model/tool requests.
Notifications for other threads or Turns and notifications after completion
are ignored. Missing, negative, or invalid counts stay `null`; missing cache
write usage is not inferred as zero. Usage observed before failure is retained.

`resolvedModel` and `resolvedEffort` come from App Server's thread configuration.
They are not provider-observed enforcement. `observedModel` and `observedEffort`
therefore remain `null`. Raw usage is not a cost or subscription-quota receipt.
Include Main, helper, review, correction, test, and recovery resources when
evaluating the complete task. A model generation result always keeps
`hostProductProof: NOT_RUN`, `ownerDelivery: HOLD_SAFE`, and `kernelDone: false`.

Linux/Windows product Proof remains subject to
`host_worker_proof_write_scope_unavailable`. A fixture proof runner cannot
authorize delivery. The Writer changes neither restriction.

## Evaluation on 2026-11-10

Source baseline: `666bfff60209c84d7941b01845e40b3fb494e90d`. The initial main
worktree failed successor continuity admission. A separate `codex/spotify-io`
worktree obtained its own bounded Kernel Run. Historical Run/receipt records
were not edited.

There are two different defaults. The Desktop App Server resolved Sol/high.
The Codex Kernel dispatcher applies its default-on Host model policy:
ordinary `implement` is `standard`, requesting Luna/medium. This mapping is not
an observed writable Worker execution or a completed-work baseline. Existing
dispatch regressions verify the policy, shadow mode, and invocation overrides. Therefore
the following Sol comparison is **secondary**, not a Kernel standard baseline.

Eight read-only App Server calls generated tests from fixed specifications:
two subjects (Run/worktree authority and Work Unit scope), two repetitions,
alternating Sol/high and Luna/medium. This was `SIMULATED_HELPER`, not a writable
Worker, Host product Proof, Owner delivery, or complete-task economics.

| All attempts, including failures | Sol/high | Luna/medium |
| --- | ---: | ---: |
| Normal-source accepted files | 4/4 | 3/4 |
| Input tokens | 105,090 | 102,320 |
| Output tokens | 12,671 | 6,964 |
| Input + output tokens | 117,761 | 109,284 |
| Cached input tokens, included in input | 22,912 | 0 |
| Model-call elapsed time | 275,664 ms | 154,693 ms |

These totals show 7.20% fewer total tokens and 45.04% fewer output tokens in
this secondary comparison. They do **not** show a saving over the existing
Kernel standard path. The failed Luna file remains in all resource totals.
No verified price/quota policy or precommitted latency budget was available;
cash cost, quota effect, full completion cost, and adoption remain inconclusive.

Run/worktree tests passed normal sources in both repetitions and both arms.
Each file detected all 12 registered mutations, including legacy workspace
mismatch, the exact unbound Run error, and lease authority defects. The existing
`kernel-worktree-binding` test file detected 4/12 of these; generated files added
8 detections relative to **that test file**, not a measured entire-repo baseline.

Scope tests passed 2/2 for Sol and 1/2 for Luna. The second Luna file incorrectly
expected implicit scope to reject traversal; the actual provisional contract
returns `required:false`. It failed on normal code and is rejected. An
`implicit-provisional` mutation targeted a different classifier branch rather
than the intended wrapper return; its survivor is not scored as a valid quality
comparison. The other 11 variants were detected by normal-passing generated
files. The existing bounded-work-unit file detected 2 of those 11. A failing
normal-source suite's apparent mutation detections are not quality evidence.

The initial study found that `rg` and bounded source reads were sufficient for
the exact symbol/condition questions it tried. This finding covers T11 only.
The later Reader implementation and T12–T14 evaluation appear below.
Result cache: `EXCLUDED_BY_USER`; local caching and validation-result reuse are
outside the implementation scope. No persistent store, router, queue, automatic
Reader-Planner-Writer chain, or OS changes were introduced.

Raw protocol, calls, generated files, and mutation results are kept outside
canonical source in the task's temporary experiment directory. They are
diagnostic evidence and do not replace Kernel-executed bound proof.

The implemented Host control was subsequently exercised against the active
bounded Run, with the real App Server and standard Host model selection. It
returned one 5,118-byte isolated test file: Luna/medium configuration, 26,459
input tokens, 1,632 output tokens, zero reported cached/cache-write input, and
37,944 ms elapsed. The exact generated file passed 17 tests on normal source.
An isolated import-only remapping to copied subjects detected all 12 registered
binding mutations. Original Owner paths and the Run mutation revision were not
changed by generation. This establishes `GENERATION PASS` and
`ISOLATED_TEST PASS` for that file, not product Proof or adoption.

The initial macOS connector context probe failed. Subsequent read-only context
queries succeeded, but an explicit Native Host execution request returned
`persistence_unavailable`: its executor was not running or its status was
unavailable. The connector's ordinary execution environment is a Linux container,
not proof of macOS execution. No Native Worker or delivery was started. On the
available Windows Host, the existing writable Worker capability lacks verified
native Writer exclusion; new Worker product Proof also retains the platform
restriction above.
`HOST_PRODUCT_PROOF: NOT_RUN`, `OWNER_DELIVERY: HOLD_SAFE`, and economic
`adoption: INCONCLUSIVE` remain separate from the implementation Run's own
source checks. No account-root runtime refresh, commit, push, or deployment is
part of this implementation.

The subsequent review hardening enabled the tool execution policy above and
changed duplicate admission from one call per Work Unit snapshot to one call per
portable destination in that snapshot. Simulated-server regressions reject
command start/completion/delta, MCP and unknown item events, including events
before the ACK and trailing terminal notifications. Separate-file concurrency
passes; one destination's concurrent requests dispatch once. Ordinary transport
behavior remains covered separately.

A real App Server smoke run accepted the hardened configuration and generated
one 153-byte constant test. Its isolated test passed, with 15,976 input and 77
output tokens, zero reported cached input, and 5,945 ms elapsed. The temporary
Owner and Run revision were unchanged. This is configuration/generation feedback,
not a completed-work comparison, the 12-mutation quality evaluation, a product
Proof, or Owner delivery. The earlier 12-mutation experiment describes its own
generation conditions; the small smoke test does not extend that quality claim.

## Matched standard-policy pipeline verification

The subsequent verification fixes the requirements and source bytes before
either arm runs. It uses single-file binding tests, two-file binding/scope tests,
and a small capture-helper test workload, with three repetitions and alternating
A/B order. A uses the standard Host model policy with the ordinary read-only
transport and returns all requested files in one generation. B uses the actual
Host `io-write` API once per destination. Both receive the same deterministic
normal/mutation gates and a fresh review-policy model review of requirements,
sources and complete candidates. No extra planning call is added to either arm
when the Host already has fixed requirements.

The registered quality panel has 12 binding, 12 scope and four small-helper
mutations. The scope provisional mutation now targets the wrapper's
`required:false` / `provisional:true` return, rather than a different classifier
branch. A mutation earns credit only after normal-source tests pass, the mutated
module parses, and its tests fail with an assertion or a runtime exception
traced to the mutated subject. Process failures and broken imports are not
defect detection. The initial experiment oracle wrongly required AssertionError
and rejected a genuine empty-capture TypeError detection. The oracle amendment
is recorded, saved candidates are re-evaluated without regeneration, and the
unnecessary recovery calls remain charged and identified in the ledger. Model
review also checks semantic omissions outside this finite panel.

An explicit laboratory recovery and re-review is capped at one cycle per
workflow. It uses a separate standard-model generation, is fully charged to the
original arm, and does not re-dispatch a consumed Writer destination. This is an
evaluation procedure, not a new production retry or fallback. All initial,
review, failed, recovery and re-review calls remain in the totals. Cached input
is included in input and reported separately; reasoning is not added twice to
output. Unknown usage is not zero.

This is a **standard-policy generation pipeline proxy**, not an actual writable
Kernel Worker baseline. The actual local Host start request returned
`host_worker_native_isolation_unverified`; a fresh Mac Native request returned
`persistence_unavailable`. No exclusion callback, fixture proof or platform
override was supplied to make those paths appear available. These are limits on
the operating verification, not new features to add to the I/O delegation scope.
They do not prevent optional candidate generation or account-root packaging.

Every experimental generation and model review has its own usage record, but
this Desktop chat and experiment preparation have no complete receipt. They
remain unmetered study overhead outside both measured pipelines. A workload
that needs new model-written specifications needs a separate comparison that
includes those calls. Pipeline totals cannot establish actual Kernel full-task,
price, subscription-quota or representative-workload savings.

Both generation arms request the same standard model and effort. Any observed
pipeline token difference can involve tool exposure, input formatting, candidate
length, review and recovery; it is not evidence of switching a Sol Worker to
Luna. The ordinary read-only transport also does not reproduce every actual
Kernel Worker capsule, tool manifest or writable execution behavior.

### Recorded results and decision

The completed experiment has 18 workflows and 68 model calls, including the
reviews and explicit repairs. All 18 final candidates met the isolated normal,
mutation and model-review gates after at most one laboratory repair. Only 2/9
first candidates in each arm met the corrected combined quality gate. Normal
tests or 12/12 mutation detection alone therefore do not establish equal quality.
Reviews found missing active/blocked Run lease rejection cases beyond the
finite mutation panel. Small-helper tests also misread a present capture group
as absent and rejected correct source; these candidates were rejected.

| Fixed-spec workload, three repeats | A input + output | B input + output | B relative to A |
| --- | ---: | ---: | --- |
| Single binding test file | 301,071 | 228,544 | 24.09% fewer tokens |
| Binding and scope test files | 291,522 | 375,043 | 28.65% more tokens |
| Small capture-helper tests | UNKNOWN | 233,390 | Inconclusive |

These are descriptive proxy totals, not actual Kernel Worker savings. The
single-file paired reductions ranged from 4.38% to 59.58%, reflecting review and
repair variation. Three repetitions do not establish a stable workload-wide
benefit. Separate Writer calls per destination did not demonstrate a multi-file
efficiency benefit. This result does not justify adding batching or a routing
layer within this verification task.

Arm A made 31 calls and has an observed usage subtotal of 727,020 input plus
36,130 output tokens. Its small-workload generation timed out after 240,510 ms
without usage. Its exact total, including that call, remains UNKNOWN. Arm B made
37 calls with 795,446 input plus 41,531 output tokens (836,977 total). A's
observed cached-input subtotal is 217,344; B reports 116,224. Those cached inputs
are already counted in input. No missing usage is estimated or treated as zero.
Observed model-call wall times were 1,138,915 ms for A and 1,063,690 ms for B;
workflow times were 1,180,093 and 1,108,573 ms. These exclude later offline oracle
re-evaluation and the experiment pause and are not full-study latency measures.

The recorded repairs number seven for A and eight for B. One B repair was
unnecessary after correcting the oracle: its two extra calls used 43,537 tokens
and 36,857 ms. Both calls remain in primary totals and are labelled separately
as evaluation error. The small-workload aggregate is contaminated by this error
as well as the missing A timeout usage. There is no clean aggregate token-saving
conclusion across all tasks.

A separate real source-CLI MCP test bootstrapped its Host binding through the
official `next` entrypoint, initialized the protocol, exposed the enabled Writer
schema and generated a 139-byte candidate. Its one isolated test passed. The
same request was refused with `host_io_duplicate_request` and MCP `isError:true`;
Owner revision stayed unchanged and stdout contained no non-JSON protocol lines.
This extra model call used 15,966 input plus 76 output tokens in 5,574 ms and is
kept outside the matched A/B totals. The first MCP probe correctly rejected a
fixture with no Host binding before any model call. Correcting the fixture did
not weaken binding checks. Neither probe tested the installed account runtime.

The focused existing binding test file detected 4/12 registered mutations; the
focused existing scope file detected 2/12. Both passed unchanged source and all
24 variants were syntactically valid. Final accepted experimental candidates
detected 12/12 on each subject after the recorded repairs where required. This
adds eight and ten detections relative to those two files only. It is not an
entire-repository incremental baseline, nor evidence that every initial Writer
candidate achieves this result without repair or review.

Decision: keep the feature opt-in. Functional generation and source-CLI MCP
integration have evidence; general quality equivalence and actual standard
Worker full-task savings do not. Actual product Proof, Owner delivery and the
corresponding product report continuation remain untested because the existing
Host prerequisites were unavailable. These are remaining verification
conditions for product acceptance. Account installation, commit, push and
deployment were outside this evaluation.

## Optional Reader

Reader implementation is in scope. Each invocation is a separate choice by the
owning Host. Exact search and bounded source reads remain the first step for
questions they can answer. Use the Reader entrypoint for a source question that
needs broader analysis. Normal Worker actions do not select it automatically.

`createLocalWorkerControl({ projectRoot, runtimeHome, env, ioReader: {} })` or
`worker-host --enable-io-reader` enables the local `io-read` action.
`mcp-bridge --enable-io-reader` enables `kernel_attach.ioRead`. The two enable
flags are independent. A Reader call cannot carry a Writer request, a Worker
signal, a task contract, or a report.
Read capability appears as `ioReader.available:true` even on Hosts where
`writableStart:false` blocks starting a writable Worker.

```json
{
  "name": "kernel_attach",
  "arguments": {
    "workspaceRoot": "<canonical worktree>",
    "runId": "<active Run>",
    "ioRead": {
      "stepId": "<current Step>",
      "expectedWorkspaceIdentity": "sha256:<current identity>",
      "question": "<fixed source question>",
      "references": [{"path": "src/subject.ts", "sha256": "sha256:<byte hash>"}],
      "maxInputBytes": 24000,
      "maxOutputBytes": 8000,
      "timeoutMs": 120000
    }
  }
}
```

For local JSON lines, use the same inner fields with `action: "io-read"` and
`runId`. The reference list fixes the exact readable files for this call. The
Host checks Run and worktree binding, snapshot freshness, forbidden paths, path
containment, and the supplied byte hashes. Reader uses read authority. Writer
continues to require mutation authority and an allowed destination. Input
budgets count the question and raw source bytes before prompt serialization.
Both use the existing Host model policy and the same read-only App Server with
tools disabled.

A normal response has `status: "answered"`, plain `answer` text, and Host-supplied
`sources` containing the paths and raw-byte hashes actually sent to the model.
These are snapshot identifiers, not validated claims or citations. Missing,
repeated or imperfect quotes do not discard an answer. Empty responses fail;
oversized answers return a bounded `truncated` preview. A changed source retains
the received answer with `stale` diagnostics. Changed authority, forbidden paths
and tool events still reject the request. Known usage and time are retained.

Interpretation and any necessary exact source checks remain ordinary caller
work. There is no mandatory semantic-review field, full-source reread or coverage
engine. The Reader does not update the Run, create a file, settle Proof, apply a
result to the Owner, chain to another model, or retry a failed result. The Kernel
wrapper retains its existing authority and noncompletion evidence fields; the
standalone CLI omits those Kernel-only fields.

### Historical Reader evidence and adoption, 2026-11-10

The following citation-based results describe the earlier contract. They are
preserved as history, not as acceptance results for the plain-answer Reader.

The Nov 11 evaluation recovered the original questions and byte hashes from
the historical experiment. It replayed the 1,656-line and 4,391-line cases and
the same three-file question with seven registered citations each. The
invocation-resolver fixture restored its historical CRLF encoding and matched
the original byte hash. Both arms had exact search and bounded source reads.
The Reader arm included the real helper and a standard-policy final model call
after re-reading original source. Both used the same Host model policy.

| Workload | Direct total tokens | Reader path total tokens | Checked final citations at registered paths, direct / Reader path |
| --- | ---: | ---: | --- |
| 1,656 lines | 18,292 | 48,911 | 0/7 / 7/7 |
| 4,391 lines | 17,726 | 83,253 | 7/7 / 5/7 |
| Three files | 21,740 | 65,693 | 6/7 / 6/7 |

There were nine actual model calls. The total token count rose from 57,758 to
197,857. Direct input included 14,080 cached tokens, and the Reader path
reported zero cached tokens. The direct arm in the first case appended
explanations to its quotes, so all seven failed exact matching. The second
Reader omitted a required citation, and the third Reader returned an invalid
citation. Both incurred original-source re-reading in the study. In the
cross-file answers, both arms cited the lease lookup definition in the
lifecycle store. This citation was exact, but the registered rubric required
the invocation-resolver call site. Counting either valid source gives 7/7
required symbols in both final answers, with invalid extra citations still
present. The first Reader-path answer cited seven signatures but did not
distinguish the missing-ID filter of backfill from the broader rebind update.
These results are one pass of a read-only standard-policy experiment with
unequal quality outcomes. They support neither savings over an actual writable
Worker nor default Reader adoption.

The T11 exact search used no Reader call. In T13, an exact
`strictBoundedScope` citation accompanied a deliberately reversed
required/provisional claim. Re-reading and executing the original branch
rejected the claim. The real source CLI MCP Reader returned checked evidence
for the long file with no invalid protocol lines. The isolated Owner identity,
Run revision and Attempt count stayed unchanged. Source tests also reject an
ignored reference that changes during the call.

The original plan's W4 result reuse is excluded by the user's later instruction.
The helper has no local result cache or validation-result reuse. Provider-reported
cached tokens remain cost measurements only. A fresh macOS Native executor request returned
`persistence_unavailable`, so writable Worker and product delivery verification
remain unavailable from these Hosts.

The original Writer panel was also replayed with two fresh fixed-spec
candidates. They passed eight and seven normal tests respectively and
detected both registered mutations each. The first Writer usage is unknown
because the evaluation script stopped after generation. The saved candidate
was verified offline and no model call was replayed. The second call reported
22,362 input and 1,065 output tokens. This panel checks candidate quality in
isolation. Its usage is separate from both comparison studies.
