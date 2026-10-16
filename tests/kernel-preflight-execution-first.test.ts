import { lstatSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { preflightTaskContract, BLOCKING_CLASSES } from '../src/kernel/run/contract-preflight.js';
import { contractPathAccess } from '../src/host/kernel/workspace/contract-path-access.js';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';

const setup = async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-pf-ef-proj-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-pf-ef-state-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'preflight-ef-fixture',
    version: '0.0.1',
    scripts: { test: 'node -e "process.exit(0)"' },
  }));
  await writeFile(path.join(projectRoot, 'app.mjs'), 'export const active = true;\n');
  return { projectRoot, runtimeHome };
};

const cleanup = async ({ projectRoot, runtimeHome }: { projectRoot: string; runtimeHome: string }) => {
  await rm(projectRoot, { recursive: true, force: true });
  await rm(runtimeHome, { recursive: true, force: true });
};

test('Preflight Wave 1: Security boundary path escape is classified as safety blocking and unrecoverable', async () => {
  const { projectRoot, runtimeHome } = await setup();
  try {
    assert.throws(
      () => preflightTaskContract({
        ...contractPathAccess,
        projectRoot,
        contract: {
          allowedPaths: ['../escaped.mjs'],
        },
      }),
      (error) => {
        assert.ok(error && typeof error === 'object' && 'blockingClass' in error);
        assert.equal(error.blockingClass, BLOCKING_CLASSES.safety);
        assert.ok(error && typeof error === 'object' && 'recoverable' in error);
        assert.equal(error.recoverable, false);
        return true;
      },
    );
  } finally {
    await cleanup({ projectRoot, runtimeHome });
  }
});

test('Preflight Wave 1: Structural step binding errors have completion blockingClass and are recoverable', async () => {
  const { projectRoot, runtimeHome } = await setup();
  try {
    assert.throws(
      () => preflightTaskContract({
        ...contractPathAccess,
        projectRoot,
        contract: {
          acceptance: [{ id: 'AC-1', acceptance: 'works' }],
          steps: [
            { stepId: 'step-1', allowedPaths: ['app.mjs'], acceptanceIds: ['AC-UNKNOWN'] },
          ],
        },
      }),
      (error) => {
        assert.ok(error && typeof error === 'object' && 'blockingClass' in error);
        assert.equal(error.blockingClass, BLOCKING_CLASSES.completion);
        assert.ok(error && typeof error === 'object' && 'recoverable' in error);
        assert.equal(error.recoverable, true);
        return true;
      },
    );
  } finally {
    await cleanup({ projectRoot, runtimeHome });
  }
});

test('Preflight Wave 1: Missing verification commands at start do not block run creation when non-strict', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const run = await cp.startRun({
      runId: 'r-nonblocking-verify',
      objective: 'execution first verify missing',
      taskContract: {
        acceptance: [{
          acceptance: 'verified later',
          evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:not-yet-defined'] },
        }],
        allowedPaths: ['app.mjs'],
      },
    });
    assert.equal(run.runId, 'r-nonblocking-verify');
    const nextTurn = await cp.next('r-nonblocking-verify');
    assert.ok(nextTurn && typeof nextTurn === 'object' && 'action' in nextTurn);
    assert.ok(nextTurn.action !== null && nextTurn.action !== undefined);
    assert.equal(nextTurn.action.type, 'implement');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('semantic declared steps do not require caller-authored acceptance or obligation ids', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const runId = 'r-semantic-step-bindings';
    const run = await cp.startRun({
      runId,
      objective: 'implement semantic multi-step input',
      taskContract: {
        acceptance: [
          'implementation behavior is present',
          'regression coverage is present',
        ],
        steps: [
          { objective: 'implement behavior', allowedPaths: ['app.mjs'] },
          { objective: 'finish goal proof', allowedPaths: ['app.mjs'] },
        ],
      },
    });

    assert.equal(run.runId, runId);
    const normalizedAcceptance = run.taskContract?.acceptance || [];
    assert.deepEqual(normalizedAcceptance.map((item) => item.id), ['AC-1', 'AC-2']);
    const steps = cp.getRunSteps(runId);
    assert.equal(steps.length, 2);
    assert.deepEqual(steps[0].acceptanceIds || [], []);
    assert.deepEqual(steps[1].acceptanceIds || [], ['AC-1', 'AC-2']);

    const obligationIds = cp.getRunObligations(runId).map((item) => item.obligationId).sort();
    assert.deepEqual(steps[0].obligationIds || [], []);
    assert.deepEqual([...(steps[1].obligationIds || [])].sort(), obligationIds);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('Multi-acceptance contract alone does not invent a decomposition requirement', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const run = await cp.startRun({
      runId: 'r-multi-ac-failsoft',
      objective: 'multi-acceptance task without allowedPaths',
      taskContract: {
        acceptance: [
          'first acceptance criterion works',
          'second acceptance criterion works',
          'third acceptance criterion works',
        ],
      },
    });
    assert.equal(run.runId, 'r-multi-ac-failsoft');
    const nextTurn = await cp.next('r-multi-ac-failsoft');
    assert.ok(nextTurn && typeof nextTurn === 'object' && 'action' in nextTurn);
    assert.ok(nextTurn.action !== null && nextTurn.action !== undefined);
    assert.equal(nextTurn.action.type, 'implement');
    assert.notEqual(nextTurn.status, 'scope-rejected');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('Acceptance count never becomes a hidden planning threshold', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const counts = [0, 1, 2, 3, 9, 10, 100];
    for (const count of counts) {
      const runId = `r-ac-matrix-${count}`;
      const run = await cp.startRun({
        runId,
        objective: `acceptance count matrix ${count}`,
        taskContract: {
          acceptance: Array.from({ length: count }, (_, i) => `criterion-${i + 1}`),
        },
      });
      assert.equal(run.runId, runId);
      const nextTurn = await cp.next(runId);
      assert.ok(nextTurn && typeof nextTurn === 'object' && 'action' in nextTurn);
      assert.ok(nextTurn.action !== null && nextTurn.action !== undefined);
      assert.equal(nextTurn.action.type, 'implement');
      assert.notEqual(nextTurn.status, 'scope-rejected');
      await cp.abandonRun(runId);
    }
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('Preflight Wave 1: Symlink/junction escaping repository is classified as safety blocking and unrecoverable', async () => {
  const { projectRoot, runtimeHome } = await setup();
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'krn-pf-outside-'));
  await writeFile(path.join(outsideDir, 'secret.txt'), 'secret');
  const linkPath = path.join(projectRoot, 'outside-link');
  try {
    try {
      await symlink(outsideDir, linkPath, 'junction');
    } catch {
      await symlink(outsideDir, linkPath, 'dir');
    }
    assert.throws(
      () => preflightTaskContract({
        ...contractPathAccess,
        projectRoot,
        contract: {
          allowedPaths: ['outside-link/secret.txt'],
        },
      }),
      (error) => {
        assert.ok(error && typeof error === 'object' && 'blockingClass' in error);
        assert.equal(error.blockingClass, BLOCKING_CLASSES.safety);
        assert.ok(error && typeof error === 'object' && 'recoverable' in error);
        assert.equal(error.recoverable, false);
        assert.ok(error && typeof error === 'object' && 'details' in error);
        assert.ok(error.details && typeof error.details === 'object' && 'reason' in error.details);
        assert.equal(error.details?.reason, 'out-of-root-symlink');
        return true;
      },
    );
  } finally {
    await rm(linkPath, { force: true, recursive: true }).catch(() => {});
    await rm(outsideDir, { recursive: true, force: true }).catch(() => {});
    await cleanup({ projectRoot, runtimeHome });
  }
});

test('Preflight Wave 1: Normal nested new file is allowed when parent path is physically verified', async () => {
  const { projectRoot, runtimeHome } = await setup();
  try {
    const result = preflightTaskContract({
        ...contractPathAccess,
      projectRoot,
      contract: {
        allowedPaths: ['src/nested/new/file.ts'],
      },
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.allowedPaths, ['src/nested/new/file.ts']);
  } finally {
    await cleanup({ projectRoot, runtimeHome });
  }
});

test('Preflight Wave 1: Broken symlink ancestor is safety blocked with broken-link reason', async () => {
  const { projectRoot, runtimeHome } = await setup();
  const brokenLinkPath = path.join(projectRoot, 'broken-link');
  try {
    // create broken junction/symlink pointing to non-existent target
    try {
      await symlink(path.join(projectRoot, 'missing-target'), brokenLinkPath, 'junction');
    } catch {
      await symlink(path.join(projectRoot, 'missing-target'), brokenLinkPath, 'file');
    }
    assert.throws(
      () => preflightTaskContract({
        ...contractPathAccess,
        projectRoot,
        contract: {
          allowedPaths: ['broken-link/subfile.ts'],
        },
      }),
      (error) => {
        assert.ok(error && typeof error === 'object' && 'blockingClass' in error);
        assert.equal(error.blockingClass, BLOCKING_CLASSES.safety);
        assert.ok(error && typeof error === 'object' && 'recoverable' in error);
        assert.equal(error.recoverable, false);
        assert.ok(error && typeof error === 'object' && 'details' in error);
        assert.ok(error.details && typeof error.details === 'object' && 'reason' in error.details);
        assert.equal(error.details?.reason, 'broken-link');
        return true;
      },
    );
  } finally {
    await rm(brokenLinkPath, { force: true, recursive: true }).catch(() => {});
    await cleanup({ projectRoot, runtimeHome });
  }
});

test('Preflight Wave 1: Injected realpath failure fails closed deterministically', async () => {
  const { projectRoot, runtimeHome } = await setup();
  try {
    // Root realpath failure injection
    assert.throws(
      () => preflightTaskContract({
        ...contractPathAccess,
        projectRoot,
        contract: { allowedPaths: ['app.mjs'] },
        resolveRealpath: () => {
          const err = new Error('EACCES: permission denied');
          assert.ok(err && typeof err === 'object' && 'code' in err);
          err.code = 'EACCES';
          throw err;
        },
      }),
      (error) => {
        assert.ok(error && typeof error === 'object' && 'blockingClass' in error);
        assert.equal(error.blockingClass, BLOCKING_CLASSES.safety);
        assert.ok(error && typeof error === 'object' && 'recoverable' in error);
        assert.equal(error.recoverable, false);
        assert.ok(error && typeof error === 'object' && 'details' in error);
        assert.ok(error.details && typeof error.details === 'object' && 'reason' in error.details);
        assert.equal(error.details?.reason, 'repository-realpath-unavailable');
        return true;
      },
    );

    // Ancestor realpath failure injection
    assert.throws(
      () => preflightTaskContract({
        ...contractPathAccess,
        projectRoot,
        contract: { allowedPaths: ['app.mjs'] },
        lstatPath: (p) => {
          if (p.includes('app.mjs')) {
            const err = new Error('EPERM: operation not permitted');
            assert.ok(err && typeof err === 'object' && 'code' in err);
            err.code = 'EPERM';
            throw err;
          }
          return lstatSync(p);
        },
      }),
      (error) => {
        assert.ok(error && typeof error === 'object' && 'blockingClass' in error);
        assert.equal(error.blockingClass, BLOCKING_CLASSES.safety);
        assert.ok(error && typeof error === 'object' && 'recoverable' in error);
        assert.equal(error.recoverable, false);
        assert.ok(error && typeof error === 'object' && 'details' in error);
        assert.ok(error.details && typeof error.details === 'object' && 'reason' in error.details);
        assert.equal(error.details?.reason, 'ancestor-realpath-unavailable');
        return true;
      },
    );
  } finally {
    await cleanup({ projectRoot, runtimeHome });
  }
});

type KernelControlPlane = Awaited<ReturnType<typeof createKernelControlPlane>>;
