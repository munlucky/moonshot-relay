import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';
import { kernelDbPath } from '../scripts/kernel/state-store.mjs';
import { openSqliteDb } from '../scripts/kernel/sqlite-adapter.mjs';
import { normalizeTaskContract } from '../scripts/kernel/task/task-contract.mjs';

const setup = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-evidence-semantics-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-evidence-semantics-project-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'evidence-semantics-fixture',
    version: '0.0.1',
    scripts: {
      'test:ok': 'node -p 1',
      'test:other': 'node -p 1',
      lint: 'node -p 1',
    },
  }, null, 2));
  await writeFile(path.join(projectRoot, 'app.mjs'), 'export const value = 0;\n');
  return { runtimeHome, projectRoot };
};

const cleanup = async ({ runtimeHome, projectRoot }) => {
  await rm(runtimeHome, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
};

const plannedContract = (statement = 'the mutation is correct') => ({
  acceptance: [{
    acceptance: statement,
    evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'] },
  }],
});

test('S-14: acceptance cannot downgrade the mandatory root proof to work evidence', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const runId = 'root-proof-downgrade';
    await cp.startRun({ runId, objective: 'reject root proof downgrade', taskContract: {
      acceptance: [{ acceptance: 'root proof is mandatory', evidencePlan: {
        class: 'hard', method: 'unit-test', obligationId: 'default', commandRefs: ['test:ok'], evidenceLevel: 'work',
      } }],
    } });
    const before = await cp.assessCompletion(runId);
    assert.equal(before.obligationStatuses.find((entry) => entry.obligationId === 'default').evidenceLevel, 'goal');
    assert.equal(before.gates.goalEvidenceSatisfied, false);
    const result = await cp.report(runId, { summary: 'execute actual root proof' });
    assert.equal(result.executed.find((entry) => entry.obligationId === 'default').verificationScope, 'goal');
    assert.equal(result.status, 'completed');
  } finally { await cp.close(); await cleanup(fixture); }
});

test('planless proof is automatically bound and executed only when outstanding', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({ runId: 'r-planless-proof', objective: 'x', taskContract: { acceptance: ['works'] } });
    const completed = await cp.report('r-planless-proof', {
      summary: 'proof without an evidence plan',
    });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.executed.length, 1);
    assert.equal(completed.executed[0].commandRef, 'test:ok');
    assert.equal(cp.stateStore.getVerifications('r-planless-proof').length, 1);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('ordinary reports skip an already satisfied obligation unless freshness is explicitly requested', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const runId = 'r-skip-satisfied';
    await cp.startRun({ runId, objective: 'x', taskContract: { riskTier: 'T2', acceptance: ['works'] } });
    await cp.transition(runId, 'EXECUTE');
    await cp.transition(runId, 'PROVE');
    await cp.executeProof(runId, {
      obligationId: 'unit-test',
      commandRef: 'test:ok',
      acceptanceCoverage: ['AC-1'],
    });

    const completed = await cp.report(runId, { summary: 'run only the outstanding proof' });
    assert.equal(completed.status, 'completed');
    assert.deepEqual(completed.executed.map((entry) => entry.obligationId), ['static-analysis']);
    assert.equal(cp.stateStore.getVerificationHistory(runId).filter((entry) => entry.obligationId === 'unit-test').length, 1);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('an optional evidence-plan refinement is persisted before automatic proof', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({ runId: 'r-first-report-plan', objective: 'x', taskContract: { acceptance: ['works'] } });
    await writeFile(path.join(fixture.projectRoot, 'app.mjs'), 'export const value = 3;\n');
    const completed = await cp.report('r-first-report-plan', {
      summary: 'first report binds the plan and proves it',
      changedPaths: ['app.mjs'],
      evidencePlans: [{
        acceptanceId: 'AC-1',
        evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'] },
      }],
      verifications: [
        { obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: [] },
        { obligationId: 'acceptance-ac-1', commandRef: 'test:ok', acceptanceCoverage: ['AC-1'] },
      ],
    });
    assert.equal(completed.status, 'completed');
    assert.equal(cp.stateStore.getRun('r-first-report-plan').taskContract.acceptance[0].evidencePlan.class, 'hard');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('legacy proof can complete through a final report with verifications omitted', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const statement = 'legacy acceptance remains covered';
    await cp.startRun({ runId: 'r-legacy-final', objective: 'x', taskContract: { acceptance: [statement] } });
    await cp.transition('r-legacy-final', 'EXECUTE');
    await cp.transition('r-legacy-final', 'PROVE');
    await cp.recordProof('r-legacy-final', {
      obligationId: 'default',
      status: 'passed',
      evidenceRef: 'legacy://verification/1',
      command: 'npm test',
      evidenceDigest: `sha256:${'b'.repeat(64)}`,
      acceptanceCoverage: [statement],
    });

    const stored = cp.stateStore.getVerifications('r-legacy-final');
    assert.deepEqual(stored[0].acceptanceCoverage, ['AC-1'], 'legacy statement coverage is canonicalized at persistence');

    const finalReport = await cp.report('r-legacy-final', {
      summary: 'legacy final report with no new verification payload',
      verifications: [],
    });
    assert.equal(finalReport.status, 'completed');
    assert.equal(finalReport.finalization.completionResult.gates.evidencePlansComplete, true);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('a legacy run with persisted proof but no task contract cannot complete', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const statement = 'legacy acceptance has no structured plan';
    await cp.startRun({ runId: 'r-legacy-no-contract', objective: 'x', taskContract: plannedContract(statement) });
    await cp.transition('r-legacy-no-contract', 'EXECUTE');
    await cp.transition('r-legacy-no-contract', 'PROVE');

    // Reproduce a pre-contract persisted run: acceptance_criteria survives,
    // while the newer task_contract_json column is absent.
    const db = await openSqliteDb(kernelDbPath(fixture.runtimeHome));
    try {
      db.prepare('UPDATE runs SET task_contract_json=NULL WHERE run_id=?').run('r-legacy-no-contract');
    } finally {
      db.close?.();
    }

    await cp.recordProof('r-legacy-no-contract', {
      obligationId: 'default',
      status: 'passed',
      evidenceRef: 'legacy://verification/default-no-contract',
      command: 'npm test',
      evidenceDigest: `sha256:${'e'.repeat(64)}`,
      acceptanceCoverage: [],
    });
    await cp.recordProof('r-legacy-no-contract', {
      obligationId: 'acceptance-ac-1',
      status: 'passed',
      evidenceRef: 'legacy://verification/no-contract',
      command: 'npm test',
      evidenceDigest: `sha256:${'d'.repeat(64)}`,
      acceptanceCoverage: [statement],
    });

    const finalReport = await cp.report('r-legacy-no-contract', {
      summary: 'legacy proof must not bypass the structured contract gate',
      verifications: [],
    });
    assert.notEqual(finalReport.status, 'completed');
    assert.equal((await cp.assessCompletion('r-legacy-no-contract')).gates.evidencePlansComplete, false);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('a persisted proof from an earlier evidence-plan revision cannot satisfy the revised plan', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const runId = 'r-plan-revision-proof';
    await cp.startRun({ runId, objective: 'x', taskContract: plannedContract() });
    await cp.transition(runId, 'EXECUTE');
    await cp.transition(runId, 'PROVE');
    await cp.executeProof(runId, {
      obligationId: 'acceptance-ac-1',
      commandRef: 'test:ok',
      acceptanceCoverage: ['AC-1'],
    });
    assert.equal(cp.stateStore.getVerifications(runId)[0].commandRef, 'test:ok');

    await cp.reviseContract(runId, normalizeTaskContract({
      acceptance: [{
        acceptance: 'the mutation is correct',
        evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:other'] },
      }],
    }, { objective: 'x' }));

    // The old receipt is stale immediately after the revision. The final
    // report may then run the newly bound command as the outstanding proof.
    const beforeAutomaticProof = await cp.assessCompletion(runId);
    assert.equal(beforeAutomaticProof.gates.acceptanceCovered, false);
    assert.ok(beforeAutomaticProof.unsatisfiedObligations.some((entry) => entry.obligationId === 'acceptance-ac-1'));

    const finalReport = await cp.report(runId, {
      summary: 'the old command must not satisfy the new plan',
      verifications: [],
    });
    assert.equal(finalReport.status, 'completed');
    const completion = await cp.assessCompletion(runId);
    assert.equal(completion.gates.acceptanceCovered, true);
    const revisedPlanExecution = finalReport.executed.find((entry) => entry.obligationId === 'acceptance-ac-1');
    assert.equal(revisedPlanExecution?.commandRef, 'test:other');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('statement coverage is stored as the canonical AC id for a planned obligation', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const statement = 'the planned statement holds';
    await cp.startRun({ runId: 'r-canonical-statement', objective: 'x', taskContract: plannedContract(statement) });
    await cp.transition('r-canonical-statement', 'EXECUTE');
    await cp.transition('r-canonical-statement', 'PROVE');
    await cp.recordProof('r-canonical-statement', {
      obligationId: 'acceptance-ac-1',
      status: 'passed',
      evidenceRef: 'proof://statement/1',
      command: 'npm test',
      evidenceDigest: `sha256:${'c'.repeat(64)}`,
      acceptanceCoverage: [statement],
    });
    assert.deepEqual(cp.stateStore.getVerifications('r-canonical-statement')[0].acceptanceCoverage, ['AC-1']);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('mutation explicit knowledge observation is reviewed and committed at a higher revision', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const run = await cp.startRun({ runId: 'r-explicit-knowledge', objective: 'x', taskContract: plannedContract() });
    await writeFile(path.join(fixture.projectRoot, 'app.mjs'), 'export const value = 1;\n');
    const report = await cp.report('r-explicit-knowledge', {
      summary: 'mutation with explicit reusable knowledge',
      changedPaths: ['app.mjs'],
      verifications: [
        { obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: [] },
        { obligationId: 'acceptance-ac-1', commandRef: 'test:ok', acceptanceCoverage: ['AC-1'] },
      ],
      knowledgeObservations: [{
        candidateId: 'candidate-explicit-1',
        proposedType: 'semantic_fact',
        statement: 'The evidence semantics fixture keeps acceptance coverage bound to its planned obligation.',
        scope: ['app.mjs'],
        acceptanceIds: ['AC-1'],
        obligationIds: ['acceptance-ac-1'],
      }],
    });

    assert.equal(report.status, 'completed');
    assert.equal(report.finalization.knowledgeStatus, 'committed');
    assert.equal(report.finalization.knowledgeCommitReceipt.status, 'committed');
    assert.equal(report.finalization.knowledgeCommitReceipt.revisionBefore, String(run.knowledgeRevisionStart));
    assert.equal(Number(report.finalization.knowledgeCommitReceipt.revisionAfter), Number(run.knowledgeRevisionStart) + 1);
    assert.equal(report.finalization.reviewResult.verifiedCandidates.length, 1);
    const records = cp.stateStore.listKnowledgeRecords({ projectId: run.projectId, statuses: ['committed'] });
    assert.ok(records.some((record) => record.statement.includes('acceptance coverage bound') && record.status === 'committed'));
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('mutation with zero knowledge candidates leaves a structured warning in the final receipt', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({ runId: 'r-no-knowledge', objective: 'x', taskContract: plannedContract() });
    await writeFile(path.join(fixture.projectRoot, 'app.mjs'), 'export const value = 2;\n');
    const report = await cp.report('r-no-knowledge', {
      summary: 'mutation without a reusable observation',
      changedPaths: ['app.mjs'],
      verifications: [
        { obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: [] },
        { obligationId: 'acceptance-ac-1', commandRef: 'test:ok', acceptanceCoverage: ['AC-1'] },
      ],
    });

    assert.equal(report.status, 'completed');
    assert.equal(report.finalization.knowledgeStatus, 'no_change');
    assert.equal(report.finalization.knowledgeWarning, true);
    assert.equal(report.finalization.knowledgeWarningReason, 'mutation_completed_without_explicit_or_structured_knowledge_candidate');
    assert.deepEqual(report.finalization.knowledgeWarningDetail, {
      code: 'MUTATION_WITHOUT_KNOWLEDGE_CANDIDATE',
      reason: 'mutation_completed_without_explicit_or_structured_knowledge_candidate',
      mutationRevision: 1,
      candidateCount: 0,
    });
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('S-14: Work-level evidence can cover acceptance but cannot close the Goal without Goal-level proof', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const runId = 'r-work-only-proof';
    await cp.startRun({ runId, objective: 'x', taskContract: plannedContract('work proof is bounded') });
    await cp.transition(runId, 'EXECUTE');
    await cp.transition(runId, 'PROVE');
    await cp.executeProof(runId, {
      obligationId: 'acceptance-ac-1',
      commandRef: 'test:ok',
      acceptanceCoverage: ['AC-1'],
    });

    const workOnly = await cp.assessCompletion(runId);
    const acceptance = workOnly.obligationStatuses.find((entry) => entry.obligationId === 'acceptance-ac-1');
    assert.equal(acceptance.evidenceLevel, 'work');
    assert.equal(acceptance.satisfied, true);
    assert.equal(workOnly.gates.acceptanceCovered, true);
    assert.equal(workOnly.gates.goalEvidenceSatisfied, false);
    assert.equal(workOnly.readyExceptClose, false);

    await cp.executeProof(runId, {
      obligationId: 'default',
      commandRef: 'test:ok',
      acceptanceCoverage: [],
    });
    const rooted = await cp.assessCompletion(runId);
    const goal = rooted.obligationStatuses.find((entry) => entry.obligationId === 'default');
    assert.equal(goal.evidenceLevel, 'goal');
    assert.equal(goal.satisfied, true);
    assert.equal(rooted.gates.goalEvidenceSatisfied, true);
    assert.equal(rooted.readyExceptClose, true);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('S-13: an affected scoped proof becomes stale while an unaffected scope remains reusable', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const runId = 'r-scoped-freshness';
    await writeFile(path.join(fixture.projectRoot, 'other.mjs'), 'export const other = 0;\n');
    await cp.startRun({
      runId,
      objective: 'x',
      taskContract: {
        acceptance: [{
          acceptance: 'app behavior remains correct',
          evidencePlan: {
            class: 'hard',
            method: 'unit-test',
            commandRefs: ['test:ok'],
            scope: ['app.mjs'],
          },
        }],
      },
    });
    await cp.transition(runId, 'EXECUTE');
    await cp.transition(runId, 'PROVE');
    await cp.executeProof(runId, {
      obligationId: 'acceptance-ac-1',
      commandRef: 'test:ok',
      acceptanceCoverage: ['AC-1'],
    });
    await cp.executeProof(runId, { obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: [] });

    await writeFile(path.join(fixture.projectRoot, 'other.mjs'), 'export const other = 1;\n');
    const unrelated = await cp.finalizeRun(runId, { changedPaths: ['other.mjs'] });
    assert.equal(unrelated.finalizationStatus, 'incomplete_gates');
    let trust = cp.trustAuthority(runId);
    const scopedAfterUnrelated = trust.evidence.hard.find((entry) => entry.obligationId === 'acceptance-ac-1');
    const goalAfterUnrelated = trust.evidence.hard.find((entry) => entry.obligationId === 'default');
    assert.equal(scopedAfterUnrelated.freshness.status, 'fresh');
    assert.equal(goalAfterUnrelated.freshness.status, 'stale');

    await writeFile(path.join(fixture.projectRoot, 'app.mjs'), 'export const value = 9;\n');
    await cp.finalizeRun(runId, { changedPaths: ['app.mjs'] });
    trust = cp.trustAuthority(runId);
    const scopedAfterAffected = trust.evidence.hard.find((entry) => entry.obligationId === 'acceptance-ac-1');
    assert.equal(scopedAfterAffected.freshness.status, 'stale');
    assert.ok(scopedAfterAffected.freshness.reasons.includes('verification-scope-stale'));
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('S-15: a nonzero Goal regression cannot satisfy the Goal completion gate', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const runId = 'r-goal-regression-failed';
    await cp.startRun({ runId, objective: 'x', taskContract: plannedContract('leaf still passes') });
    await cp.transition(runId, 'EXECUTE');
    await cp.transition(runId, 'PROVE');
    await cp.executeProof(runId, {
      obligationId: 'acceptance-ac-1',
      commandRef: 'test:ok',
      acceptanceCoverage: ['AC-1'],
    });
    const run = cp.stateStore.getRun(runId);
    cp.stateStore.recordVerification(runId, {
      obligationId: 'default',
      status: 'passed',
      evidenceRef: 'proof://goal/nonzero',
      sourceIdentity: run.sourceIdentity,
      verifiedSourceIdentity: run.currentWorkspaceIdentity,
      commandRef: 'test:ok',
      command: 'npm run test:ok',
      exitCode: 1,
      evidenceDigest: `sha256:${'9'.repeat(64)}`,
      acceptanceCoverage: [],
      executor: 'kernel-runtime',
      evidenceClass: 'hard',
    });

    const completion = await cp.assessCompletion(runId);
    const goal = completion.obligationStatuses.find((entry) => entry.obligationId === 'default');
    assert.equal(goal.satisfied, false);
    assert.equal(completion.gates.goalEvidenceSatisfied, false);
    assert.equal(completion.readyExceptClose, false);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('Wave 10: declared integration evidence is a real middle gate and cannot substitute for Goal proof', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const runId = 'r-integration-evidence-level';
    await cp.startRun({
      runId,
      objective: 'verify three-level evidence hierarchy',
      taskContract: {
        acceptance: ['three-level verification completes'],
        requiredVerifications: [{
          obligationId: 'integration-check',
          commandRef: 'test:ok',
          method: 'unit-test',
          evidenceLevel: 'integration',
        }],
      },
    });
    await cp.transition(runId, 'EXECUTE');
    await cp.transition(runId, 'PROVE');

    await cp.executeProof(runId, {
      obligationId: 'integration-check',
      commandRef: 'test:ok',
      acceptanceCoverage: [],
    });
    const integrated = await cp.assessCompletion(runId);
    const integration = integrated.obligationStatuses.find((entry) => entry.obligationId === 'integration-check');
    assert.equal(integration.evidenceLevel, 'integration');
    assert.equal(integration.satisfied, true);
    assert.equal(integrated.gates.integrationEvidenceSatisfied, true);
    assert.equal(integrated.integrationEvidence.required, true);
    assert.equal(integrated.integrationEvidence.count, 1);
    assert.equal(integrated.gates.goalEvidenceSatisfied, false);
    assert.equal(integrated.readyExceptClose, false);

    await cp.executeProof(runId, {
      obligationId: 'default',
      commandRef: 'test:ok',
      acceptanceCoverage: ['AC-1'],
    });
    const rooted = await cp.assessCompletion(runId);
    assert.equal(rooted.gates.integrationEvidenceSatisfied, true);
    assert.equal(rooted.gates.goalEvidenceSatisfied, true);
    assert.equal(rooted.readyExceptClose, true);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});
