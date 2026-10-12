import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { scanRepositoryEvidence } from '../src/host/kernel/workspace/repository-observation.js';
import { classifyFailures } from '../src/kernel/proof/failure-classify.js';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';

test('repository scan finds manifests, test/build commands, and entrypoints without dumping the repo', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-scan-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'scan-fixture',
    main: 'index.mjs',
    scripts: { 'test:focus': 'node check.mjs', build: 'node build.mjs', dev: 'node dev.mjs' },
  }, null, 2));
  await writeFile(path.join(projectRoot, 'untracked.txt'), 'dirty\n');
  try {
    const scan = scanRepositoryEvidence({ projectRoot });
    assert.deepEqual(scan.manifests, ['package.json']);
    assert.ok(scan.testCommands.some((c) => c.commandRef === 'test:focus'));
    assert.ok(scan.buildCommands.some((c) => c.commandRef === 'build'));
    assert.ok(scan.entrypoints.includes('index.mjs'));
    assert.ok(scan.dirtyPaths.includes('untracked.txt'));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('failure classification partitions into task-blocking, pre-existing, and unrelated', () => {
  const result = classifyFailures({
    baselineFailures: [{ obligationId: 'legacy-test' }, { obligationId: 'flaky-infra' }],
    currentFailures: [
      { obligationId: 'auth-test', paths: ['src/auth.js'] },
      { obligationId: 'legacy-test' },
      { obligationId: 'new-ambient' },
    ],
    changedPaths: ['src/auth.js'],
  });
  assert.deepEqual(result.taskBlockingFailures.map((f) => f.obligationId), ['auth-test']);
  assert.deepEqual(result.preExistingFailures.map((f) => f.obligationId), ['legacy-test']);
  assert.deepEqual(result.unrelatedFailures.map((f) => f.obligationId), ['new-ambient']);
});

test('baseline capture records already-failing commands and report classifies against them', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-baseline-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-baseline-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'baseline-fixture',
    scripts: { 'test:legacy': 'node -e "process.exit(1)"' },
  }, null, 2));
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    await cp.startRun({ runId: 'r-baseline', objective: 'baseline' });
    const baseline = await cp.captureBaseline('r-baseline', { commandRefs: ['test:legacy'] });
    assert.equal(baseline.baselineFailures.length, 1);
    assert.equal(baseline.baselineFailures[0].commandRef, 'test:legacy');

    const run = await cp.getRun('r-baseline');
    assert.ok(run);
    assert.equal(run.baselineFailures.length, 1);

    // Re-running the same already-failing command is classified as pre-existing.
    const report = await cp.report('r-baseline', {
      summary: 'no fix to legacy',
      verifications: [{ obligationId: 'test:legacy', commandRef: 'test:legacy' }],
    });
    assert.ok(report && 'failureClassification' in report && report.failureClassification);
    assert.equal(report.status, 'evidence-failed');
    const classification = report.failureClassification;
    assert.ok(typeof classification === 'object');
    assert.ok('preExistingFailures' in classification && Array.isArray(classification.preExistingFailures));
    assert.ok('taskBlockingFailures' in classification && Array.isArray(classification.taskBlockingFailures));
    assert.equal(classification.preExistingFailures.length, 1);
    assert.equal(classification.taskBlockingFailures.length, 0);
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});
