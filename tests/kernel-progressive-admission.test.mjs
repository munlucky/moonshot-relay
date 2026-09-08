import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';

const setup = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-prog-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-prog-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'progressive-admission-fixture',
    version: '0.0.1',
    scripts: { lint: 'node -e \"process.exit(0)\"' },
  }));
  await writeFile(path.join(projectRoot, 'app.mjs'), 'export const value = 0;\n');
  return { runtimeHome, projectRoot };
};

const cleanup = async ({ runtimeHome, projectRoot }) => {
  await rm(runtimeHome, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
};

test("Case A: start-time admission succeeds even if final verification command is missing at start", async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const started = await cp.startRun({
      runId: 'r-case-a',
      objective: 'progressive admission implementation',
      taskContract: {
        acceptance: [{
          acceptance: 'new feature is verified by test:new',
          evidencePlan: {
            class: 'hard',
            method: 'unit-test',
            commandRefs: ['test:new'],
            obligationId: 'unit-test',
          },
        }],
        allowedPaths: ['app.mjs'],
      },
    });
    assert.equal(started.runId, 'r-case-a');
    const nextTurn = await cp.next('r-case-a');
    assert.equal(nextTurn.action.type, 'implement');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test("Case B: verification command added during implementation binds at PROVE and passes", async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({
      runId: 'r-case-b',
      objective: 'progressive admission with late command',
      taskContract: {
        acceptance: [{
          acceptance: 'verified by test:added',
          evidencePlan: {
            class: 'hard',
            method: 'unit-test',
            commandRefs: ['test:added'],
            obligationId: 'unit-test',
          },
        }],
        allowedPaths: ['app.mjs', 'package.json'],
      },
    });

    const obligationsBefore = cp.stateStore.getRunObligations('r-case-b');
    const unitTestBefore = obligationsBefore.find((o) => o.obligationId === 'unit-test');
    assert.equal(unitTestBefore.allowedCommandRefs.includes('test:added'), false);

    // During implementation, add the test script to package.json
    await writeFile(path.join(fixture.projectRoot, 'package.json'), JSON.stringify({
      name: 'progressive-admission-fixture',
      version: '0.0.1',
      scripts: {
        lint: 'node -e "process.exit(0)"',
        'test:added': 'node -e "process.exit(0)"',
      },
    }));

    // Transition to EXECUTE then PROVE
    await cp.transition('r-case-b', 'EXECUTE');
    await cp.transition('r-case-b', 'PROVE');

    const obligationsAfter = cp.stateStore.getRunObligations('r-case-b');
    const unitTestAfter = obligationsAfter.find((o) => o.obligationId === 'unit-test');
    assert.equal(unitTestAfter.allowedCommandRefs.includes('test:added'), true);
    assert.equal(unitTestAfter.satisfiable, true);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test("Case C: verification command missing until PROVE is reported only when PROVE requires satisfaction", async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({
      runId: 'r-case-c',
      objective: 'progressive admission with never-added command',
      taskContract: {
        acceptance: [{
          acceptance: 'verified by test:never',
          evidencePlan: {
            class: 'hard',
            method: 'unit-test',
            commandRefs: ['test:never'],
            obligationId: 'unit-test',
          },
        }],
        allowedPaths: ['app.mjs'],
      },
    });

    // 1. EXECUTE can proceed normally
    const nextTurn = await cp.next('r-case-c');
    assert.equal(nextTurn.action.type, 'implement');

    // 2. Transitioning to EXECUTE succeeds
    await cp.transition('r-case-c', 'EXECUTE');

    // 3. Attempting to transition to PROVE without required verification command blocks the run
    await assert.rejects(
      async () => cp.transition('r-case-c', 'PROVE'),
      (error) => {
        assert.equal(error.code, 'unsupported-verification');
        return true;
      },
    );

    const blockedRun = cp.stateStore.getRun('r-case-c');
    assert.equal(blockedRun.status, 'blocked');
    assert.equal(blockedRun.blockedReason, 'unsupported-verification');

    // 4. next() returns blocked action
    const blockedNext = await cp.next('r-case-c');
    assert.equal(blockedNext.action.type, 'blocked');
    assert.equal(blockedNext.action.reason, 'unsupported-verification');
    assert.match(blockedNext.action.guidance, /existing discovered project command/);
    assert.match(blockedNext.action.guidance, /project owner/);
    assert.doesNotMatch(blockedNext.action.guidance, /package\.json|project manifest/);

    // 5. report() also returns blocked response
    const blockedReport = await cp.report('r-case-c', {
      summary: 'implemented',
      changedPaths: [],
    });
    assert.equal(blockedReport.status, 'blocked');
    assert.equal(blockedReport.blockedReason, 'unsupported-verification');

    // 6. Developer adds the missing test script to package.json
    await writeFile(path.join(fixture.projectRoot, 'package.json'), JSON.stringify({
      name: 'progressive-admission-fixture',
      version: '0.0.1',
      scripts: {
        lint: 'node -e "process.exit(0)"',
        test: 'node -e "process.exit(0)"',
        'test:never': 'node -e "process.exit(0)"',
      },
    }));

    // 7. JIT dynamic unblocking: next() rebinds and resumes the run automatically
    const resumedNext = await cp.next('r-case-c');
    assert.notEqual(resumedNext.action.type, 'blocked');
    const activeRun = cp.stateStore.getRun('r-case-c');
    assert.equal(activeRun.status, 'active');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('Case D: an invalid deferred explicit binding never widens to an unrelated command', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({
      runId: 'r-case-d',
      objective: 'preserve explicit verification authority',
      taskContract: {
        acceptance: [{
          acceptance: 'verified by test:never',
          evidencePlan: {
            class: 'hard',
            method: 'unit-test',
            commandRefs: ['test:never'],
            obligationId: 'unit-test',
          },
        }],
        allowedPaths: ['app.mjs', 'package.json'],
      },
    });

    await writeFile(path.join(fixture.projectRoot, 'package.json'), JSON.stringify({
      name: 'progressive-admission-fixture',
      version: '0.0.1',
      scripts: {
        lint: 'node -e "process.exit(0)"',
        test: 'node -e "process.exit(0)"',
      },
    }));
    await cp.transition('r-case-d', 'EXECUTE');
    await assert.rejects(() => cp.transition('r-case-d', 'PROVE'), /unsupported-verification/);

    const obligation = cp.stateStore.getRunObligation('r-case-d', 'unit-test');
    assert.deepEqual(obligation.allowedCommandRefs, []);
    assert.equal(obligation.satisfiable, false);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});
