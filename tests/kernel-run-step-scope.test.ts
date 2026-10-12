// K2-5: a step declares what it may touch. A report that changed something else
// is refused before any evidence runs — the scope belongs to the plan, not to
// the worker that noticed something else worth fixing.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { findScopeViolations } from '../src/kernel/run/capsule-selection.js';

const CONTRACT = {
  complex: true,
  riskTier: 'T2',
  acceptance: [
    { acceptance: 'auth rejects expired tokens', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'unit-test' } },
    { acceptance: 'the suite stays clean', evidencePlan: { class: 'hard', method: 'static-analysis', commandRefs: ['lint'], obligationId: 'static-analysis' } },
  ],
  steps: [
    {
      objective: 'Implement token expiry',
      allowedPaths: ['src/auth/**'],
      forbiddenPaths: ['src/billing/**'],
      acceptanceIds: ['AC-1'],
      obligationIds: ['unit-test'],
      expectedOutputs: ['token expiry implementation'],
    },
    {
      objective: 'Cover it',
      allowedPaths: ['tests/**'],
      acceptanceIds: ['AC-2'],
      obligationIds: ['static-analysis'],
      expectedOutputs: ['regression coverage'],
    },
  ],
};

const setup = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-scope-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-scope-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'scope-fixture', version: '0.0.1', scripts: { 'test:ok': 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' },
  }, null, 2));
  for (const relative of ['src/auth/service.mjs', 'src/billing/invoice.mjs', 'tests/auth.test.mjs']) {
    await mkdir(path.join(projectRoot, path.dirname(relative)), { recursive: true });
    await writeFile(path.join(projectRoot, relative), 'export const v = 0;\n');
  }
  spawnSync('git', ['add', '--all'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'fixture', '--quiet'], { cwd: projectRoot, encoding: 'utf8' });
  return { runtimeHome, projectRoot };
};

const cleanup = async ({ runtimeHome, projectRoot }: { runtimeHome: string; projectRoot: string }) => {
  await rm(runtimeHome, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
};

test('K2-5: a change outside the step scope is refused before evidence runs', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({ runId: 'r-stepscope', objective: 'Harden auth', taskContract: CONTRACT });
    const [first] = cp.getRunSteps('r-stepscope');
    await writeFile(path.join(fixture.projectRoot, 'src', 'auth', 'service.mjs'), 'export const v = 1;\n');

    const wandered = await cp.report('r-stepscope', {
      summary: 'fixed auth and tidied the tests while I was there',
      stepId: first.stepId,
      changedPaths: ['src/auth/service.mjs', 'tests/auth.test.mjs'],
      verifications: [{ obligationId: 'unit-test', commandRef: 'test:ok', acceptanceCoverage: ['AC-1'] }],
    });
    assert.ok(wandered);
    assert.equal(wandered.status, 'scope-rejected');
    assert.ok(wandered && typeof wandered === 'object' && 'executed' in wandered);
    assert.ok(Array.isArray(wandered.executed));
    assert.equal(wandered.executed.length, 0);
    assert.ok(wandered && typeof wandered === 'object' && 'failures' in wandered);
    assert.ok(wandered.failures?.[0].errorSummary);
    assert.match(wandered.failures[0].errorSummary, /outside the allowed paths of step/);
    // The step is untouched: a refused report is not an attempt at the work.
    assert.equal(cp.getRunSteps('r-stepscope')[0].state, 'ready');

    const forbidden = await cp.report('r-stepscope', {
      summary: 'touched billing',
      stepId: first.stepId,
      changedPaths: ['src/auth/service.mjs', 'src/billing/invoice.mjs'],
    });
    assert.ok(forbidden);
    assert.equal(forbidden.status, 'scope-rejected');
    assert.ok(forbidden && typeof forbidden === 'object' && 'failures' in forbidden);
    assert.ok(forbidden.failures?.[0].errorSummary);
    assert.match(forbidden.failures[0].errorSummary, /inside a forbidden path/);

    const inScope = await cp.report('r-stepscope', {
      summary: 'auth only',
      stepId: first.stepId,
      changedPaths: ['src/auth/service.mjs'],
      verifications: [{ obligationId: 'unit-test', commandRef: 'test:ok', acceptanceCoverage: ['AC-1'] }],
    });
    assert.ok(inScope && typeof inScope === 'object' && 'step' in inScope);
    assert.ok(inScope);
    assert.ok(inScope.step);
    assert.equal(inScope.step.state, 'passed');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K2: an undeclared scope is the whole workspace and cannot be violated', () => {
  assert.deepEqual(findScopeViolations({ changedPaths: ['anything.mjs'], allowedPaths: [] }), []);
  assert.deepEqual(findScopeViolations({ changedPaths: ['anything.mjs'], allowedPaths: ['**'] }), []);
  assert.deepEqual(
    findScopeViolations({ changedPaths: ['src/auth/a.mjs', 'src/other/b.mjs'], allowedPaths: ['src/auth/**'] }),
    [{ path: 'src/other/b.mjs', reason: 'outside-allowed-paths' }],
  );
  assert.deepEqual(
    findScopeViolations({ changedPaths: ['migrations/001.sql'], allowedPaths: ['**'], forbiddenPaths: ['migrations/**'] }),
    [{ path: 'migrations/001.sql', reason: 'forbidden-path' }],
  );
  // Windows-style separators normalize to the same scope decision.
  assert.deepEqual(findScopeViolations({ changedPaths: ['src\\auth\\a.mjs'], allowedPaths: ['src/auth/**'] }), []);
  assert.deepEqual(
    findScopeViolations({
      changedPaths: ['tests/kernel-completion-view.test.mjs'],
      allowedPaths: ['tests/kernel-*.test.mjs'],
    }),
    [],
    'embedded manifest-style globs are executable scope contracts',
  );
  assert.deepEqual(
    findScopeViolations({
      changedPaths: ['tests/completion-view.test.mjs'],
      allowedPaths: ['tests/kernel-*.test.mjs'],
    }),
    [{ path: 'tests/completion-view.test.mjs', reason: 'outside-allowed-paths' }],
  );
});
