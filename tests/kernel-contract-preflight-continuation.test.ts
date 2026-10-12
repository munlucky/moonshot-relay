import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { preflightTaskContract } from '../src/kernel/run/contract-preflight.js';
import { contractPathAccess } from '../src/host/kernel/workspace/contract-path-access.js';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';

test('structural preflight error returns recoverable: true for model self-healing', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-preflight-heal-'));
  try {
    assert.throws(
      () => preflightTaskContract({
        ...contractPathAccess,
        projectRoot,
        contract: {
          acceptance: [{ id: 'AC-1', acceptance: 'tested' }],
          steps: [
            { stepId: 'step-1', allowedPaths: ['app.mjs'], acceptanceIds: ['UNKNOWN-AC'] },
          ],
        },
      }),
      (error) => {
        assert.ok(error instanceof Error && 'recoverable' in error);
        assert.ok('nextAction' in error && 'errorCode' in error);
        assert.equal(error.recoverable, true);
        assert.equal(error.nextAction, 'revise-task-contract');
        return true;
      },
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('security boundary path escape returns recoverable: false', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-preflight-sec-'));
  try {
    assert.throws(
      () => preflightTaskContract({
        ...contractPathAccess,
        projectRoot,
        contract: {
          allowedPaths: ['../external.mjs'],
        },
      }),
      (error) => {
        assert.ok(error instanceof Error && 'recoverable' in error);
        assert.ok('nextAction' in error && 'errorCode' in error);
        assert.equal(error.recoverable, false);
        return true;
      },
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('control plane preserves recoverable: true in model-visible rejection and supports self-healing retry', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-cp-preflight-proj-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-cp-preflight-state-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'preflight-fixture',
    version: '0.0.1',
    scripts: { lint: 'node -e "process.exit(0)"' },
  }));
  await writeFile(path.join(projectRoot, 'app.mjs'), 'export const v = 1;\n');

  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    // 1. Initial attempt with invalid step acceptanceIds binding
    const invalidContract = {
      objective: 'self-healable task',
      acceptance: [{ id: 'AC-1', acceptance: 'works' }],
      allowedPaths: ['app.mjs'],
      steps: [
        { stepId: 'step-1', objective: 'do work', allowedPaths: ['app.mjs'], acceptanceIds: ['NON_EXISTENT_AC'] },
      ],
    };

    await assert.rejects(
      async () => cp.ensureRun({
        runId: 'heal-run-1',
        objective: invalidContract.objective,
        taskContract: invalidContract,
      }),
      (error) => {
        assert.ok(error instanceof Error && 'recoverable' in error);
        assert.ok('nextAction' in error && 'errorCode' in error);
        assert.equal(error.recoverable, true);
        assert.equal(error.nextAction, 'revise-task-contract');
        assert.equal(error.errorCode, 'contract-step-binding-invalid');
        return true;
      },
    );

    // 2. Self-repair: retry with corrected step acceptanceIds
    const validContract = {
      ...invalidContract,
      steps: [
        { stepId: 'step-1', objective: 'do work', allowedPaths: ['app.mjs'], acceptanceIds: ['AC-1'] },
      ],
    };

    const repaired = await cp.ensureRun({
      runId: 'heal-run-1',
      objective: validContract.objective,
      taskContract: validContract,
    });

    assert.equal(repaired.status, 'created');
    const nextTurn = await cp.next('heal-run-1');
    assert.ok('action' in nextTurn && nextTurn.action);
    assert.equal(nextTurn.action.type, 'implement');
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});
