import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';

const safeCleanup = async (...dirs) => {
  for (const dir of dirs) {
    if (!dir) continue;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(dir, { recursive: true, force: true });
        break;
      } catch (err) {
        if (err.code === 'EBUSY' && attempt < 4) {
          await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
          continue;
        }
        if (err.code !== 'EBUSY') throw err;
      }
    }
  }
};

const setupProject = async (name = 'recovery-e2e', { preExistingFiles = {} } = {}) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), `krn-${name}-proj-`));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), `krn-${name}-state-`));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.email', 'kernel@example.invalid'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.name', 'Kernel Recovery Test'], { cwd: projectRoot, encoding: 'utf8' });

  await mkdir(path.join(projectRoot, '.moon-relay'), { recursive: true });
  await writeFile(path.join(projectRoot, '.moon-relay', 'track.yaml'), 'schemaVersion: 1\ntrack: kernel\nproduct: moon-relay-kernel\n');
  await writeFile(path.join(projectRoot, '.moon-relay', 'project.identity.yaml'), `projectId: ${name}\n`);
  await writeFile(path.join(projectRoot, 'test-unit.js'), `
const fs = require('node:fs');
const path = require('node:path');
try {
  const target = path.join(__dirname, 'src', 'service.mjs');
  const content = fs.readFileSync(target, 'utf8');
  if (content.includes('service-ok')) {
    process.exit(0);
  }
  console.error('Target content did not match: ' + content);
} catch (err) {
  console.error('Failed to read target: ' + err.message);
}
process.exit(1);
`);
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name,
    version: '0.0.1',
    scripts: {
      'test:unit': 'node test-unit.js',
      'test:router': 'node -e "process.exit(0)"',
    },
  }, null, 2));
  spawnSync('git', ['add', '.'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: projectRoot, encoding: 'utf8' });

  // Add pre-existing dirty/untracked files if requested
  for (const [relPath, content] of Object.entries(preExistingFiles)) {
    const fullPath = path.join(projectRoot, relPath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  }

  return { projectRoot, runtimeHome, projectId: name };
};

test('Recovery E2E: verification failure marks step as failed/blocked and model recovers with fix', async () => {
  const fixture = await setupProject('verify-failure-recovery');
  const sessionId = 'codex:session-recovery';
  const runId = 'run-recovery-test';
  let cp = null;
  try {
    cp = await createKernelControlPlane({
      runtimeHome: fixture.runtimeHome,
      projectRoot: fixture.projectRoot,
      env: {
        MOON_RELAY_KERNEL_SESSION_ID: sessionId,
        MOON_RELAY_KERNEL_PROVIDER: 'codex',
        MOON_RELAY_KERNEL_RUN_ID: runId,
      },
    });

    const contract = {
      objective: 'Implement reliable service',
      taskClass: 'feature',
      allowedPaths: ['src/service.mjs'],
      acceptance: [
        { id: 'AC-1', statement: 'Service produces service-ok', evidencePlan: { class: 'hard', commandRefs: ['test:unit'] } },
      ],
      steps: [
        {
          stepId: 'step-1-service',
          objective: 'Implement service',
          allowedPaths: ['src/service.mjs'],
          acceptanceIds: ['AC-1'],
        },
      ],
    };

    await cp.ensureRun({ runId, objective: contract.objective, taskContract: contract });

    // Step 1: Model implements buggy code
    await mkdir(path.join(fixture.projectRoot, 'src'), { recursive: true });
    await writeFile(path.join(fixture.projectRoot, 'src', 'service.mjs'), 'export const service = "buggy";\n');

    const reportFail = await cp.report(runId, {
      stepId: 'step-1-service',
      summary: 'Buggy implementation',
      changedPaths: ['src/service.mjs'],
      verifications: [{ commandRef: 'test:unit' }],
    });

    // Verification must fail and step must not complete
    assert.equal(reportFail.status, 'evidence-failed');
    assert.equal(reportFail.workUnitStatus, 'blocked');
    assert.ok(reportFail.failures.length > 0);

    // Run-loop next action must direct fix/retry, NOT mark as done
    const nextAction = await cp.next(runId);
    assert.notEqual(nextAction.action.type, 'done');
    assert.ok(['fix', 'implement'].includes(nextAction.action.type));

    // Step 2: Model fixes the bug
    await writeFile(path.join(fixture.projectRoot, 'src', 'service.mjs'), 'export const service = "service-ok";\n');

    const reportFixed = await cp.report(runId, {
      stepId: 'step-1-service',
      summary: 'Fixed implementation',
      changedPaths: ['src/service.mjs'],
      verifications: [{ commandRef: 'test:unit' }],
    });

    // Step is now complete
    assert.equal(reportFixed.workUnitStatus, 'complete');
  } finally {
    if (cp) await cp.close().catch(() => {});
    await safeCleanup(fixture.projectRoot, fixture.runtimeHome);
  }
});

test('Recovery E2E: future-step mutation is fenced and rejected', async () => {
  const fixture = await setupProject('future-mutation-fencing');
  const sessionId = 'codex:session-fence';
  const runId = 'run-fence-test';
  let cp = null;
  try {
    cp = await createKernelControlPlane({
      runtimeHome: fixture.runtimeHome,
      projectRoot: fixture.projectRoot,
      env: {
        MOON_RELAY_KERNEL_SESSION_ID: sessionId,
        MOON_RELAY_KERNEL_PROVIDER: 'codex',
        MOON_RELAY_KERNEL_RUN_ID: runId,
      },
    });

    const contract = {
      objective: 'Two step partitioned feature',
      taskClass: 'feature',
      allowedPaths: ['src'],
      acceptance: [
        { id: 'AC-1', statement: 'Step 1 service implemented', evidencePlan: { class: 'hard', commandRefs: ['test:unit'] } },
        { id: 'AC-2', statement: 'Step 2 router implemented', evidencePlan: { class: 'hard', commandRefs: ['test:router'] } },
      ],
      steps: [
        {
          stepId: 'step-1-service',
          objective: 'Implement service',
          allowedPaths: ['src/service.mjs'],
          acceptanceIds: ['AC-1'],
        },
        {
          stepId: 'step-2-router',
          objective: 'Implement router',
          allowedPaths: ['src/router.mjs'],
          acceptanceIds: ['AC-2'],
        },
      ],
    };

    await cp.ensureRun({ runId, objective: contract.objective, taskContract: contract });

    // Step 1 work unit illegally touches step-2-router's file
    await mkdir(path.join(fixture.projectRoot, 'src'), { recursive: true });
    await writeFile(path.join(fixture.projectRoot, 'src', 'service.mjs'), 'export const service = "service-ok";\n');
    await writeFile(path.join(fixture.projectRoot, 'src', 'router.mjs'), 'export const router = "early";\n');

    const reportOutOfScope = await cp.report(runId, {
      stepId: 'step-1-service',
      summary: 'Report with out-of-scope mutation',
      changedPaths: ['src/service.mjs', 'src/router.mjs'],
      verifications: [{ commandRef: 'test:unit' }],
    });

    // Report must reject or record failure due to scope violation
    const hasScopeViolation = reportOutOfScope.status === 'evidence-rejected'
      || (reportOutOfScope.failures && reportOutOfScope.failures.some((f) => String(f.errorSummary || '').includes('outside the allowed paths') || String(f.errorSummary || '').includes('scope')));
    assert.ok(hasScopeViolation, 'Report must flag out-of-scope mutation for step-1');
  } finally {
    if (cp) await cp.close().catch(() => {});
    await safeCleanup(fixture.projectRoot, fixture.runtimeHome);
  }
});

test('Recovery E2E: pre-existing dirty workspace changes are distinguished and do not fail scope checks', async () => {
  // Pre-existing dirty file outside allowedPaths
  const preExistingFiles = {
    'scratch/dirty-notes.txt': 'Pre-existing notes before kernel started\n',
  };
  const fixture = await setupProject('dirty-baseline-isolation', { preExistingFiles });
  const sessionId = 'codex:session-dirty-baseline';
  const runId = 'run-dirty-baseline-test';
  let cp = null;
  try {
    cp = await createKernelControlPlane({
      runtimeHome: fixture.runtimeHome,
      projectRoot: fixture.projectRoot,
      env: {
        MOON_RELAY_KERNEL_SESSION_ID: sessionId,
        MOON_RELAY_KERNEL_PROVIDER: 'codex',
        MOON_RELAY_KERNEL_RUN_ID: runId,
      },
    });

    const contract = {
      objective: 'Implement service with pre-existing dirty workspace',
      taskClass: 'feature',
      allowedPaths: ['src/service.mjs'],
      acceptance: [
        { id: 'AC-1', statement: 'Service ok', evidencePlan: { class: 'hard', commandRefs: ['test:unit'] } },
      ],
      steps: [
        {
          stepId: 'step-1-service',
          objective: 'Implement service',
          allowedPaths: ['src/service.mjs'],
          acceptanceIds: ['AC-1'],
        },
      ],
    };

    await cp.ensureRun({ runId, objective: contract.objective, taskContract: contract });

    // Implement only the allowed path
    await mkdir(path.join(fixture.projectRoot, 'src'), { recursive: true });
    await writeFile(path.join(fixture.projectRoot, 'src', 'service.mjs'), 'export const service = "service-ok";\n');

    const report = await cp.report(runId, {
      stepId: 'step-1-service',
      summary: 'Implemented service',
      changedPaths: ['src/service.mjs'],
      verifications: [{ commandRef: 'test:unit' }],
    });

    // The pre-existing dirty-notes.txt must NOT cause a scope or authority failure
    assert.equal(report.workUnitStatus, 'complete');
    assert.ok(['in-progress', 'completed'].includes(report.status));
  } finally {
    if (cp) await cp.close().catch(() => {});
    await safeCleanup(fixture.projectRoot, fixture.runtimeHome);
  }
});

test('Recovery E2E: duplicate report resubmission returns cached idempotent result', async () => {
  const fixture = await setupProject('idempotent-report');
  const sessionId = 'codex:session-idempotent';
  const runId = 'run-idempotent-test';
  let cp = null;
  try {
    cp = await createKernelControlPlane({
      runtimeHome: fixture.runtimeHome,
      projectRoot: fixture.projectRoot,
      env: {
        MOON_RELAY_KERNEL_SESSION_ID: sessionId,
        MOON_RELAY_KERNEL_PROVIDER: 'codex',
        MOON_RELAY_KERNEL_RUN_ID: runId,
      },
    });

    const contract = {
      objective: 'Idempotency test',
      taskClass: 'feature',
      allowedPaths: ['src/service.mjs'],
      acceptance: [
        { id: 'AC-1', statement: 'Service ok', evidencePlan: { class: 'hard', commandRefs: ['test:unit'] } },
      ],
      steps: [
        {
          stepId: 'step-1-service',
          objective: 'Implement service',
          allowedPaths: ['src/service.mjs'],
          acceptanceIds: ['AC-1'],
        },
      ],
    };

    await cp.ensureRun({ runId, objective: contract.objective, taskContract: contract });

    await mkdir(path.join(fixture.projectRoot, 'src'), { recursive: true });
    await writeFile(path.join(fixture.projectRoot, 'src', 'service.mjs'), 'export const service = "service-ok";\n');

    const attempt = cp.beginAttempt(runId, { stepId: 'step-1-service' });
    const reportPayload = {
      attemptId: attempt.attemptId,
      stepId: 'step-1-service',
      summary: 'Implemented service',
      changedPaths: ['src/service.mjs'],
      verifications: [{ commandRef: 'test:unit' }],
    };

    // First submission
    const firstReport = await cp.report(runId, reportPayload);
    assert.equal(firstReport.workUnitStatus, 'complete');

    // Duplicate submission of exact same report
    const secondReport = await cp.report(runId, reportPayload);

    // Second report matches first report's key fields without re-executing or erroring
    assert.equal(secondReport.idempotentReplay, true);
    assert.equal(secondReport.workUnitStatus, firstReport.workUnitStatus);
    assert.equal(secondReport.attemptNumber, firstReport.attemptNumber);
    assert.equal(secondReport.status, firstReport.status);
  } finally {
    if (cp) await cp.close().catch(() => {});
    await safeCleanup(fixture.projectRoot, fixture.runtimeHome);
  }
});
