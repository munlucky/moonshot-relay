import { assertTestArray, assertTestNumber, assertTestPresent, assertTestRecord, assertTestString } from './helpers/assert-value.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { observeWorkspaceIdentity } from '../src/host/kernel/workspace/workspace-identity.js';
import { deriveRunChangedPaths } from '../src/kernel/run/workspace-change-set.js';
import { resolveTrustedCommand, executeTrustedProof, UntrustedCommandError, redactSecretLikeOutput } from '../src/host/kernel/proof/proof-executor.js';
import { planStatePath, buildNextPayload } from '../src/kernel/run/run-loop.js';
import { CODEX_MAIN_SESSION_POLICY } from '../src/host/kernel/codex-session-observer.js';

const setupProject = async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-host-loop-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await mkdir(path.join(projectRoot, '.moon-relay'), { recursive: true });
  await writeFile(path.join(projectRoot, '.moon-relay', 'track.yaml'), 'schemaVersion: 1\ntrack: kernel\nproduct: moon-relay-kernel\n');
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'host-loop-fixture',
    version: '0.0.1',
    scripts: { 'test:focus': 'node check.mjs' },
  }, null, 2));
  await writeFile(path.join(projectRoot, 'app.mjs'), `export const statusForInvalidPassword = () => 500;\n`);
  await writeFile(path.join(projectRoot, 'check.mjs'), [
    `import { statusForInvalidPassword } from './app.mjs';`,
    `if (statusForInvalidPassword() !== 401) { console.error('expected 401, got ' + statusForInvalidPassword()); process.exit(1); }`,
    `console.log('focused test passed');`,
  ].join('\n'));
  return projectRoot;
};

test('workspace identity observation reflects working tree changes', async () => {
  const projectRoot = await setupProject();
  try {
    const first = observeWorkspaceIdentity({ projectRoot });
    assert.match(first.identity, /^sha256:[a-f0-9]{64}$/);
    const second = observeWorkspaceIdentity({ projectRoot });
    assert.equal(second.identity, first.identity);

    await writeFile(path.join(projectRoot, 'app.mjs'), `export const statusForInvalidPassword = () => 401;\n`);
    const third = observeWorkspaceIdentity({ projectRoot });
    assert.notEqual(third.identity, first.identity);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('workspace identity changes when HEAD provenance changes but the tree does not', async () => {
  const projectRoot = await setupProject();
  try {
    for (const args of [
      ['config', 'user.email', 'kernel@example.invalid'],
      ['config', 'user.name', 'Kernel Test'],
      ['add', '.'],
      ['commit', '-m', 'baseline'],
    ]) {
      const result = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
    const before = observeWorkspaceIdentity({ projectRoot });
    assert.equal(before.headCommitSha, spawnSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).stdout.trim());
    const emptyCommit = spawnSync('git', ['commit', '--allow-empty', '-m', 'provenance-only'], { cwd: projectRoot, encoding: 'utf8' });
    assert.equal(emptyCommit.status, 0, emptyCommit.stderr || emptyCommit.stdout);
    const after = observeWorkspaceIdentity({ projectRoot });
    assert.notEqual(after.identity, before.identity);
    assert.notEqual(after.headCommitSha, before.headCommitSha);
    assert.equal(after.headCommitSha, spawnSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).stdout.trim());
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('proof executor only accepts manifest scripts and records honest execution facts', async () => {
  const projectRoot = await setupProject();
  try {
    assert.throws(() => resolveTrustedCommand({ projectRoot, commandRef: 'rm -rf /' }), UntrustedCommandError);
    assert.throws(() => resolveTrustedCommand({ projectRoot, commandRef: 'not-a-script' }), UntrustedCommandError);

    const trusted = resolveTrustedCommand({ projectRoot, commandRef: 'test:focus' });
    assert.equal(trusted.kind, 'manifest-script');
    assert.deepEqual(trusted.args, ['run', 'test:focus']);

    const failing = executeTrustedProof({ projectRoot, commandRef: 'test:focus', timeoutMs: 120000 });
    assert.equal(failing.status, 'failed');
    assert.notEqual(failing.exitCode, 0);
    assert.equal(failing.networkIsolation, 'none');
    assert.equal(failing.networkPolicy, 'inherited');
    assert.match(failing.outputDigest, /^sha256:[a-f0-9]{64}$/);
    assert.ok(assertTestPresent(failing.errorSummary).includes('expected 401'));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('secret-like output is redacted from error summaries', () => {
  const redacted = redactSecretLikeOutput('api_key=sk-abc123 token: "xyz" normal text');
  assert.ok(!redacted.includes('sk-abc123'));
  assert.ok(!redacted.includes('xyz'));
  assert.ok(redacted.includes('normal text'));
});

test('run loop plans state paths without exposing states to the model', () => {
  assert.deepEqual(planStatePath('FRAME', 'PROVE'), ['EXECUTE', 'PROVE']);
  assert.deepEqual(planStatePath('EXECUTE', 'PROVE'), ['PROVE']);
  assert.deepEqual(planStatePath('PROVE', 'PROVE'), []);
  const payload = buildNextPayload({ run: { runId: 'r', objective: 'o', acceptanceCriteria: [], status: 'active', state: 'FRAME' }, verifications: [], requiredObligations: ['default'] });
  assert.equal(payload.action.type, 'implement');
  assert.ok(!JSON.stringify(payload).includes('FRAME'));
});

test('run loop routes judgment-only obligations to independent review', () => {
  const payload = buildNextPayload({
    run: { runId: 'r-review', objective: 'secure change', acceptanceCriteria: [], status: 'active' },
    verifications: [{ obligationId: 'unit-test', status: 'passed' }],
    requiredObligations: ['unit-test', 'security-review'],
    obligations: [
      { obligationId: 'unit-test', evidenceClass: 'hard', allowedCommandRefs: ['test'] },
      { obligationId: 'security-review', evidenceClass: 'judgment', verificationMethod: 'structured-judgment' },
    ],
  });

  assert.equal(payload.action.type, 'review');
  assert.equal(payload.action.independentReviewRequired, true);
  assert.deepEqual(payload.action.outstandingObligations, ['security-review']);
});

test('blocker report preserves the original blocker after the owner binding is closed', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-blocker-report-home-'));
  const projectRoot = await setupProject();
  const runId = 'blocker-report-next';
  const sessionId = 'codex:blocker-report-session';
  const env = {
    ...process.env,
    MOON_RELAY_KERNEL_SESSION_ID: sessionId,
    MOON_RELAY_KERNEL_PROVIDER: 'codex',
    MOON_RELAY_KERNEL_RUN_ID: runId,
  };
  const controlPlane = await createKernelControlPlane({ runtimeHome, projectRoot, env, requireHostBinding: true });
  try {
    await controlPlane.ensureRun({
      runId,
      objective: 'preserve a typed blocker for the caller',
      taskContract: {
        acceptance: [{
          acceptance: 'the blocker remains visible to the caller',
          evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:focus'], obligationId: 'default' },
        }],
      },
    });
    const report = await controlPlane.report(runId, {
      summary: 'waiting for an external dependency',
      blocker: { reason: 'external-dependency', detail: 'provider is unavailable' },
    });
    assert.equal(assertTestPresent(report).status, 'blocked');
    assert.equal(assertTestRecord(assertTestPresent(report)).blockedReason, 'external-dependency');
    assert.equal(assertTestRecord(assertTestPresent(report)).blockedDetail, 'provider is unavailable');
    assert.equal(assertTestRecord(assertTestRecord(assertTestRecord(assertTestPresent(report)).next).action).type, 'blocked');
    assert.equal(assertTestRecord(assertTestRecord(assertTestRecord(assertTestPresent(report)).next).action).reason, 'external-dependency');
    assert.notEqual(assertTestRecord(assertTestRecord(assertTestPresent(report)).next).errorCode, 'host_binding_missing');
    const blockedRun = controlPlane.stateStore.getRun(runId);
    assert.equal(controlPlane.stateStore.getActiveOwnerBinding({ projectId: assertTestString(assertTestPresent(blockedRun).projectId), sessionId }), null);
  } finally {
    await controlPlane.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('run creation persists the already-observed Git HEAD as explicit source provenance', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-run-start-git-home-'));
  const projectRoot = await setupProject();
  try {
    for (const args of [
      ['config', 'user.email', 'kernel@example.invalid'],
      ['config', 'user.name', 'Kernel Test'],
      ['add', '.'],
      ['commit', '-m', 'baseline'],
    ]) {
      const result = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).stdout.trim();
    const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
    try {
      const run = await cp.startRun({
        runId: 'run-start-git-provenance',
        objective: 'preserve exact Git source provenance',
        taskContract: {
          acceptance: [{
            acceptance: 'run start Git provenance is persisted',
            evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:focus'], obligationId: 'default' },
          }],
        },
      });
      assert.equal(run.runStartGitCommitSha, head);
    } finally {
      await cp.close();
    }
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('host loop E2E: fail -> fix -> hard evidence -> accepted completion', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-host-loop-home-'));
  const projectRoot = await setupProject();
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    const run = await cp.startRun({
      runId: 'host-loop-1',
      objective: 'Fix invalid password status code',
      taskContract: {
        acceptance: [{
          acceptance: 'invalid password returns 401',
          evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:focus'], obligationId: 'default' },
        }],
      },
    });
    assert.match(assertTestString(run.runStartWorkspaceIdentity), /^sha256:[a-f0-9]{64}$/);
    assert.equal(run.currentWorkspaceIdentity, run.runStartWorkspaceIdentity);
    assert.equal(run.mutationRevision, 0);

    const first = await cp.next('host-loop-1');
    assert.equal(assertTestRecord(assertTestRecord(first).action).type, 'implement');

    // The implementation attempt is an actual workspace mutation, but the
    // focused proof still fails because the model wrote the wrong status.
    await writeFile(path.join(projectRoot, 'app.mjs'), `export const statusForInvalidPassword = () => 400;\n`);
    const failedReport = await cp.report('host-loop-1', {
      summary: 'attempted fix',
      changedPaths: ['app.mjs'],
      verifications: [{ obligationId: 'default', commandRef: 'test:focus', acceptanceCoverage: ['invalid password returns 401'] }],
    });
    assert.equal(assertTestPresent(failedReport).status, 'evidence-failed');
    assert.equal(assertTestRecord(assertTestPresent(failedReport)).finalization, null);
    assert.equal(assertTestRecord(assertTestRecord(assertTestRecord(assertTestPresent(failedReport)).next).action).type, 'fix');
    assert.deepEqual(
      assertTestRecord(assertTestPresent(failedReport)).next,
      await cp.next('host-loop-1'),
      'report continuation must use the same canonical preparation as an explicit next call',
    );
    assert.ok(assertTestString(assertTestRecord(assertTestArray(assertTestRecord(assertTestPresent(failedReport)).failures)[0]).errorSummary).includes('expected 401'));

    // Model actually fixes the bug and reports again.
    await writeFile(path.join(projectRoot, 'app.mjs'), `export const statusForInvalidPassword = () => 401;\n`);
    const passedReport = await cp.report('host-loop-1', {
      summary: 'fixed status code',
      changedPaths: ['app.mjs'],
      verifications: [{ obligationId: 'default', commandRef: 'test:focus', acceptanceCoverage: ['invalid password returns 401'] }],
    });

    assert.equal(assertTestRecord(assertTestPresent(passedReport)).mutationDetected, true);
    assert.equal(assertTestPresent(passedReport).status, 'completed');
    assert.equal(assertTestRecord(assertTestRecord(assertTestPresent(passedReport)).finalization).completionStatus, 'accepted');
    assert.equal(assertTestRecord(assertTestRecord(assertTestRecord(assertTestPresent(passedReport)).next).action).type, 'done');
    assert.deepEqual(
      assertTestRecord(assertTestPresent(passedReport)).next,
      await cp.next('host-loop-1'),
      'completed report continuation must remain canonical next output',
    );

    const finalRun = await cp.getRun('host-loop-1');
    assert.ok(assertTestPresent(finalRun).mutationRevision >= 1, 'mutation revision must reflect the actual source change');
    assert.equal(assertTestRecord(assertTestRecord(assertTestRecord(assertTestRecord(assertTestPresent(passedReport)).finalization).completionResult).hardEvidence).required, true);
    assert.ok(assertTestNumber(assertTestRecord(assertTestRecord(assertTestRecord(assertTestRecord(assertTestPresent(passedReport)).finalization).completionResult).hardEvidence).count) >= 1);
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('routed Codex worker E2E: worker receipt -> failed proof -> fix -> accepted completion', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-host-loop-cli-home-'));
  const projectRoot = await setupProject();
  const runId = 'host-loop-cli-1';
  const sessionId = 'codex:host-loop-cli-session';
  const env = {
    ...process.env,
    MOON_RELAY_KERNEL_SESSION_ID: sessionId,
    MOON_RELAY_KERNEL_PROVIDER: 'codex',
    MOON_RELAY_KERNEL_RUN_ID: runId,
  };
  const controlPlane = await createKernelControlPlane({ runtimeHome, projectRoot, env, requireHostBinding: true });
  try {
    await controlPlane.ensureRun({
      runId,
      objective: 'Fix invalid password status through a routed Codex worker',
      taskContract: {
        acceptance: [{
          acceptance: 'invalid password returns 401',
          evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:focus'], obligationId: 'default' },
        }],
      },
    });
    let workerNumber = 0;
    const cliLaunch = async ({ invocation }: { invocation: Record<string, unknown> }) => {
      workerNumber += 1;
      return {
        status: 'completed',
        resolvedModel: invocation.model,
        resolvedEffort: invocation.effort,
        observedModel: invocation.model,
        observedEffort: invocation.effort,
        observedSessionConfig: { model: invocation.model, effort: invocation.effort },
        sessionId: `codex:routed-worker-${workerNumber}`,
        outcome: {
          status: 'completed',
          summary: workerNumber === 1 ? 'worker attempted the fix' : 'worker fixed the status code',
          changedPaths: ['app.mjs'],
          risks: [],
          requestedVerifications: ['test:focus'],
          verifications: [{ obligationId: 'default', commandRef: 'test:focus', acceptanceCoverage: ['invalid password returns 401'] }],
          judgments: [],
          knowledgeObservations: [],
          blocker: null,
        },
      };
    };
    const parentSessionObserver = async ({ parentSessionId }: { parentSessionId: string | null }) => ({
      sessionId: parentSessionId,
      model: assertTestRecord(CODEX_MAIN_SESSION_POLICY).model,
      effort: assertTestRecord(CODEX_MAIN_SESSION_POLICY).effort,
    });
    await controlPlane.next(runId);
    // The routed worker's first implementation attempt is reflected in the
    // owner workspace before its report is ingested.
    await writeFile(path.join(projectRoot, 'app.mjs'), `export const statusForInvalidPassword = () => 400;\n`);
    const compatibilityInput4 = {
      status: 'completed',
      summary: 'worker attempted the fix',
      changedPaths: ['app.mjs'],
      verifications: [{ obligationId: 'default', commandRef: 'test:focus', acceptanceCoverage: ['invalid password returns 401'] }],
    };
    const first = await controlPlane.report(runId, compatibilityInput4);
    assert.equal(assertTestPresent(first).status, 'evidence-failed', JSON.stringify(first));
    assert.equal(assertTestRecord(assertTestArray(assertTestRecord(assertTestPresent(first)).failures)[0]).obligationId, 'default');

    const resumed = await controlPlane.ensureRun({ runId });
    assert.equal(resumed.status, 'resumed');
    await writeFile(path.join(projectRoot, 'app.mjs'), `export const statusForInvalidPassword = () => 401;\n`);
    const compatibilityInput5 = {
      status: 'completed',
      summary: 'worker fixed the status code',
      changedPaths: ['app.mjs'],
      verifications: [{ obligationId: 'default', commandRef: 'test:focus', acceptanceCoverage: ['invalid password returns 401'] }],
    };
    const completed = await controlPlane.report(runId, compatibilityInput5);
    assert.equal(assertTestPresent(completed).status, 'completed', JSON.stringify(completed));
    assert.equal(assertTestRecord(assertTestRecord(assertTestPresent(completed)).finalization).completionStatus, 'accepted');
    assert.equal(assertTestRecord(assertTestRecord(assertTestRecord(assertTestPresent(completed)).next).action).type, 'done');
  } finally {
    await controlPlane.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('host loop blocks on untrusted verification commands instead of executing them', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-host-loop-home2-'));
  const projectRoot = await setupProject();
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    await cp.startRun({ runId: 'host-loop-2', objective: 'Try untrusted command' });
    const res = await cp.report('host-loop-2', {
      summary: 'attempt',
      verifications: [{ commandRef: 'curl-something' }],
    });
    assert.equal(assertTestPresent(res).status, 'blocked');
    assert.equal(assertTestRecord(assertTestPresent(res)).blockedReason, 'unsafe-command');
    const nextPayload = await cp.next('host-loop-2');
    assert.equal(assertTestRecord(assertTestRecord(nextPayload).action).type, 'blocked');
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('caller-attested proof alone cannot complete a source-mutating run', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-host-loop-home3-'));
  const projectRoot = await setupProject();
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  const validDigest = `sha256:${'a'.repeat(64)}`;
  try {
    await cp.startRun({ runId: 'host-loop-3', objective: 'Mutating run with attested proof only' });

    // Source mutates after run start.
    await writeFile(path.join(projectRoot, 'app.mjs'), `export const statusForInvalidPassword = () => 401;\n`);
    cp.stateStore.observeWorkspaceIdentity('host-loop-3', observeWorkspaceIdentity({ projectRoot }).identity);

    await cp.transition('host-loop-3', 'EXECUTE');
    await cp.transition('host-loop-3', 'PROVE');
    await cp.recordProof('host-loop-3', {
      obligationId: 'default',
      status: 'passed',
      evidenceRef: 'evidence://attested/1',
      command: 'npm test',
      exitCode: 0,
      evidenceDigest: validDigest,
    });
    const finalization = await cp.finalizeRun('host-loop-3');
    assert.equal(assertTestRecord(finalization).completionStatus, 'blocked');
    assert.equal(assertTestRecord(assertTestRecord(assertTestRecord(finalization).completionResult).hardEvidence).required, true);
    assert.equal(assertTestRecord(assertTestRecord(assertTestRecord(finalization).completionResult).hardEvidence).count, 0);
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

const setupActualDiffFixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-actual-diff-'));
  const runtimeHome = path.join(root, 'runtime');
  const projectRoot = path.join(root, 'project');
  await mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'kernel-actual-diff-fixture',
    version: '1.0.0',
    scripts: { 'test:ok': 'node -e "process.exit(0)"' },
  }));
  for (const name of ['tracked.mjs', 'staged.mjs', 'deleted.mjs']) {
    await writeFile(path.join(projectRoot, 'src', name), 'export const value = 0;\n');
  }
  await writeFile(path.join(projectRoot, 'baseline.mjs'), 'export const value = 0;\n');
  const git = (args: string[]) => spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(git(['init']).status, 0);
  assert.equal(git(['add', '--all']).status, 0);
  assert.equal(git(['-c', 'user.name=kernel-test', '-c', 'user.email=kernel@example.invalid', 'commit', '-m', 'fixture', '--quiet']).status, 0);
  return { root, runtimeHome, projectRoot };
};

test('actual Git observation includes tracked, staged, deleted, and untracked paths', async () => {
  const fixture = await setupActualDiffFixture();
  try {
    const baseline = observeWorkspaceIdentity({ projectRoot: fixture.projectRoot });
    await writeFile(path.join(fixture.projectRoot, 'src', 'tracked.mjs'), 'export const value = 1;\n');
    await writeFile(path.join(fixture.projectRoot, 'src', 'staged.mjs'), 'export const value = 1;\n');
    assert.equal(spawnSync('git', ['add', 'src/staged.mjs'], { cwd: fixture.projectRoot, encoding: 'utf8' }).status, 0);
    await rm(path.join(fixture.projectRoot, 'src', 'deleted.mjs'));
    await writeFile(path.join(fixture.projectRoot, 'src', 'untracked.mjs'), 'export const value = 1;\n');
    const current = observeWorkspaceIdentity({ projectRoot: fixture.projectRoot });
    const derived = deriveRunChangedPaths({
      observation: current,
      baselineChangedPaths: baseline.changedPaths,
      baselineEntries: baseline.changeEntries,
    });
    assert.equal(derived.status, 'observed');
    assert.deepEqual(derived.actualChangedPaths, [
      'src/deleted.mjs',
      'src/staged.mjs',
      'src/tracked.mjs',
      'src/untracked.mjs',
    ]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('actual Git authority detects an index-only change when working content returns to baseline', async () => {
  const fixture = await setupActualDiffFixture();
  try {
    const baseline = observeWorkspaceIdentity({ projectRoot: fixture.projectRoot });
    await writeFile(path.join(fixture.projectRoot, 'src', 'tracked.mjs'), 'export const value = 1;\n');
    assert.equal(spawnSync('git', ['add', 'src/tracked.mjs'], { cwd: fixture.projectRoot, encoding: 'utf8' }).status, 0);
    await writeFile(path.join(fixture.projectRoot, 'src', 'tracked.mjs'), 'export const value = 0;\n');

    const current = observeWorkspaceIdentity({ projectRoot: fixture.projectRoot });
    const derived = deriveRunChangedPaths({
      observation: current,
      baselineChangedPaths: baseline.changedPaths,
      baselineEntries: baseline.changeEntries,
    });
    assert.equal(derived.status, 'observed');
    assert.deepEqual(derived.actualChangedPaths, ['src/tracked.mjs']);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('actual Git authority fails closed when the immutable Run baseline is unknown', async () => {
  const fixture = await setupActualDiffFixture();
  try {
    const observation = observeWorkspaceIdentity({ projectRoot: fixture.projectRoot });
    const derived = deriveRunChangedPaths({
      observation,
      baselineChangedPaths: observation.changedPaths,
      baselineEntries: observation.changeEntries,
      baselineStatus: 'unknown',
    });
    assert.equal(derived.status, 'unavailable');
    assert.equal(derived.reason, 'workspace-baseline-unknown');
    assert.equal(derived.actualChangedPaths, null);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('report rejects a changed workspace when changedPaths omits the actual delta', async () => {
  const fixture = await setupActualDiffFixture();
  const cp = await createKernelControlPlane({ runtimeHome: fixture.runtimeHome, projectRoot: fixture.projectRoot });
  try {
    await cp.startRun({
      runId: 'run-actual-diff',
      objective: 'Observe the actual workspace delta',
      taskContract: {
        behaviorChanging: true,
        allowedPaths: ['src/**'],
        acceptance: [{
          acceptance: 'the changed path is observed',
          evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'default' },
        }],
      },
    });
    await writeFile(path.join(fixture.projectRoot, 'src', 'tracked.mjs'), 'export const value = 2;\n');
    const rejected = await cp.report('run-actual-diff', { summary: 'forgot the path', changedPaths: [] });
    assert.equal(assertTestPresent(rejected).status, 'scope-rejected');
    assert.equal(assertTestRecord(assertTestArray(assertTestRecord(assertTestPresent(rejected)).failures)[0]).errorCode, 'unreported_workspace_change');
    assert.deepEqual(assertTestRecord(assertTestPresent(rejected)).actualChangedPaths, ['src/tracked.mjs']);
    assert.deepEqual(assertTestRecord(assertTestPresent(rejected)).reportedChangedPaths, []);
    assert.deepEqual(cp.stateStore.getVerifications('run-actual-diff'), []);
  } finally {
    await cp.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('Git owner-direct report derives changed paths when the caller omits the claim', async () => {
  const fixture = await setupActualDiffFixture();
  const cp = await createKernelControlPlane({ runtimeHome: fixture.runtimeHome, projectRoot: fixture.projectRoot });
  try {
    await cp.startRun({
      runId: 'run-owner-derived-diff',
      objective: 'Derive the owner workspace delta',
      taskContract: {
        behaviorChanging: true,
        allowedPaths: ['src/**'],
        acceptance: [{
          acceptance: 'the changed path is derived from Git',
          evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'default' },
        }],
      },
    });
    await writeFile(path.join(fixture.projectRoot, 'src', 'tracked.mjs'), 'export const value = 3;\n');
    const reported = await cp.report('run-owner-derived-diff', { summary: 'owner finished the scoped edit' });
    assert.deepEqual(assertTestRecord(assertTestPresent(reported)).actualChangedPaths, ['src/tracked.mjs']);
    assert.deepEqual(assertTestRecord(assertTestPresent(reported)).reportedChangedPaths, []);
    assert.notEqual(assertTestPresent(reported).status, 'scope-rejected');
  } finally {
    await cp.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('delivery materialization recovery re-derives the immutable Run delta after the report baseline advanced', async () => {
  const fixture = await setupActualDiffFixture();
  const cp = await createKernelControlPlane({ runtimeHome: fixture.runtimeHome, projectRoot: fixture.projectRoot });
  const runId = 'run-materialized-report-recovery';
  try {
    await cp.startRun({
      runId,
      objective: 'Recover tracked delivery materialization after proof',
      taskContract: {
        behaviorChanging: true,
        allowedPaths: ['src/**', 'public/**'],
        acceptance: [{
          acceptance: 'the materialized delivery is included in authoritative provenance',
          evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'default' },
        }],
      },
    });

    await writeFile(path.join(fixture.projectRoot, 'src', 'tracked.mjs'), 'export const value = 7;\n');
    await mkdir(path.join(fixture.projectRoot, 'public'), { recursive: true });
    await writeFile(path.join(fixture.projectRoot, 'public', 'rss.xml'), '<rss>materialized</rss>\n');

    const current = observeWorkspaceIdentity({ projectRoot: fixture.projectRoot });
    const beforeRecovery = cp.stateStore.getRun(runId);
    assert.ok(beforeRecovery);
    cp.stateStore.observeWorkspaceIdentity(runId, current.identity, {
      provenance: {
        workspaceId: beforeRecovery.workspaceId,
        baseSourceIdentity: beforeRecovery.sourceIdentity,
        changedPaths: ['src/tracked.mjs'],
        mutationDigest: current.identity,
      },
    });
    cp.stateStore.updateRunWorkspaceBaseline(runId, {
      changedPaths: current.changedPaths || [],
      entries: current.changeEntries || [],
    });
    cp.stateStore.markRunBlocked(
      runId,
      'delivery_materialization_recovery_required',
      'verification-or-environment',
    );

    const recovered = await cp.report(runId, {
      summary: 'recover the already-materialized tracked delivery',
      changedPaths: ['public/rss.xml', 'src/tracked.mjs'],
    });

    assert.notEqual(assertTestPresent(recovered).status, 'scope-rejected', JSON.stringify(recovered));
    assert.deepEqual(
      assertTestArray(assertTestRecord(assertTestPresent(recovered)).actualChangedPaths),
      ['public/rss.xml', 'src/tracked.mjs'],
    );
    assert.deepEqual(
      cp.stateStore.getMutationProvenance(runId)?.changedPaths,
      ['public/rss.xml', 'src/tracked.mjs'],
    );
  } finally {
    await cp.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('non-Git owner report fails closed when changedPaths is omitted', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-non-git-report-'));
  const runtimeHome = path.join(root, 'runtime');
  const projectRoot = path.join(root, 'project');
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'kernel-non-git-report-fixture',
    version: '1.0.0',
    scripts: { 'test:ok': 'node -e "process.exit(0)"' },
  }));
  await writeFile(path.join(projectRoot, 'app.mjs'), 'export const value = 0;\n');
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    await cp.startRun({
      runId: 'run-non-git-omission',
      objective: 'Require an explicit non-Git change claim',
      taskContract: {
        behaviorChanging: true,
        allowedPaths: ['app.mjs'],
        acceptance: [{
          acceptance: 'the caller identifies the changed path',
          evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'default' },
        }],
      },
    });
    await writeFile(path.join(projectRoot, 'app.mjs'), 'export const value = 1;\n');
    const rejected = await cp.report('run-non-git-omission', { summary: 'edited without an explicit path claim' });
    assert.equal(assertTestPresent(rejected).status, 'scope-rejected');
    assert.equal(
      assertTestRecord(assertTestArray(assertTestRecord(assertTestPresent(rejected)).failures)[0]).errorCode,
      'workspace_observation_unavailable',
    );
    assert.deepEqual(assertTestRecord(assertTestPresent(rejected)).reportedChangedPaths, []);
  } finally {
    await cp.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('blocker reports cannot hide an actual change outside the issued capsule scope', async () => {
  const fixture = await setupActualDiffFixture();
  const cp = await createKernelControlPlane({ runtimeHome: fixture.runtimeHome, projectRoot: fixture.projectRoot });
  try {
    await cp.startRun({
      runId: 'run-blocker-actual-scope',
      objective: 'Keep blocker scope fail closed',
      taskContract: {
        behaviorChanging: true,
        allowedPaths: ['src/**'],
        acceptance: [{
          acceptance: 'the scoped change is reviewed',
          evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'default' },
        }],
      },
    });
    await writeFile(path.join(fixture.projectRoot, 'baseline.mjs'), 'export const value = 1;\n');
    const rejected = await cp.report('run-blocker-actual-scope', {
      summary: 'the workspace is blocked',
      changedPaths: ['baseline.mjs'],
      blocker: { reason: 'external-dependency', detail: 'dependency is unavailable' },
    });
    assert.equal(assertTestPresent(rejected).status, 'scope-rejected');
    assert.match(assertTestString(assertTestRecord(assertTestArray(assertTestRecord(assertTestPresent(rejected)).failures)[0]).errorSummary), /outside the allowed paths/);
    assert.equal(assertTestPresent(cp.stateStore.getRun('run-blocker-actual-scope')).status, 'active');
  } finally {
    await cp.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

type TestControlPlane = Awaited<ReturnType<typeof import('../src/host/kernel/control-plane-runtime.js').createKernelControlPlane>>;
type TestStateStore = Awaited<ReturnType<typeof import('../src/kernel/state-store.js').openKernelStateStore>>;
