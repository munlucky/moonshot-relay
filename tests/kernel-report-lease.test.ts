import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';

const setup = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-rlease-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-rlease-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'rlease-fixture', version: '0.0.1', scripts: { 'test:ok': 'node -e "process.exit(0)"' },
  }, null, 2));
  return { runtimeHome, projectRoot };
};

test('F4: report is refused when another runner holds a live lease', async () => {
  const { runtimeHome, projectRoot } = await setup();
  const cpA = await createKernelControlPlane({ runtimeHome, projectRoot, holder: 'runner-A' });
  const cpB = await createKernelControlPlane({ runtimeHome, projectRoot, holder: 'runner-B' });
  try {
    await cpA.startRun({ runId: 'r-rl', objective: 'x' });
    // Runner A takes the lease via resume.
    const held = await cpA.resume('r-rl');
    assert.equal(held.status, 'resumed');

    // Runner B cannot report while A's lease is live.
    const refused = await cpB.report('r-rl', { summary: 'sneaky', verifications: [{ obligationId: 'default', commandRef: 'test:ok' }] });
    assert.ok(refused && 'lease' in refused && refused.lease && typeof refused.lease === 'object' && 'holder' in refused.lease);
    assert.equal(refused.status, 'lease-conflict');
    assert.equal(refused.lease.holder, 'runner-A');

    // The rightful holder can still report.
    const ok = await cpA.report('r-rl', { summary: 'legit', verifications: [{ obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: [] }] });
    assert.ok(ok);
    assert.notEqual(ok.status, 'lease-conflict');
  } finally {
    await cpA.close();
    await cpB.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('F4: a single runner reports normally (lease self-renews)', async () => {
  const { runtimeHome, projectRoot } = await setup();
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot, holder: 'solo' });
  try {
    await cp.startRun({ runId: 'r-solo', objective: 'x' });
    const first = await cp.report('r-solo', { summary: 'one', verifications: [{ obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: [] }] });
    assert.ok(first);
    assert.notEqual(first.status, 'lease-conflict');
    assert.equal(first.status, 'completed');
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});
