import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { planWalkingSkeleton, requiredEvidenceForProjectType, needsExpandedDesign } from '../src/kernel/task/greenfield-bootstrap.js';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';

test('project-type evidence mapping matches the completion table', () => {
  assert.equal(requiredEvidenceForProjectType('cli').kind, 'cli-smoke');
  assert.equal(requiredEvidenceForProjectType('api').kind, 'api-scenario');
  assert.equal(requiredEvidenceForProjectType('web').kind, 'browser-scenario');
  assert.equal(requiredEvidenceForProjectType('data').kind, 'data-pipeline');
  assert.equal(requiredEvidenceForProjectType('deploy').kind, 'deployment-smoke');
  assert.equal(requiredEvidenceForProjectType('unknown').kind, 'public-import');
});

test('design only expands past the walking skeleton on explicit signals', () => {
  assert.equal(needsExpandedDesign({}), false);
  assert.equal(needsExpandedDesign({ database: true }), true);
  assert.equal(needsExpandedDesign({ risk: { authBoundary: true } }), true);
});

test('walking skeleton is a minimal runnable vertical slice with real verification', () => {
  const plan = planWalkingSkeleton({ projectType: 'cli', objective: 'build a todo cli' });
  assert.deepEqual(plan.slice, [
    'user-input',
    'application-boundary',
    'core-business-action',
    'store-or-minimal-mock',
    'return-result',
    'real-verification',
  ]);
  assert.equal(plan.requiredEvidence.kind, 'cli-smoke');
  assert.ok(plan.minimumCompletion.includes('build'));
  assert.ok(plan.minimumCompletion.includes('cli-smoke'));
  assert.equal(plan.expandedDesign, false);
});

test('greenfieldPlan is applicable only for greenfield runs', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-green-home-'));
  const emptyProject = await mkdtemp(path.join(os.tmpdir(), 'krn-green-empty-'));
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot: emptyProject });
  try {
    await cp.startRun({ runId: 'r-green', objective: 'new project' });
    const run = await cp.getRun('r-green');
    assert.ok(run);
    assert.equal(run.projectMode, 'greenfield');
    const plan = await cp.greenfieldPlan('r-green', { projectType: 'api' });
    assert.equal(plan.applicable, true);
    assert.equal(plan.plan.requiredEvidence.kind, 'api-scenario');
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(emptyProject, { recursive: true, force: true });
  }
});
