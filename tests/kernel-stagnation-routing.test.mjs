import { detectTestStagnation, recommendTestRouting } from './helpers/kernel-host-test-api.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { detectOptionalStagnation } from '../scripts/kernel/run/optional-capabilities.mjs';
import { recommendModelRouting } from '../scripts/kernel/run/model-routing.mjs';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';

test('stagnation needs repeated failed attempts on a still-failing obligation', () => {
  const belowThreshold = detectOptionalStagnation({ attempts: [{ status: 'failed' }, { status: 'failed' }], verifications: [{ obligationId: 'x', status: 'failed' }], flags: { stagnationEscalation: true } });
  assert.equal(belowThreshold.stagnant, false);

  const noFailing = detectOptionalStagnation({ attempts: [{ status: 'failed' }, { status: 'failed' }, { status: 'failed' }], verifications: [{ obligationId: 'x', status: 'passed' }] });
  assert.equal(noFailing.stagnant, false);

  const stagnant = detectOptionalStagnation({
    attempts: [{ status: 'failed' }, { status: 'failed' }, { status: 'failed' }],
    verifications: [{ obligationId: 'x', status: 'failed' }],
  });
  assert.equal(stagnant.stagnant, true);
  assert.equal(stagnant.repeatedObligation, 'x');
});

test('routing policy recommends replan, escalation, or independent review from signals', () => {
  assert.equal(recommendModelRouting({ stagnant: true }).action, 'replan');
  assert.equal(recommendModelRouting({ retryCount: 2 }).action, 'escalate-model');
  assert.equal(recommendModelRouting({ riskTier: 'T3' }).action, 'independent-review');
  assert.equal(recommendModelRouting({ riskTier: 'T0' }).action, 'stay');
});

test('replan count is recorded and surfaces in measurement', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-replan-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-replan-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' } }));
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    await cp.startRun({ runId: 'r-replan', objective: 'x' });
    await cp.replanSteps('r-replan');
    await cp.replanSteps('r-replan');
    const status = await cp.status('r-replan');
    assert.equal(status.measurement.replanCount.status, 'observed');
    assert.equal(status.measurement.replanCount.value, 2);
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('stagnation is detected end to end after repeated failing reports and routing recommends replan', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-stag-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-stag-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'x', scripts: { 'test:fail': 'node -e "process.exit(1)"' } }));
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    await cp.startRun({ runId: 'r-stag', objective: 'x' });
    for (let i = 0; i < 3; i += 1) {
      await cp.report('r-stag', { summary: `try ${i}`, verifications: [{ obligationId: 'default', commandRef: 'test:fail' }] });
    }
    const stagnation = detectTestStagnation(cp, 'r-stag');
    assert.equal(stagnation.stagnant, true);
    const routing = recommendTestRouting(cp, 'r-stag');
    assert.equal(routing.action, 'replan');
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});
