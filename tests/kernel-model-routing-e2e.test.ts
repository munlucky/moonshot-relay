import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { dispatchKernelTurn } from '../src/host/kernel/turn-dispatcher.js';
import { createModelRegistry } from '../src/host/kernel/model-registry.js';
import { createClaudeAdapter } from '../src/host/kernel/adapters/claude.js';

const ENV = { MOON_RELAY_KERNEL_CLAUDE_FRONTIER: 'frontier-model', MOON_RELAY_KERNEL_CLAUDE_VALUE: 'value-model' };

// A Host that honestly reports the model it was told to use, and a fresh
// session id per role so reviewer independence is observable.
const adapterFor = (sessions: { role: string; model: string | null }[]) => createClaudeAdapter({
  launch: async ({ invocation }) => {
    assert.ok(invocation && typeof invocation === 'object' && 'subagent' in invocation && 'model' in invocation);
    assert.ok(typeof invocation.model === 'string' || invocation.model === null);
    const role = invocation.subagent === 'kernel-planner'
      ? 'planner'
      : invocation.subagent === 'kernel-reviewer'
        ? 'reviewer'
        : 'implementer';
    sessions.push({ role, model: invocation.model });
    return {
      resolvedModel: invocation.model,
      resolvedEffort: Reflect.get(invocation, 'effort'),
      observedModel: invocation.model,
      observedEffort: Reflect.get(invocation, 'effort'),
      sessionId: `${role}-session`,
      inputTokens: 1000,
      outputTokens: 200,
      wallClockMs: 5000,
    };
  },
});

type TestControlPlane = Awaited<ReturnType<typeof createKernelControlPlane>>;
const withProject = async <T>(scripts: Record<string, string>, fn: (cp: TestControlPlane, projectRoot: string) => T | Promise<T>) => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-route-e2e-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-route-e2e-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'x',
    scripts: {
      test: 'node -e "process.exit(0)"',
      lint: 'node -e "process.exit(0)"',
      ...scripts,
    },
  }));
  await writeFile(path.join(projectRoot, 'app.mjs'), 'export const v = 0;\n');
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    return await fn(cp, projectRoot);
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
};

test('a full routed turn implements on value coding and finishes on kernel evidence', async () => {
  await withProject({ 'test:ok': 'node -e "process.exit(0)"' }, async (cp, projectRoot) => {
    const sessions: { role: string; model: string | null }[] = [];
    await cp.startRun({
      runId: 'r-e2e',
      objective: 'routed loop',
      taskContract: {
        acceptance: [{ acceptance: 'works', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'default' } }],
      },
    });

    const turn = await dispatchKernelTurn({
      controlPlane: cp,
      runId: 'r-e2e',
      adapter: adapterFor(sessions),
      registry: createModelRegistry({ surface: 'claude', env: ENV }),
      actionContext: { executionMode: 'native-subagent', delegationRequested: true },
    });
    assert.equal(turn.dispatched, true);
    assert.ok(turn && typeof turn === 'object' && 'hostDirective' in turn);
    assert.ok(turn);
    assert.ok(turn.hostDirective);
    assert.ok(turn.hostDirective.modelRouteDecision);
    assert.ok(turn.hostDirective && turn.hostDirective.modelRouteDecision);
    assert.equal(turn.hostDirective.modelRouteDecision.modelClass, 'value_coding');
    assert.ok(turn.receipt && typeof turn.receipt === 'object' && 'enforcementStatus' in turn.receipt);
    assert.equal(turn.receipt.enforcementStatus, 'enforced');
    assert.deepEqual(sessions, [{ role: 'implementer', model: 'value-model' }]);

    // The value implementer does the work; the Kernel still executes the proof.
    await writeFile(path.join(projectRoot, 'app.mjs'), 'export const v = 1;\n');
    const report = await cp.report('r-e2e', {
      summary: 'implemented',
      capsuleId: turn.hostDirective.executionCapsule?.capsuleId,
      attemptId: turn.hostDirective.attemptId,
      changedPaths: ['app.mjs'],
      verifications: [{ obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: ['works'] }],
    });
    assert.ok(report && typeof report === 'object' && 'failures' in report);
    assert.ok(report);
    assert.equal(report.status, 'completed', JSON.stringify(report.failures));

    const status = await cp.status('r-e2e');
    assert.ok(status && typeof status === 'object' && 'measurement' in status);
    assert.ok(status);
    assert.equal(status.measurement.providerModelIdentity.status, 'observed');
    assert.deepEqual(status.measurement.providerModelIdentity.value.models, ['value-model']);
    assert.equal(status.measurement.modelRouting.status, 'observed');
    assert.equal(status.measurement.modelRouting.value.valueTurns, 1);
    assert.equal(status.measurement.modelRouting.status, 'observed');
    assert.equal(status.measurement.modelRouting.value.enforcedTurns, 1);
  });
});

test('a value model report triggers Kernel-owned proof for a mutating run', async () => {
  await withProject({ 'test:ok': 'node -e "process.exit(0)"' }, async (cp, projectRoot) => {
    await cp.startRun({ runId: 'r-claim', objective: 'unproven claim', taskContract: { acceptance: ['works'] } });
    await dispatchKernelTurn({
      controlPlane: cp,
      runId: 'r-claim',
      adapter: adapterFor([]),
      registry: createModelRegistry({ surface: 'claude', env: ENV }),
    });
    await writeFile(path.join(projectRoot, 'app.mjs'), 'export const v = 2;\n');
    // No verification requested: the model reports its result and the Kernel
    // independently runs the outstanding bound proof.
    const report = await cp.report('r-claim', { summary: 'trust me, it works', changedPaths: ['app.mjs'] });
    assert.ok(report && typeof report === 'object' && 'failures' in report);
    assert.ok(report);
    assert.equal(report.status, 'completed', JSON.stringify(report.failures));
    // With no explicit plan or caller hint, the canonical project `test`
    // command is the highest-authority proof selection.
    assert.ok(report && typeof report === 'object' && 'executed' in report);
    assert.ok(Array.isArray(report.executed));
    assert.deepEqual(report.executed.map((entry) => entry.commandRef), ['test']);
    const completedRun = await cp.getRun('r-claim');
    assert.ok(completedRun);
    assert.equal(completedRun.status, 'completed');
    assert.equal((await cp.assessCompletion('r-claim')).decision, 'accepted');
  });
});

test('planning, implementation, and review each land on the class their action requires', async () => {
  await withProject({}, async (cp) => {
    const sessions: { role: string; model: string | null }[] = [];
    const adapter = adapterFor(sessions);
    const registry = createModelRegistry({ surface: 'claude', env: ENV });
    await cp.startRun({ runId: 'r-mix', objective: 'auth boundary', taskContract: { surfaces: ['security_boundary'] } });

    for (const actionKind of ['plan', 'implement', 'review_engineering']) {
    await dispatchKernelTurn({
      controlPlane: cp,
      runId: 'r-mix',
      adapter,
      registry,
      actionContext: { actionKind, executionMode: 'native-subagent', delegationRequested: true },
    });
    }
    assert.deepEqual(sessions, [
      { role: 'planner', model: 'frontier-model' },
      { role: 'implementer', model: 'value-model' },
      { role: 'reviewer', model: 'frontier-model' },
    ]);

    const summary = cp.modelRoutingSummary('r-mix');
    assert.equal(summary.frontierTurns, 2);
    assert.equal(summary.valueTurns, 1);
    assert.equal(summary.independentReviewTurns, 1);
    assert.equal(summary.enforcedTurns, 3);
    assert.deepEqual(summary.resolvedModels.sort(), ['frontier_reasoning:frontier-model', 'value_coding:value-model']);
  });
});

test('a proof turn is executed by the Kernel and never handed to a model', async () => {
  await withProject({ 'test:ok': 'node -e "process.exit(0)"' }, async (cp) => {
    const sessions: { role: string; model: string | null }[] = [];
    await cp.startRun({ runId: 'r-proof', objective: 'proof stays kernel' });
    const turn = await dispatchKernelTurn({
      controlPlane: cp,
      runId: 'r-proof',
      adapter: adapterFor(sessions),
      registry: createModelRegistry({ surface: 'claude', env: ENV }),
      actionContext: { actionKind: 'prove' },
    });
    assert.equal(turn.dispatched, false);
    assert.deepEqual(sessions, []);
    const status = await cp.status('r-proof');
    assert.ok(status && typeof status === 'object' && 'measurement' in status);
    assert.ok(status);
    assert.equal(status.measurement.modelRouting.status, 'observed');
    assert.equal(status.measurement.modelRouting.value.kernelOnlyActions, 1);
    assert.equal(status.measurement.providerModelIdentity.status, 'unavailable');
  });
});
