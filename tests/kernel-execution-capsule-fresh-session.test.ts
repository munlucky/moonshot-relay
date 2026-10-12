import { decideTestModelRoute } from './helpers/kernel-host-test-api.js';
// K1 §6.9-6/7: a capsule must be reproducible from SQLite alone (so a fresh
// process hands out the same bounded context), and must go stale the moment the
// workspace it describes moves.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { openKernelStateStore } from '../src/kernel/state-store.js';
import { capsuleStaleness } from '../src/kernel/run/execution-capsule.js';
import { hashSessionId } from '../src/contracts/model-execution.js';
import { observeWorkspaceIdentity } from '../src/host/kernel/workspace/workspace-identity.js';

const setup = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-capfs-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-capfs-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'capfs-fixture', version: '0.0.1', scripts: { 'test:ok': 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' },
  }, null, 2));
  await mkdir(path.join(projectRoot, 'src', 'auth'), { recursive: true });
  await writeFile(path.join(projectRoot, 'src', 'auth', 'service.mjs'), 'export const v = 0;\n');
  spawnSync('git', ['add', '--all'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'fixture', '--quiet'], { cwd: projectRoot, encoding: 'utf8' });
  return { runtimeHome, projectRoot };
};

const cleanup = async ({ runtimeHome, projectRoot }: { runtimeHome: string; projectRoot: string }) => {
  await rm(runtimeHome, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
};

const CONTRACT = {
  acceptance: [{
    acceptance: 'works',
    evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'default' },
  }],
  constraints: ['keep the shape'],
  allowedPaths: ['src/auth/**'],
};

test('K1-6: a fresh process rebuilds the same capsule from the same SQLite state', async () => {
  const fixture = await setup();
  let firstCapsule;
  const first = await createKernelControlPlane(fixture);
  try {
    await first.startRun({ runId: 'r-fresh', objective: 'Validate token expiry', taskContract: CONTRACT });
    firstCapsule = await first.buildCapsule('r-fresh');
  } finally {
    await first.close();
  }

  // A completely separate control plane, as the next CLI invocation would be.
  const second = await createKernelControlPlane(fixture);
  try {
    const rebuilt = await second.buildCapsule('r-fresh');
    assert.equal(rebuilt.capsuleId, firstCapsule.capsuleId, 'the same state must produce the same capsule identity');
    assert.equal(rebuilt.provenance.capsuleDigest, firstCapsule.provenance.capsuleDigest);

    // And a fresh worker can start from the capsule alone: objective, scope,
    // constraints, and the commands that prove the work are all present.
    assert.equal(rebuilt.objective, 'Validate token expiry');
    assert.ok(rebuilt && typeof rebuilt === 'object' && 'workUnit' in rebuilt);
    assert.deepEqual(rebuilt.workUnit.allowedPaths, ['src/auth/**']);
    assert.ok(rebuilt && typeof rebuilt === 'object' && 'constraints' in rebuilt);
    assert.deepEqual(rebuilt.constraints, ['keep the shape']);
    assert.ok(rebuilt && typeof rebuilt === 'object' && 'verification' in rebuilt);
    assert.ok(rebuilt.verification.obligations.some((entry) => entry.allowedCommandRefs.length > 0));
  } finally {
    await second.close();
    await cleanup(fixture);
  }
});

test('K1-7: a capsule built before a workspace change is stale afterwards', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({ runId: 'r-stale-cap', objective: 'x', taskContract: CONTRACT });
    const capsule = await cp.buildCapsule('r-stale-cap');
    assert.equal(capsuleStaleness({ capsule, run: await cp.getRun('r-stale-cap') }).stale, false);

    // The workspace moves; record the new identity without triggering the
    // final report's automatic proof planner.
    await writeFile(path.join(fixture.projectRoot, 'src', 'auth', 'service.mjs'), 'export const v = 1;\n');
    const movedIdentity = observeWorkspaceIdentity({ projectRoot: fixture.projectRoot }).identity;
    cp.stateStore.observeWorkspaceIdentity('r-stale-cap', movedIdentity, {
      provenance: {
        changedPaths: ['src/auth/service.mjs'],
        mutationDigest: movedIdentity,
      },
    });

    const run = await cp.getRun('r-stale-cap');
    const staleness = capsuleStaleness({ capsule, run });
    assert.equal(staleness.stale, true);
    assert.ok(staleness.reasons.includes('capsule-stale-mutation-revision'));

    // Re-submitting against the old capsule is refused rather than accepted.
    const rejected = await cp.report('r-stale-cap', {
      summary: 'reusing the old capsule',
      capsuleId: capsule.capsuleId,
      changedPaths: ['src/auth/service.mjs'],
      verifications: [{ obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: ['works'] }],
    });
    assert.ok(rejected && typeof rejected === 'object' && 'status' in rejected);
    assert.equal(rejected.status, 'scope-rejected');
    assert.ok(rejected && typeof rejected === 'object' && 'failures' in rejected);
    assert.ok(rejected.failures !== null && rejected.failures !== undefined);
    assert.ok(typeof rejected.failures[0].errorSummary === 'string');
    assert.match(rejected.failures[0].errorSummary, /no longer describes this run/);

    // A capsule rebuilt at the current state is accepted.
    const refreshed = await cp.buildCapsule('r-stale-cap');
    assert.notEqual(refreshed.capsuleId, capsule.capsuleId);
    const accepted = await cp.report('r-stale-cap', {
      summary: 'current capsule',
      capsuleId: refreshed.capsuleId,
      changedPaths: ['src/auth/service.mjs'],
      verifications: [{ obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: ['works'] }],
    });
    assert.ok(accepted && typeof accepted === 'object' && 'status' in accepted);
    assert.equal(accepted.status, 'completed');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K1: a capsule the Kernel never issued cannot be claimed', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({ runId: 'r-invent', objective: 'x', taskContract: CONTRACT });
    const rejected = await cp.report('r-invent', { summary: 'x', capsuleId: `capsule-${'a'.repeat(24)}` });
    assert.ok(rejected && typeof rejected === 'object' && 'status' in rejected);
    assert.equal(rejected.status, 'scope-rejected');
    assert.ok(rejected && typeof rejected === 'object' && 'failures' in rejected);
    assert.ok(rejected.failures !== null && rejected.failures !== undefined);
    assert.ok(typeof rejected.failures[0].errorSummary === 'string');
    assert.match(rejected.failures[0].errorSummary, /was not issued for this run/);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K1: the capsule digest is recorded on the usage receipt of the turn that ran it', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({ runId: 'r-receipt', objective: 'x', taskContract: CONTRACT });
    const capsule = await cp.buildCapsule('r-receipt');
    const decision = await decideTestModelRoute(cp, 'r-receipt', { actionKind: 'implement', obligationId: 'default' });
    await cp.recordModelUsage('r-receipt', {
      decisionId: decision.decisionId,
      runId: 'r-receipt',
      hostSurface: 'claude',
      actorSessionId: hashSessionId('worker'),
      resolvedModel: 'configured-model',
      enforcementStatus: 'enforced',
      resultStatus: 'completed',
      capsuleId: capsule.capsuleId,
      capsuleDigest: capsule.provenance.capsuleDigest,
    });

    const store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
    try {
      const [receipt] = store.listModelUsageReceipts('r-receipt');
      assert.equal(receipt.capsuleId, capsule.capsuleId);
      assert.equal(receipt.capsuleDigest, capsule.provenance.capsuleDigest);
      // The lineage resolves back to the stored capsule.
      const observedValue5 = store.getExecutionCapsule(receipt.capsuleId, { runId: 'r-receipt' });
    assert.ok(observedValue5);
    assert.ok(observedValue5.provenance && typeof observedValue5.provenance === 'object');
    assert.ok(observedValue5.provenance && typeof observedValue5.provenance === 'object' && 'capsuleDigest' in observedValue5.provenance);
    assert.equal(observedValue5.provenance.capsuleDigest, receipt.capsuleDigest);
    } finally {
      store.close();
    }
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

type KernelControlPlane = Awaited<ReturnType<typeof createKernelControlPlane>>;
