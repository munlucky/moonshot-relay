import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { buildAgentRecovery, type RecoveryObservation } from '../src/kernel/run/agent-recovery.js';
import { diagnoseKernelRecovery } from '../src/application/kernel-cli/recovery.js';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { writeRunLocator, readRunLocator, readRunRecoveryState, reconcileOrphanRunLocators } from '../src/kernel/run/run-locator.js';
import { runKernelCliApplication } from '../src/application/kernel-cli/main.js';

const observation: RecoveryObservation = {
  projectRoot: '/project', runtimeHome: '/runtime', runId: 'run', discoveryStatus: 'resolved',
  workspaceIdentity: 'snapshot', workspaceStatus: 'known', changedPaths: ['app.mjs'],
  run: { projectId: 'p', worktreeId: 'w', ownerBindingId: 'b', status: 'active', mutationRevision: 1 },
  step: { stepId: 's', allowedPaths: ['app.mjs'], forbiddenPaths: ['secret/**'] },
  sessionId: 'owner', ownerSessionId: 'owner', ownerBindingActive: true, worktreeLeaseOwned: true,
};
test('unknown errors enter the same scoped repair loop without fabricated evidence', () => {
  const result = buildAgentRecovery({ observation, failure: { code: 'previously-unseen-device-failure' } });
  assert.equal(result.mode, 'repair');
  assert.deepEqual(result.allowedPaths, ['app.mjs']);
  assert.equal(result.validation.agentDiagnosisIsProof, false);
  assert.deepEqual(result.commands.resume.args.slice(0, 2), ['next', 'run']);
  assert.equal(result.observed.authority.forbiddenPaths[0], 'secret/**');
  assert.equal(buildAgentRecovery({ observation: { ...observation, run: { ...observation.run, mutationRevision: 0 } } }).observed.authority.mutationRevision, 0);
});
test('unknown authority, foreign writers and safety rejections stay inspect-only', () => {
  for (const input of [
    { ...observation, ownerSessionId: 'other' },
    { ...observation, ownerBindingActive: false },
    { ...observation, worktreeLeaseOwned: false },
    { ...observation, workspaceStatus: 'unknown' },
    { ...observation, observationErrors: ['runtime-state-unreadable'] },
  ]) {
    const result = buildAgentRecovery({ observation: input });
    assert.equal(result.mode, 'inspect'); assert.deepEqual(result.allowedPaths, []);
  }
  assert.equal(buildAgentRecovery({ observation, failure: { recoverable: false } }).mode, 'inspect');
});
test('unchanged retries stop; real workspace or authority changes require a fresh capsule', () => {
  let result = buildAgentRecovery({ observation });
  for (let i = 0; i < 3; i++) result = buildAgentRecovery({ observation, previous: result });
  assert.equal(result.mode, 'escalate');
  const repaired = buildAgentRecovery({ observation: { ...observation, workspaceIdentity: 'repaired' }, previous: result });
  assert.equal(repaired.mode, 'repair'); assert.equal(repaired.unchangedAttempts, 0);
  assert.notEqual(repaired.fingerprint, result.fingerprint);
  const revised = buildAgentRecovery({ observation: { ...observation, step: { stepId: 'new', allowedPaths: ['other.mjs'] } }, previous: repaired });
  assert.notEqual(revised.validation.authorityDigest, repaired.validation.authorityDigest);
});

const fixture = async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-agent-recovery-project-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-agent-recovery-runtime-'));
  spawnSync('git', ['init', '-b', 'main'], { cwd: projectRoot });
  await mkdir(path.join(projectRoot, '.moon-relay'), { recursive: true });
  await writeFile(path.join(projectRoot, '.moon-relay/track.yaml'), 'track: kernel\nproduct: moon-relay-kernel\n');
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'recovery-fixture', scripts: { test: 'node --check app.mjs', lint: 'node --check app.mjs' } }));
  await writeFile(path.join(projectRoot, 'app.mjs'), 'export const value = 1;\n');
  return { projectRoot, runtimeHome };
};
const cleanup = async (f: Awaited<ReturnType<typeof fixture>>) => {
  await rm(f.projectRoot, { recursive: true, force: true });
  await rm(f.runtimeHome, { recursive: true, force: true });
};

test('derived references reconcile against durable authority, preserve live Runs and continue idempotently', async () => {
  const f = await fixture();
  const cp = await createKernelControlPlane({ ...f });
  try {
    await cp.ensureRun({ runId: 'live', taskContract: { objective: 'repair fixture', allowedPaths: ['app.mjs'], acceptance: ['works'] } });
    await writeRunLocator({ run: { runId: 'orphan', status: 'active' }, ...f });
    const result = reconcileOrphanRunLocators({ ...f });
    assert.deepEqual(result.quarantined, ['orphan']);
    assert.equal(readRunLocator({ runtimeHome: f.runtimeHome, runId: 'orphan' }), null);
    assert.ok(readRunLocator({ runtimeHome: f.runtimeHome, runId: 'live' }));
    assert.deepEqual(reconcileOrphanRunLocators({ ...f }).quarantined, []);
    const ready = readRunRecoveryState({ runtimeHome: f.runtimeHome, runId: 'live' });
    assert.ok(ready?.step, 'read-only diagnostics select native ready work');
    assert.deepEqual(ready.step.allowedPaths, ['app.mjs']);
    assert.equal(ready.run.mutationRevision, 0);
    const diagnosed = diagnoseKernelRecovery({ ...f, runId: 'live' });
    assert.equal(diagnosed.recovery.mode, 'inspect', 'no current owner identity cannot grant repair');
    assert.equal(diagnosed.recovery.observed.authority.runId, 'live');
    const resumed = await cp.next('live');
    assert.ok('action' in resumed && resumed.action?.type === 'implement');
  } finally { await cp.close(); await cleanup(f); }
});

test('missing runtime never permits locator cleanup or creates a replacement DB', async () => {
  const f = await fixture();
  try {
    await writeRunLocator({ run: { runId: 'missing' }, ...f });
    const result = diagnoseKernelRecovery({ ...f, runId: 'missing', reconcile: true });
    assert.deepEqual(result.reconciliation?.quarantined, []);
    assert.ok(readRunLocator({ runtimeHome: f.runtimeHome, runId: 'missing' }));
    assert.equal(existsSync(path.join(f.runtimeHome, 'state/runtime-state.sqlite')), false);
    assert.deepEqual(result.recovery.allowedPaths, []);
  } finally { await cleanup(f); }
});

test('failed owner initialization quarantines its published locator without altering prior history', async () => {
  const f = await fixture();
  const cp = await createKernelControlPlane({ ...f, env: { MOON_RELAY_KERNEL_SESSION_ID: 'codex:recovery-owner', MOON_RELAY_KERNEL_PROVIDER: 'codex' } });
  const original = cp.stateStore.createSessionBinding;
  try {
    cp.stateStore.createSessionBinding = () => { throw Object.assign(new Error('injected-host-condition'), { code: 'injected-host-condition' }); };
    await assert.rejects(cp.ensureRun({ runId: 'failed-bootstrap', taskContract: { objective: 'bootstrap', allowedPaths: ['app.mjs'], acceptance: ['works'] } }), /injected-host-condition/);
    assert.equal(cp.stateStore.getRun('failed-bootstrap'), null);
    assert.equal(readRunLocator({ runtimeHome: f.runtimeHome, runId: 'failed-bootstrap' }), null);
    cp.stateStore.createSessionBinding = original;
    const repaired = await cp.ensureRun({ runId: 'repaired-bootstrap', taskContract: { objective: 'bootstrap repaired', allowedPaths: ['app.mjs'], acceptance: ['works'] } });
    assert.equal(repaired.status, 'created');
  } finally { cp.stateStore.createSessionBinding = original; await cp.close(); await cleanup(f); }
});

test('native CLI returns recovery for an unseen failure, agent repairs and resumes with fresh bound proof', async () => {
  const f = await fixture();
  const cli = async (args: string[]) => {
    let stdout = '', stderr = '';
    const result = await runKernelCliApplication(args, { cwd: f.projectRoot, env: { MOON_RELAY_KERNEL_HOME: f.runtimeHome },
      managedRuntimeHome: f.runtimeHome, readJsonFile: async file => JSON.parse(await readFile(file, 'utf8')),
      emitOutput: value => { stdout += value; }, emitError: value => { stderr += value; } });
    return { ...result, payload: JSON.parse(stdout || stderr) };
  };
  try {
    const unseen = await cli(['unknown-command', '--json']);
    assert.equal(unseen.exitCode, 1); assert.equal(unseen.payload.recovery.kind, 'agent-recovery');
    const bad = { objective: 'recovery E2E', allowedPaths: ['app.mjs'], acceptance: ['valid JS'],
      steps: [{ stepId: 's', objective: 'repair', allowedPaths: ['app.mjs'], acceptanceIds: ['wrong'] }] };
    const contract = path.join(os.tmpdir(), `kernel-recovery-contract-${path.basename(f.projectRoot)}.json`);
    await writeFile(contract, JSON.stringify(bad));
    const rejected = await cli(['next', '--contract-json', contract, '--json']);
    assert.equal(rejected.exitCode, 1); assert.ok(rejected.payload.recovery.commands.inspect);
    await writeFile(contract, JSON.stringify({ ...bad, steps: [{ ...bad.steps[0], acceptanceIds: ['AC-1'] }] }));
    const resumed = await cli(['next', '--contract-json', contract, '--json']);
    assert.equal(resumed.payload.action.type, 'implement');
    const cp = await createKernelControlPlane({ ...f });
    try {
      await writeFile(path.join(f.projectRoot, 'app.mjs'), 'export const value = 2;\n');
      const report = await cp.report(resumed.payload.runId, { stepId: resumed.payload.stepId,
        summary: 'Repaired after unexpected bootstrap condition', changedPaths: ['app.mjs'],
        verifications: [{ obligationId: 'default', commandRef: 'test', acceptanceCoverage: ['AC-1'] }] });
      assert.ok(report); assert.equal(report.status, 'completed');
      const done = await cp.next(resumed.payload.runId);
      assert.ok('action' in done && done.action?.type === 'done');
    } finally { await cp.close(); }
    await rm(contract, { force: true });
  } finally { await cleanup(f); }
});
