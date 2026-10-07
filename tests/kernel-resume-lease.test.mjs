import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';
import { openKernelStateStore } from '../scripts/kernel/state-store.mjs';

const setupProject = async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-resume-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'resume-fixture',
    version: '0.0.1',
    scripts: { 'test:focus': 'node -e "process.exit(0)"' },
  }, null, 2));
  await writeFile(path.join(projectRoot, 'app.mjs'), 'export const x = 1;\n');
  return projectRoot;
};

test('leases have durable readers and fencing semantics', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-lease-home-'));
  const store = await openKernelStateStore({ runtimeHome });
  try {
    store.createRun({ runId: 'r-lease', objective: 'x', sourceIdentity: 'src-lease' });
    const first = store.acquireLease('r-lease', { holder: 'host-a:1' });
    assert.equal(first.acquired, true);
    const conflict = store.acquireLease('r-lease', { holder: 'host-b:2' });
    assert.equal(conflict.acquired, false);
    assert.equal(conflict.conflict, true);
    // Same holder can re-acquire.
    const same = store.acquireLease('r-lease', { holder: 'host-a:1' });
    assert.equal(same.acquired, true);
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('deterministic resume reconstructs next action from SQLite across a fresh control plane', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-resume-home-'));
  const projectRoot = await setupProject();
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot, holder: 'runner-1' });
  try {
    await cp.startRun({ runId: 'r-resume', objective: 'resume test', taskContract: { acceptance: ['a1'] } });
    const firstNext = await cp.next('r-resume');
    await cp.close();

    // Fresh process/control plane: resume must derive the same next action.
    const cp2 = await createKernelControlPlane({ runtimeHome, projectRoot, holder: 'runner-1' });
    const resumed = await cp2.resume('r-resume');
    assert.equal(resumed.status, 'resumed');
    assert.equal(resumed.state, 'FRAME');
    assert.equal(resumed.attemptCount, 0);
    assert.deepEqual(resumed.next.action, firstNext.action);
    await cp2.close();
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('resume detects a live lease held by a different runner', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-resume-lease2-'));
  const projectRoot = await setupProject();
  const cpA = await createKernelControlPlane({ runtimeHome, projectRoot, holder: 'runner-A' });
  const cpB = await createKernelControlPlane({ runtimeHome, projectRoot, holder: 'runner-B' });
  try {
    await cpA.startRun({ runId: 'r-lease-conflict', objective: 'lease' });
    const held = await cpA.resume('r-lease-conflict');
    assert.equal(held.status, 'resumed');
    const conflict = await cpB.resume('r-lease-conflict');
    assert.equal(conflict.status, 'lease-conflict');
    assert.equal(conflict.lease.holder, 'runner-A');
  } finally {
    await cpA.close();
    await cpB.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('interventions surface in measurement after a blocked/resume cycle', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-resume-measure-'));
  const projectRoot = await setupProject();
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot, holder: 'runner-1' });
  try {
    await cp.startRun({ runId: 'r-measure', objective: 'measure' });
    // Block via a report blocker, then resume with a new report.
    await cp.report('r-measure', { summary: 'need input', blocker: { reason: 'question', detail: 'which db?' } });
    await cp.report('r-measure', { summary: 'resolved', verifications: [{ obligationId: 'default', commandRef: 'test:focus', acceptanceCoverage: [] }] });

    const status = await cp.status('r-measure');
    assert.equal(status.measurement.userInterventionCount.status, 'observed');
    assert.equal(status.measurement.userInterventionCount.value, 1);
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('retryCount counts repeated work attempts from persisted rows', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-resume-retry-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-resume-retry-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'retry-fixture',
    version: '0.0.1',
    scripts: { 'test:focus': 'node -e "process.exit(1)"' },
  }, null, 2));
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot, holder: 'runner-1' });
  try {
    await cp.startRun({ runId: 'r-retry', objective: 'retry' });
    // Two failing work reports: run stays in-progress, two attempts recorded.
    const first = await cp.report('r-retry', { summary: 'try 1', verifications: [{ obligationId: 'default', commandRef: 'test:focus' }] });
    assert.equal(first.status, 'evidence-failed');
    const second = await cp.report('r-retry', { summary: 'try 2', verifications: [{ obligationId: 'default', commandRef: 'test:focus' }] });
    assert.equal(second.status, 'evidence-failed');

    const status = await cp.status('r-retry');
    assert.equal(status.measurement.retryCount.status, 'observed');
    assert.equal(status.measurement.retryCount.value, 1);
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});
