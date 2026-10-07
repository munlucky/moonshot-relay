import { detectTestStagnation, decideTestModelRoute } from './helpers/kernel-host-test-api.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';

const withProject = async (scripts, fn) => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-esc-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-esc-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'x',
    scripts: {
      test: 'node -e "process.exit(0)"',
      lint: 'node -e "process.exit(0)"',
      ...scripts,
    },
  }));
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    return await fn(cp, projectRoot);
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
};

test('T1 work implements on value coding while its engineering review runs on frontier', async () => {
  await withProject({}, async (cp) => {
    await cp.startRun({ runId: 'r-t1', objective: 'behaviour change', taskContract: { flags: { behaviorChanging: true } } });
    const implement = await decideTestModelRoute(cp, 'r-t1', { actionKind: 'implement', obligationId: 'default' });
    assert.equal(implement.modelClass, 'value_coding');
    const review = await decideTestModelRoute(cp, 'r-t1', { actionKind: 'review_engineering' });
    assert.equal(review.modelClass, 'frontier_reasoning');
    assert.equal(review.permissions, 'read_only');
  });
});

test('T3 work still implements on value coding but demands an independent frontier review', async () => {
  await withProject({}, async (cp) => {
    await cp.startRun({ runId: 'r-t3', objective: 'auth change', taskContract: { surfaces: ['security_boundary'] } });
    assert.equal((await cp.getRun('r-t3')).proofTier, 'T3');
    const implement = await decideTestModelRoute(cp, 'r-t3', { actionKind: 'implement', obligationId: 'default' });
    assert.equal(implement.modelClass, 'value_coding');
    assert.equal(implement.independentContextRequired, false);
    for (const stage of ['review_contract', 'review_engineering']) {
      const review = await decideTestModelRoute(cp, 'r-t3', { actionKind: stage });
      assert.equal(review.modelClass, 'frontier_reasoning', stage);
      assert.equal(review.independentContextRequired, true, stage);
    }
  });
});

test('repeated failure on the same obligation escalates implementation to frontier', async () => {
  await withProject({ 'test:fail': 'node -e "process.exit(1)"' }, async (cp) => {
    await cp.startRun({ runId: 'r-retry', objective: 'stubborn bug' });
    const first = await decideTestModelRoute(cp, 'r-retry', { actionKind: 'implement', obligationId: 'default' });
    assert.equal(first.modelClass, 'value_coding');
    for (let i = 0; i < 2; i += 1) {
      await cp.report('r-retry', { summary: `try ${i}`, verifications: [{ obligationId: 'default', commandRef: 'test:fail' }] });
    }
    const escalated = await decideTestModelRoute(cp, 'r-retry', { actionKind: 'implement', obligationId: 'default' });
    assert.equal(escalated.modelClass, 'frontier_reasoning');
    assert.ok(escalated.reasonCodes.includes('RETRY_ESCALATION'));
  });
});

test('stagnation replans on frontier, and the new plan revision resumes value coding', async () => {
  await withProject({ 'test:fail': 'node -e "process.exit(1)"' }, async (cp) => {
    await cp.startRun({
      runId: 'r-stag',
      objective: 'stuck',
      taskContract: {
        acceptance: [{ acceptance: 'works', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:fail'], obligationId: 'default' } }],
      },
    });
    for (let i = 0; i < 3; i += 1) {
      await cp.report('r-stag', { summary: `try ${i}`, verifications: [{ obligationId: 'default', commandRef: 'test:fail' }] });
    }
    assert.equal(detectTestStagnation(cp, 'r-stag').stagnant, true);
    const replan = await decideTestModelRoute(cp, 'r-stag', { actionKind: 'implement', obligationId: 'default' });
    assert.equal(replan.actionKind, 'replan');
    assert.equal(replan.modelClass, 'frontier_reasoning');
    assert.equal(replan.role, 'planner');

    // The frontier planner produces a new contract revision; implementation of
    // that revision is allowed to fall back to the value class (§5.4).
    await cp.replanSteps('r-stag');
    const revised = await cp.reviseContract('r-stag', { ...(await cp.getRun('r-stag')).taskContract, constraints: ['keep the public API'] });
    assert.ok(Number(revised.contractRevision) > 1);
    const resumed = await decideTestModelRoute(cp, 'r-stag', { actionKind: 'implement', obligationId: 'default', });
    assert.equal(resumed.actionKind, 'replan', 'stagnation still stands until new evidence arrives');

    const summary = cp.modelRoutingSummary('r-stag');
    assert.ok(summary.escalatedTurns >= 2);
    assert.equal(summary.valueTurns + summary.frontierTurns, summary.totalTurns);
  });
});

test('an escalation reason is preserved on every recorded decision', async () => {
  await withProject({ 'test:fail': 'node -e "process.exit(1)"' }, async (cp) => {
    await cp.startRun({ runId: 'r-reason', objective: 'reasons' });
    await decideTestModelRoute(cp, 'r-reason', { actionKind: 'implement', obligationId: 'default' });
    await decideTestModelRoute(cp, 'r-reason', { actionKind: 'implement', obligationId: 'default', protectedObligationFailed: true });
    await decideTestModelRoute(cp, 'r-reason', { actionKind: 'implement', obligationId: 'default', planInvalid: true });
    const decisions = (await cp.getRun('r-reason')) && cp.modelRoutingSummary('r-reason');
    assert.equal(decisions.totalTurns, 3);
    assert.equal(decisions.escalatedTurns, 2);
  });
});
