import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';

const setup = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-gate-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-gate-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'gate-fixture', version: '0.0.1', scripts: { 'test:ok': 'node -e "process.exit(0)"' },
  }, null, 2));
  return { runtimeHome, projectRoot };
};

test('a run with uncovered acceptance is not closed into an unrecoverable state and can recover', async () => {
  const { runtimeHome, projectRoot } = await setup();
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    await cp.startRun({
      runId: 'r-gate',
      objective: 'x',
      taskContract: {
        acceptance: [{ acceptance: 'works', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'default' } }],
      },
    });

    // First report: obligation passes but acceptance is NOT covered.
    const first = await cp.report('r-gate', {
      summary: 'passing test but acceptance uncovered',
      verifications: [{ obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: [] }],
    });
    assert.ok(first && 'finalization' in first && first.finalization && typeof first.finalization === 'object' && 'finalizationStatus' in first.finalization && 'unmetGates' in first.finalization && Array.isArray(first.finalization.unmetGates));
    assert.notEqual(first.status, 'completed');
    assert.equal(first.finalization.finalizationStatus, 'incomplete_gates');
    assert.ok(first.finalization.unmetGates.includes('acceptanceCovered'));

    // The run must remain recoverable (NOT stranded in CLOSE).
    const midRun = await cp.getRun('r-gate');
    assert.ok(midRun);
    assert.notEqual(midRun.state, 'CLOSE');
    assert.notEqual(midRun.status, 'completed');

    // Second report covers the acceptance -> the run completes cleanly.
    const second = await cp.report('r-gate', {
      summary: 'now covering acceptance',
      verifications: [{ obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: ['works'] }],
    });
    assert.ok(second && 'finalization' in second && second.finalization && typeof second.finalization === 'object' && 'completionStatus' in second.finalization);
    assert.equal(second.status, 'completed');
    assert.equal(second.finalization.completionStatus, 'accepted');
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('finalizeRun leaves a gate-incomplete run in PROVE, not CLOSE', async () => {
  const { runtimeHome, projectRoot } = await setup();
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    await cp.startRun({
      runId: 'r-gate2',
      objective: 'x',
      taskContract: {
        acceptance: [{ acceptance: 'must-cover', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'default' } }],
      },
    });
    await cp.transition('r-gate2', 'EXECUTE');
    await cp.transition('r-gate2', 'PROVE');
    await cp.executeProof('r-gate2', { obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: [] });

    const receipt = await cp.finalizeRun('r-gate2');
    assert.ok('finalizationStatus' in receipt);
    assert.equal(receipt.finalizationStatus, 'incomplete_gates');
    const run = await cp.getRun('r-gate2');
    assert.ok(run);
    assert.equal(run.state, 'PROVE');
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});
