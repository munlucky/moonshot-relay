import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../control-plane.mjs';
import { discoverProjectCommands } from '../proof/command-catalog.mjs';
import { observeWorkspaceIdentity } from '../run/workspace-identity.mjs';

const validDigest = `sha256:${'a'.repeat(64)}`;

const makeProject = async (scripts = {}) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-sentinel-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'sentinel-fixture', version: '0.0.1', scripts }, null, 2));
  await writeFile(path.join(projectRoot, 'app.mjs'), 'export const v = 0;\n');
  return projectRoot;
};

const mutate = async (projectRoot, value) => {
  await writeFile(path.join(projectRoot, 'app.mjs'), `export const v = ${value};\n`);
};

// Each trap drives a real control-plane run and returns the completion
// decision so the harness can check the Kernel refused to falsely accept.
const TRAPS = {
  async caller_attested_only_mutating(cp, projectRoot) {
    await cp.startRun({ runId: 'sen', objective: 'x' });
    await mutate(projectRoot, 1);
    // This trap deliberately bypasses report-driven automatic proof so the
    // only evidence recorded below is caller-attested. The production report
    // path is exercised by the other sentinel cases and now plans outstanding
    // hard proof itself.
    await cp.transition('sen', 'EXECUTE');
    await cp.transition('sen', 'PROVE');
    await cp.recordProof('sen', { obligationId: 'default', status: 'passed', evidenceRef: 'e://1', command: 'npm test', exitCode: 0, evidenceDigest: validDigest });
    return cp.finalizeRun('sen');
  },
  async stale_identity(cp, projectRoot) {
    await cp.startRun({ runId: 'sen', objective: 'x' });
    await mutate(projectRoot, 1);
    await cp.transition('sen', 'EXECUTE');
    await cp.transition('sen', 'PROVE');
    await cp.executeProof('sen', { obligationId: 'default', commandRef: 'test:ok' });
    // Mutate again after the passing evidence: the recorded evidence is stale
    // against the newly observed workspace state.
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      name: 'sentinel-fixture',
      version: '0.0.1',
      scripts: {
        'test:ok': 'node -e "process.exit(1)"',
        'test:fail': 'node -e "process.exit(1)"',
        lint: 'node -e "process.exit(0)"',
        noop: 'node -e "process.exit(0)"',
      },
    }, null, 2));
    await mutate(projectRoot, 2);
    await cp.report('sen', { summary: 'drift' });
    return cp.finalizeRun('sen');
  },
  async missing_obligation(cp) {
    await cp.startRun({ runId: 'sen', objective: 'x', taskContract: { riskTier: 'T2' } });
    await cp.transition('sen', 'EXECUTE');
    await cp.transition('sen', 'PROVE');
    await cp.recordProof('sen', { obligationId: 'static-analysis', status: 'passed', evidenceRef: 'e://1', command: 'npm run lint', exitCode: 0, evidenceDigest: validDigest });
    await cp.transition('sen', 'CLOSE');
    return cp.finalizeRun('sen');
  },
  async uncovered_acceptance(cp) {
    await cp.startRun({ runId: 'sen', objective: 'x', taskContract: { acceptance: ['must-do-thing'] } });
    await cp.transition('sen', 'EXECUTE');
    await cp.transition('sen', 'PROVE');
    await cp.recordProof('sen', { obligationId: 'default', status: 'passed', evidenceRef: 'e://1', command: 'npm test', exitCode: 0, evidenceDigest: validDigest, acceptanceCoverage: [] });
    await cp.transition('sen', 'CLOSE');
    return cp.finalizeRun('sen');
  },
  async no_verification_mutating(cp, projectRoot) {
    await cp.startRun({ runId: 'sen', objective: 'x' });
    await mutate(projectRoot, 1);
    // Observe the mutation without submitting a report. A summary-only report
    // intentionally triggers Kernel proof in the new contract, so this trap
    // uses the internal observation seam to retain its no-verification claim.
    const observation = observeWorkspaceIdentity({ projectRoot });
    cp.stateStore.observeWorkspaceIdentity('sen', observation.identity);
    await cp.transition('sen', 'EXECUTE');
    await cp.transition('sen', 'PROVE');
    await cp.transition('sen', 'CLOSE');
    return cp.finalizeRun('sen');
  },
  async protected_waiver(cp) {
    await cp.startRun({ runId: 'sen', objective: 'x', taskContract: { requiredObligations: ['auth-regression'] } });
    await cp.transition('sen', 'EXECUTE');
    await cp.transition('sen', 'PROVE');
    let waiverRejected = false;
    try {
      await cp.addWaiver('sen', { obligationId: 'auth-regression', approvedBy: 'x', reason: 'skip', approvalReceipt: 'r://1' });
    } catch {
      waiverRejected = true;
    }
    await cp.transition('sen', 'CLOSE');
    const result = await cp.finalizeRun('sen');
    return { ...result, waiverRejected };
  },
  async failing_evidence(cp, projectRoot) {
    await cp.startRun({ runId: 'sen', objective: 'x' });
    await mutate(projectRoot, 1);
    await cp.report('sen', { summary: 'try', verifications: [{ obligationId: 'default', commandRef: 'test:fail' }] });
    return cp.finalizeRun('sen');
  },

  // --- Bypass paths the first sentinel set did not cover -------------------

  // A trivially-passing script filed under a typed obligation name. The
  // obligation's command binding must reject it before it runs (P0-2).
  async forged_obligation_name(cp, projectRoot) {
    await cp.startRun({ runId: 'sen', objective: 'x', taskContract: { riskTier: 'T2', behaviorChanging: true } });
    await mutate(projectRoot, 1);
    const rejected = await cp.report('sen', {
      summary: 'claiming coverage',
      verifications: [
        { obligationId: 'static-analysis', commandRef: 'noop' },
        { obligationId: 'unit-test', commandRef: 'noop' },
      ],
    });
    const result = await cp.finalizeRun('sen');
    return { ...result, reportStatus: rejected.status };
  },

  // Structured judgments claiming executable obligations. Judgment evidence
  // can never satisfy a hard obligation (P0-3).
  async judgment_for_hard_obligation(cp, projectRoot) {
    await cp.startRun({ runId: 'sen', objective: 'x', taskContract: { riskTier: 'T2', behaviorChanging: true } });
    await mutate(projectRoot, 1);
    await cp.report('sen', {
      summary: 'asserting quality',
      judgments: [
        { obligationId: 'static-analysis', verdict: 'pass', reason: 'looks fine' },
        { obligationId: 'unit-test', verdict: 'pass', reason: 'looks fine' },
      ],
    });
    return cp.finalizeRun('sen');
  },

  // One passing hard proof plus judgments for everything else — the exact
  // "trivial hard evidence + judgment" substitution the review described.
  async trivial_hard_plus_judgments(cp, projectRoot) {
    await cp.startRun({ runId: 'sen', objective: 'x', taskContract: { riskTier: 'T3' } });
    await mutate(projectRoot, 1);
    await cp.report('sen', {
      summary: 'mixed evidence',
      verifications: [{ obligationId: 'unit-test', commandRef: 'test:ok' }],
      judgments: [
        { obligationId: 'static-analysis', verdict: 'pass', reason: 'reviewed' },
        { obligationId: 'security-review', verdict: 'pass', reason: 'reviewed', reviewerId: 'reviewer-1', rationale: 'no auth surface touched' },
      ],
    });
    return cp.finalizeRun('sen');
  },

  // A run whose completion was accepted but whose finalization did not finish
  // must not report itself done (P0-7).
  async partial_finalization_reported_done(cp, projectRoot) {
    await cp.startRun({ runId: 'sen', objective: 'x', taskContract: { acceptance: ['works'] } });
    await mutate(projectRoot, 1);
    const report = await cp.report('sen', {
      summary: 'fix',
      verifications: [{ obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: ['works'] }],
      // Git closeout is requested but cannot succeed in this fixture, so
      // finalization is partial.
      gitCloseoutRequest: { requested: true, mode: 'commit', message: 'sentinel' },
    });
    const nextPayload = await cp.next('sen');
    return { ...report, doneClaimed: report.status === 'completed' || nextPayload.action?.type === 'done' };
  },

  // A declared-but-unenforceable network sandbox must block, not record a
  // false isolation boundary (P1-5).
  async false_network_isolation(cp, projectRoot) {
    await cp.startRun({ runId: 'sen', objective: 'x' });
    await mutate(projectRoot, 1);
    const result = await cp.report('sen', {
      summary: 'isolated run',
      verifications: [{ obligationId: 'default', commandRef: 'test:ok', networkPolicy: 'blocked' }],
    });
    return { ...result, blockedForPolicy: result.status === 'blocked' && result.blockedReason === 'network-policy' };
  },

  // --- Bypasses found by review of the first remediation ------------------

  // An evidence plan naming a command that proves nothing. The plan's own
  // commands are subject to the same classification check as policy
  // obligations, so a no-op cannot become hard evidence (F1).
  async evidence_plan_names_noop(cp, projectRoot) {
    try {
      await cp.startRun({
        runId: 'sen',
        objective: 'x',
        taskContract: { acceptance: [{ acceptance: 'works', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['noop'] } }] },
      });
    } catch (error) {
      if (error.code === 'unsupported-verification') {
        return { status: 'unsupported-verification', preflightRejected: true };
      }
      throw error;
    }
    await mutate(projectRoot, 1);
    const run = await cp.getRun('sen');
    const planned = run.requiredObligations.find((id) => id.startsWith('acceptance-')) || 'default';
    await cp.report('sen', {
      summary: 'claiming coverage',
      verifications: [{ obligationId: planned, commandRef: 'noop', acceptanceCoverage: ['works'] }],
    });
    return cp.finalizeRun('sen');
  },

  // A later, shorter contract replaces the active acceptance authority by
  // canonical binding, rather than overwriting an earlier criterion through
  // a positional id (F2).
  async contract_revision_shrinks_acceptance(cp, projectRoot, { runtimeHome }) {
    await cp.ensureRun({ runId: 'sen', objective: 'x', taskContract: { allowedPaths: ['app.mjs'], acceptance: ['A must hold', 'B must hold'] } });
    await cp.ensureRun({ runId: 'sen', objective: 'x', taskContract: { allowedPaths: ['app.mjs'], acceptance: ['C must hold'] } });
    const run = await cp.getRun('sen');
    const dropped = !run.acceptanceCriteria.includes('A must hold');
    await mutate(projectRoot, 1);
    // Cover only what the shrunken contract would have required.
    const report = await cp.report('sen', {
      summary: 'fix',
      verifications: [{ obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: ['C must hold'] }],
    });
    return { ...report, acceptanceDropped: dropped };
  },

  // A protected T3 judgment submitted without an implementer identity must not
  // skip the independence check (F5).
  async judgment_without_implementer(cp, projectRoot) {
    await cp.startRun({ runId: 'sen', objective: 'x', taskContract: { riskTier: 'T3' } });
    await mutate(projectRoot, 1);
    await cp.report('sen', {
      summary: 'self-reviewed',
      verifications: [{ obligationId: 'unit-test', commandRef: 'test:ok' }, { obligationId: 'static-analysis', commandRef: 'lint' }],
      judgments: [{ obligationId: 'security-review', verdict: 'pass', reason: 'ok', reviewerId: 'me', rationale: 'looks fine' }],
    });
    return cp.finalizeRun('sen');
  },

  // A protected T3 judgment carrying two different reviewer STRINGS but no
  // Review Receipt must not satisfy the obligation: an independent review is
  // proven by recorded lineage, not by naming a second identifier (K0).
  async forged_review_identity(cp, projectRoot) {
    await cp.startRun({ runId: 'sen', objective: 'x', taskContract: { riskTier: 'T3', acceptance: ['works'] } });
    await mutate(projectRoot, 1);
    await cp.report('sen', {
      summary: 'reviewed by someone else, honestly',
      implementerId: 'implementer-1',
      verifications: [
        { obligationId: 'unit-test', commandRef: 'test:ok', acceptanceCoverage: ['works'] },
        { obligationId: 'static-analysis', commandRef: 'lint' },
      ],
      judgments: [{ obligationId: 'security-review', verdict: 'pass', reason: 'ok', reviewerId: 'reviewer-2', rationale: 'no auth surface touched' }],
    });
    return cp.finalizeRun('sen');
  },

  // A finalization retry must not turn an unfinished Git closeout into a clean
  // completion by losing the selected paths (F4).
  async closeout_retry_loses_paths(cp, projectRoot) {
    await cp.startRun({ runId: 'sen', objective: 'x', taskContract: { acceptance: ['works'] } });
    await mutate(projectRoot, 1);
    await cp.report('sen', {
      summary: 'fix',
      changedPaths: ['app.mjs'],
      verifications: [{ obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: ['works'] }],
      gitCloseoutRequest: { requested: true, mode: 'commit', message: 'sentinel' },
    });
    const retried = await cp.report('sen', { summary: 'retry' });
    const nextPayload = await cp.next('sen');
    return { ...retried, doneClaimed: retried.status === 'completed' || nextPayload.action?.type === 'done' };
  },

  // A capsule built before the workspace moved describes a state that no longer
  // exists; re-submitting against it must not be accepted (K1).
  async stale_capsule_reuse(cp, projectRoot) {
    await cp.startRun({ runId: 'sen', objective: 'x', taskContract: { acceptance: ['works'], allowedPaths: ['**'] } });
    const capsule = await cp.buildCapsule('sen');
    await mutate(projectRoot, 1);
    // Keep the run retryable so the old capsule is checked on the next report;
    // a summary-only report is now allowed to finish when the default proof
    // command passes.
    await cp.report('sen', {
      summary: 'first pass',
      changedPaths: ['app.mjs'],
      verifications: [{ obligationId: 'default', commandRef: 'test:fail' }],
    });
    const reused = await cp.report('sen', {
      summary: 'reusing the old capsule',
      capsuleId: capsule.capsuleId,
      changedPaths: ['app.mjs'],
      verifications: [{ obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: ['works'] }],
    });
    return { ...reused, capsuleRejected: reused.status === 'scope-rejected' };
  },

  // A worker that changed files its work unit never claimed has changed the
  // plan, not just the code (K1/K2).
  async out_of_scope_change(cp, projectRoot) {
    await cp.startRun({
      runId: 'sen',
      objective: 'x',
      taskContract: { acceptance: ['works'], allowedPaths: ['src/**'], forbiddenPaths: ['app.mjs'] },
    });
    await cp.buildCapsule('sen');
    await mutate(projectRoot, 1);
    const rejected = await cp.report('sen', {
      summary: 'touched a forbidden path',
      changedPaths: ['app.mjs'],
      verifications: [{ obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: ['works'] }],
    });
    return { ...rejected, scopeRejected: rejected.status === 'scope-rejected' };
  },

  // A report that answers a different unit of work than the one in progress
  // must not advance the cursor (K2).
  async foreign_step_report(cp, projectRoot) {
    await cp.startRun({
      runId: 'sen',
      objective: 'x',
      taskContract: {
        complex: true,
        riskTier: 'T2',
        acceptance: ['a holds', 'b holds'],
        steps: [
          { objective: 'first', allowedPaths: ['app.mjs'], acceptanceIds: ['AC-1'], obligationIds: ['unit-test'] },
          { objective: 'second', allowedPaths: ['app.mjs'], acceptanceIds: ['AC-2'], obligationIds: ['static-analysis'] },
        ],
      },
    });
    const steps = cp.getRunSteps('sen');
    await mutate(projectRoot, 1);
    const rejected = await cp.report('sen', {
      summary: 'skipping to the second unit',
      stepId: steps[1].stepId,
      changedPaths: ['app.mjs'],
      verifications: [{ obligationId: 'static-analysis', commandRef: 'lint', acceptanceCoverage: ['AC-2'] }],
    });
    return { ...rejected, stepRejected: rejected.status === 'step-rejected' };
  },

  // Positive controls ------------------------------------------------------

  async clean_hard_evidence(cp, projectRoot) {
    await cp.startRun({
      runId: 'sen',
      objective: 'x',
      taskContract: {
        acceptance: [{ acceptance: 'works', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'] } }],
      },
    });
    await mutate(projectRoot, 1);
    return cp.report('sen', {
      summary: 'fix',
      verifications: [
        { obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: [] },
        { obligationId: 'acceptance-ac-1', commandRef: 'test:ok', acceptanceCoverage: ['works'] },
      ],
    });
  },

  // The contract survives a process boundary: a second control plane over the
  // same SQLite home must still see constraints and non-goals (P0-4).
  async contract_survives_resume(cp, projectRoot, { runtimeHome }) {
    await cp.startRun({
      runId: 'sen',
      objective: 'fix login',
      taskContract: {
        acceptance: [{ acceptance: 'works', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'] } }],
        constraints: ['keep public response shape'],
        nonGoals: ['do not redesign auth'],
      },
    });
    await mutate(projectRoot, 1);
    const fresh = await createKernelControlPlane({ runtimeHome, projectRoot });
    try {
      const resumed = await fresh.next('sen');
      const preserved = resumed.constraints.includes('keep public response shape')
        && resumed.nonGoals.includes('do not redesign auth');
      const report = await fresh.report('sen', {
        summary: 'fix',
        verifications: [
          { obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: [] },
          { obligationId: 'acceptance-ac-1', commandRef: 'test:ok', acceptanceCoverage: ['works'] },
        ],
      });
      return { ...report, contractPreserved: preserved };
    } finally {
      await fresh.close();
    }
  },

  // Two sequential CLI-style processes must not deadlock on a stale lease
  // (P0-6): the second control plane represents the next `kernel report`.
  async sequential_process_reports(cp, projectRoot, { runtimeHome }) {
    await cp.startRun({
      runId: 'sen',
      objective: 'x',
      taskContract: {
        acceptance: [{ acceptance: 'works', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'] } }],
      },
    });
    await mutate(projectRoot, 1);
    const first = await cp.report('sen', { summary: 'attempt', verifications: [{ obligationId: 'acceptance-ac-1', commandRef: 'test:fail' }] });
    const second = await createKernelControlPlane({ runtimeHome, projectRoot });
    try {
      const result = await second.report('sen', {
        summary: 'retry',
        verifications: [
          { obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: [] },
          { obligationId: 'acceptance-ac-1', commandRef: 'test:ok', acceptanceCoverage: ['works'] },
        ],
      });
      return { ...result, firstStatus: first.status, leaseBlocked: result.status === 'lease-conflict' };
    } finally {
      await second.close();
    }
  },

  // A non-Node project must be provable through its own manifest (P1-4): the
  // command is discovered from the Makefile, classified, and bound to the
  // obligation. It is only *executed* where the toolchain exists, so the
  // corpus stays deterministic on hosts without `make`.
  async non_node_proof_path(cp, projectRoot) {
    await writeFile(path.join(projectRoot, 'Makefile'), 'test:\n\t@echo ok\n');
    await cp.startRun({
      runId: 'sen',
      objective: 'x',
      taskContract: {
        acceptance: [{ acceptance: 'works', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok', 'make:test'] } }],
      },
    });

    const discovered = discoverProjectCommands({ projectRoot }).find((command) => command.commandRef === 'make:test');
    const bound = (await cp.next('sen')).action?.obligations?.some((obligation) => obligation.allowedCommandRefs.includes('make:test'));
    const nonNodeCommandBound = Boolean(discovered && discovered.commandClass === 'unit-test' && bound);

    const makeAvailable = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['make'], { encoding: 'utf8' }).status === 0;
    await mutate(projectRoot, 1);
    const report = await cp.report('sen', {
      summary: 'manifest-declared proof',
      verifications: [
        { obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: [] },
        { obligationId: 'acceptance-ac-1', commandRef: makeAvailable ? 'make:test' : 'test:ok', acceptanceCoverage: ['works'] },
      ],
    });
    return { ...report, nonNodeCommandBound, executedThroughMake: makeAvailable };
  },

  // The host bootstraps the run; the model never needs a `start` command (P0-1).
  async host_bootstrap_without_start(cp, projectRoot) {
    const ensured = await cp.ensureRun({
      runId: 'sen',
      objective: 'bootstrap',
      taskContract: {
        acceptance: [{ acceptance: 'works', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'] } }],
      },
    });
    if (ensured.status !== 'created') throw new Error(`expected bootstrap to create the run, got ${ensured.status}`);
    const again = await cp.ensureRun({
      runId: 'sen',
      objective: 'bootstrap',
      taskContract: {
        acceptance: [{ acceptance: 'works', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'] } }],
      },
    });
    if (again.status !== 'resumed') throw new Error('ensureRun must be idempotent');
    await mutate(projectRoot, 1);
    return cp.report('sen', {
      summary: 'fix',
      verifications: [
        { obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: [] },
        { obligationId: 'acceptance-ac-1', commandRef: 'test:ok', acceptanceCoverage: ['works'] },
      ],
    });
  },
};

const isAccepted = (result) => {
  if (!result) return false;
  // Explicit trap flags win: a trap can assert something stronger than the
  // completion decision (e.g. "did not claim done", "was not lease-blocked").
  if (result.doneClaimed !== undefined) return result.doneClaimed === true;
  if (result.capsuleRejected !== undefined) return result.capsuleRejected !== true;
  if (result.scopeRejected !== undefined) return result.scopeRejected !== true;
  if (result.stepRejected !== undefined) return result.stepRejected !== true;
  if (result.acceptanceDropped !== undefined) return result.acceptanceDropped === true || result.status === 'completed';
  if (result.blockedForPolicy !== undefined) return result.blockedForPolicy !== true;
  if (result.leaseBlocked !== undefined) return result.leaseBlocked !== true && result.status === 'completed';
  if (result.nonNodeCommandBound !== undefined) return result.nonNodeCommandBound === true && result.status === 'completed';
  if (result.contractPreserved !== undefined) return result.contractPreserved === true && result.status === 'completed';
  if (result.completionStatus) return result.completionStatus === 'accepted' && result.finalizationStatus === 'completed';
  if (result.finalization) return result.finalization.completionStatus === 'accepted' && result.finalization.finalizationStatus === 'completed';
  if (result.status) return result.status === 'completed';
  return false;
};

export const runSentinelEvaluation = async ({ corpus, seed = 0 } = {}) => {
  const results = [];
  let falseCompletions = 0;

  for (const testCase of corpus.cases) {
    const trap = TRAPS[testCase.trap];
    if (!trap) throw new Error(`Unknown sentinel trap: ${testCase.trap}`);
    const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-sentinel-home-'));
    const projectRoot = await makeProject({
      'test:ok': 'node -e "process.exit(0)"',
      'test:fail': 'node -e "process.exit(1)"',
      lint: 'node -e "process.exit(0)"',
      noop: 'node -e "process.exit(0)"',
    });
    const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
    try {
      const outcome = await trap(cp, projectRoot, { runtimeHome });
      const accepted = isAccepted(outcome);
      const falseCompletion = testCase.expect === 'reject' && accepted;
      const missedAccept = testCase.expect === 'accept' && !accepted;
      if (falseCompletion) falseCompletions += 1;
      results.push({ id: testCase.id, trap: testCase.trap, expect: testCase.expect, accepted, falseCompletion, missedAccept });
    } finally {
      await cp.close();
      await rm(runtimeHome, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  }

  return {
    taskSetRevision: corpus.taskSetRevision,
    kernelRevision: 'kernel-e2e-remediation-2026-07-25b',
    seed,
    caseCount: corpus.cases.length,
    falseCompletions,
    missedAccepts: results.filter((r) => r.missedAccept).length,
    results,
  };
};
