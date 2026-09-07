// K2: long work has a durable cursor. `next` hands out one unit, `report`
// answers it, and a passed step is not a completed run.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';
import { allStepsPassed, dependenciesSatisfied, evaluateStepCompletion, selectExecutableSteps } from '../scripts/kernel/run/run-step-ledger.mjs';
import { planReplacementSteps, stepLedgerApplies } from '../scripts/kernel/run/step-planner.mjs';

const setup = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-step-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-step-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'step-fixture', version: '0.0.1', scripts: { 'test:ok': 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' },
  }, null, 2));
  await mkdir(path.join(projectRoot, 'src', 'auth'), { recursive: true });
  await mkdir(path.join(projectRoot, 'tests'), { recursive: true });
  await writeFile(path.join(projectRoot, 'src', 'auth', 'service.mjs'), 'export const v = 0;\n');
  await writeFile(path.join(projectRoot, 'tests', 'auth.test.mjs'), 'export const t = 0;\n');
  spawnSync('git', ['add', '--all'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'fixture', '--quiet'], { cwd: projectRoot, encoding: 'utf8' });
  return { runtimeHome, projectRoot };
};

const cleanup = async ({ runtimeHome, projectRoot }) => {
  await rm(runtimeHome, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
};

// T2 so the run's required obligations are exactly the two the steps claim;
// anything a decomposition leaves unclaimed lands on the last step by design.
export const COMPLEX_CONTRACT = {
  complex: true,
  riskTier: 'T2',
  acceptance: [
    { acceptance: 'auth rejects expired tokens', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'unit-test' } },
    { acceptance: 'the suite stays clean', evidencePlan: { class: 'hard', method: 'static-analysis', commandRefs: ['lint'], obligationId: 'static-analysis' } },
  ],
  steps: [
    { objective: 'Implement token expiry', allowedPaths: ['src/auth/**'], acceptanceIds: ['AC-1'], obligationIds: ['unit-test'] },
    { objective: 'Cover it with a regression test', allowedPaths: ['tests/**'], acceptanceIds: ['AC-2'], obligationIds: ['static-analysis'] },
  ],
};

const mutate = (fixture, file, value) => writeFile(path.join(fixture.projectRoot, file), `export const v = ${value};\n`);

test('K2-1: a simple run gets one synthetic step and the loop is unchanged', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({
      runId: 'r-simple',
      objective: 'Fix it',
      taskContract: { acceptance: [{ acceptance: 'works', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'default' } }] },
    });
    const steps = cp.getRunSteps('r-simple');
    assert.equal(steps.length, 1);
    assert.equal(steps[0].synthetic, true);
    assert.equal(steps[0].state, 'ready');
    assert.equal(steps[0].objective, 'Fix it');

    // The model still just implements and reports; no stepId is required.
    const next = await cp.next('r-simple');
    assert.equal(next.action.type, 'implement');
    assert.equal(next.action.step.stepId, steps[0].stepId);

    await mutate(fixture, 'src/auth/service.mjs', 1);
    const reported = await cp.report('r-simple', {
      summary: 'fix',
      changedPaths: ['src/auth/service.mjs'],
      verifications: [{ obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: ['works'] }],
    });
    assert.equal(reported.status, 'completed');
    assert.equal(reported.step.state, 'passed');
    assert.equal(cp.getRunSteps('r-simple')[0].state, 'passed');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K2-2/3: a complex run is decomposed and a dependent step cannot be taken early', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({ runId: 'r-complex', objective: 'Harden auth', taskContract: COMPLEX_CONTRACT });
    const steps = cp.getRunSteps('r-complex');
    assert.equal(steps.length, 2);
    assert.equal(steps[0].state, 'ready');
    assert.equal(steps[1].state, 'planned', 'a dependent step is not runnable yet');
    assert.deepEqual(steps[1].dependencyIds, [steps[0].stepId]);
    assert.deepEqual(steps[0].allowedPaths, ['src/auth/**']);

    // The cursor is the first step, and only that one.
    assert.equal(cp.getCurrentStep('r-complex').stepId, steps[0].stepId);
    assert.equal(selectExecutableSteps(steps, { planRevision: 1 }).steps.length, 1);
    assert.equal(dependenciesSatisfied(steps[1], steps), false);

    // Reporting the second step while the first is unfinished is refused.
    await mutate(fixture, 'src/auth/service.mjs', 1);
    const early = await cp.report('r-complex', { summary: 'jumping ahead', stepId: steps[1].stepId, changedPaths: ['tests/auth.test.mjs'] });
    assert.equal(early.status, 'step-rejected');
    assert.match(early.failures[0].errorSummary, /is not the current work unit/);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K2-8/9: a passed step advances the cursor but only a full plan completes the run', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({ runId: 'r-cursor', objective: 'Harden auth', taskContract: COMPLEX_CONTRACT });
    const [first, second] = cp.getRunSteps('r-cursor');

    await mutate(fixture, 'src/auth/service.mjs', 1);
    const step1 = await cp.report('r-cursor', {
      summary: 'token expiry',
      stepId: first.stepId,
      changedPaths: ['src/auth/service.mjs'],
      verifications: [{ obligationId: 'unit-test', commandRef: 'test:ok', acceptanceCoverage: ['AC-1'] }],
    });
    assert.equal(step1.step.state, 'passed');
    assert.notEqual(step1.status, 'completed', 'one passed step is not a completed run');
    assert.equal(cp.getRunSteps('r-cursor').find((step) => step.stepId === second.stepId).state, 'ready', 'the dependent step is unlocked');
    assert.equal(cp.getCurrentStep('r-cursor').stepId, second.stepId, 'the cursor advanced');

    await mutate(fixture, 'tests/auth.test.mjs', 1);
    const step2 = await cp.report('r-cursor', {
      summary: 'regression test',
      stepId: second.stepId,
      changedPaths: ['tests/auth.test.mjs'],
      // The second step moved the workspace, so step one's evidence is stale at
      // the run level: completion authority still demands current-revision
      // evidence for every obligation. A step pass records that the unit of work
      // was done — it never exempts the run from proving itself at the end.
      verifications: [
        { obligationId: 'static-analysis', commandRef: 'lint', acceptanceCoverage: ['AC-2'] },
        { obligationId: 'unit-test', commandRef: 'test:ok', acceptanceCoverage: ['AC-1'] },
      ],
    });
    assert.equal(step2.step.state, 'passed');
    assert.equal(allStepsPassed(cp.getRunSteps('r-cursor'), 1), true);
    assert.equal(step2.status, 'completed');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});


test('verification boundary: non-final work runs focused proof and final work runs goal proof once', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const contract = {
      ...COMPLEX_CONTRACT,
      requiredVerifications: [
        { obligationId: 'goal-regression', commandRef: 'test:ok', method: 'unit-test', timeoutMs: 600000 },
      ],
    };
    await cp.startRun({ runId: 'r-proof-boundary', objective: 'Harden auth once', taskContract: contract });
    const [first, second] = cp.getRunSteps('r-proof-boundary');

    await mutate(fixture, 'src/auth/service.mjs', 1);
    const step1 = await cp.report('r-proof-boundary', {
      summary: 'first work unit',
      stepId: first.stepId,
      changedPaths: ['src/auth/service.mjs'],
      verifications: [{ obligationId: 'unit-test', commandRef: 'test:ok', acceptanceCoverage: ['AC-1'] }],
    });
    assert.equal(step1.step.state, 'passed');
    assert.equal(step1.executed.some((entry) => entry.obligationId === 'goal-regression'), false, 'goal proof is deferred while work remains');
    assert.equal(cp.getRunSteps('r-proof-boundary').find((step) => step.stepId === second.stepId).state, 'ready');

    await mutate(fixture, 'tests/auth.test.mjs', 1);
    const step2 = await cp.report('r-proof-boundary', {
      summary: 'final work unit',
      stepId: second.stepId,
      changedPaths: ['tests/auth.test.mjs'],
      verifications: [
        { obligationId: 'static-analysis', commandRef: 'lint', acceptanceCoverage: ['AC-2'] },
        { obligationId: 'unit-test', commandRef: 'test:ok', acceptanceCoverage: ['AC-1'] },
      ],
    });
    assert.equal(step2.step.state, 'passed');
    const goalExecutions = step2.executed.filter((entry) => entry.obligationId === 'goal-regression');
    assert.equal(goalExecutions.length, 1, 'goal proof executes once at the final mutation revision');
    assert.equal(goalExecutions[0].verificationScope, 'goal');
    assert.equal(step2.status, 'completed');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K2: the ledger only decomposes when the work actually calls for it', () => {
  assert.equal(stepLedgerApplies({ contract: { taskClass: 'feature' }, route: { stages: ['FRAME', 'EXECUTE', 'PROVE', 'CLOSE'] } }).applies, false);
  assert.equal(stepLedgerApplies({ contract: { taskClass: 'long-running' } }).applies, true);
  assert.equal(stepLedgerApplies({ contract: { flags: { complex: true } } }).applies, true);
  assert.equal(stepLedgerApplies({ contract: {}, filesChanged: 12 }).applies, true);
  assert.equal(stepLedgerApplies({ contract: {}, route: { stages: ['FRAME', 'EXECUTE', 'PROVE', 'CLOSE'] } }).applies, false);
  assert.equal(stepLedgerApplies({ contract: {}, safeParallelSplit: true }).applies, false);
});

test('K2: a step is only complete with current-revision evidence for what it owns', () => {
  const step = { stepId: 'step-1-1', obligationIds: ['unit-test'], acceptanceIds: ['AC-1'] };
  const run = { mutationRevision: 3, currentWorkspaceIdentity: `sha256:${'a'.repeat(64)}` };
  const acceptance = [{ id: 'AC-1', statement: 'auth works' }];
  const passing = [{ obligationId: 'unit-test', status: 'passed', verifiedMutationRevision: 3, acceptanceCoverage: ['AC-1'] }];

  assert.equal(evaluateStepCompletion({ step, verifications: passing, run, acceptance }).complete, true);
  // Coverage declared by statement is accepted exactly as the run gate accepts it.
  assert.equal(evaluateStepCompletion({
    step, run, acceptance, verifications: [{ ...passing[0], acceptanceCoverage: ['auth works'] }],
  }).complete, true);

  assert.deepEqual(
    evaluateStepCompletion({ step, run, acceptance, verifications: [{ ...passing[0], verifiedMutationRevision: 2 }] }).reasons,
    ['obligation-stale:unit-test'],
  );
  assert.deepEqual(
    evaluateStepCompletion({ step, run, acceptance, verifications: [{ ...passing[0], acceptanceCoverage: [] }] }).reasons,
    ['acceptance-uncovered:AC-1'],
  );
  assert.deepEqual(
    evaluateStepCompletion({ step, run, acceptance, verifications: [] }).reasons,
    ['obligation-unsatisfied:unit-test', 'acceptance-uncovered:AC-1'],
  );
});

test('K2: explicit dependencies are remapped to qualified step IDs during replan', () => {
  const run = { runId: 'r-replan-deps', objective: 'Replan test' };
  const reservedStepIds = ['auth-slice'];
  const deltaSteps = [
    { stepId: 'auth-slice', objective: 'Auth slice v2' },
    { stepId: 'auth-test', objective: 'Auth test', dependsOn: ['auth-slice'] },
  ];
  const steps = planReplacementSteps({ run, planRevision: 2, deltaSteps, reservedStepIds });
  assert.equal(steps[0].stepId, 'auth-slice@r2');
  assert.equal(steps[1].stepId, 'auth-test');
  assert.deepEqual(steps[1].dependencyIds, ['auth-slice@r2']);
});

test('K2: step ID qualification loops until unique when fallback names exist in ledger', () => {
  const run = { runId: 'r-qual-loop', objective: 'Loop qualification test' };
  const reservedStepIds = ['foo', 'foo@r2', 'foo@r2-1'];
  const deltaSteps = [
    { stepId: 'foo', objective: 'Step foo' },
  ];
  const steps = planReplacementSteps({ run, planRevision: 2, deltaSteps, reservedStepIds });
  assert.equal(steps[0].stepId, 'foo@r2-2');
});
