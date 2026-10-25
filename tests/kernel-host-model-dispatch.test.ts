import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { buildExecutionContract, dispatchKernelTurn } from '../src/host/kernel/turn-dispatcher.js';
import { createModelRegistry } from '../src/host/kernel/model-registry.js';
import { createClaudeAdapter } from '../src/host/kernel/adapters/claude.js';
import { createCodexAdapter } from '../src/host/kernel/adapters/codex.js';
import { createFableAdapter } from '../src/host/kernel/adapters/fable.js';
import { CODEX_EXECUTION_POLICY } from '../src/host/kernel/codex-model-policy.js';

const registryFor = (surface: string, env: NodeJS.ProcessEnv) => createModelRegistry({ surface, env });
const stableParentObserver = async ({ parentSessionId }: { parentSessionId?: string | null }) => ({ sessionId: parentSessionId, model: null, effort: null });
const FRONTIER_ENV = { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'configured-frontier', MOON_RELAY_KERNEL_MODEL_VALUE: 'configured-value' };

const withRun = async (fn: (cp: KernelControlPlane, runId: string) => Promise<unknown>) => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-dispatch-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-dispatch-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' } }));
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    await cp.startRun({ runId: 'r-dispatch', objective: 'dispatch' });
    return await fn(cp, 'r-dispatch');
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
};

test('a Host that applies the requested model records an enforced receipt', async () => {
  await withRun(async (cp, runId) => {
    const adapter = createClaudeAdapter({
      launch: async ({ invocation }) => { assert.ok(invocation && typeof invocation === 'object'); assert.ok(invocation && typeof invocation === 'object' && 'model' in invocation && 'effort' in invocation);
      return ({
        resolvedModel: invocation.model,
        resolvedEffort: invocation.effort,
        observedSessionConfig: { model: invocation.model, effort: invocation.effort },
        sessionId: 'claude-session-1',
        inputTokens: 900,
        cachedInputTokens: 300,
        outputTokens: 120,
        wallClockMs: 1250,
      }); },
    });
    const result = await dispatchKernelTurn({ controlPlane: cp, runId, adapter, registry: registryFor('claude', FRONTIER_ENV), actionContext: { executionMode: 'native-subagent', delegationRequested: true } });
    assert.equal(result.dispatched, true);
    assert.ok(result && typeof result === 'object' && 'dispatch' in result);
    assert.ok(result.dispatch && typeof result.dispatch === 'object' && 'invocation' in result.dispatch);
    assert.ok(result.dispatch.invocation && typeof result.dispatch.invocation === 'object');
    assert.ok(result.dispatch.invocation && typeof result.dispatch.invocation === 'object' && 'subagent' in result.dispatch.invocation);
    assert.equal(result.dispatch.invocation.subagent, 'kernel-implementer');
    assert.ok(result && typeof result === 'object' && 'resolution' in result);
    assert.ok(result.resolution && typeof result.resolution === 'object' && 'model' in result.resolution);
    assert.equal(result.resolution.model, 'configured-value');
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'enforcementStatus' in result.receipt);
    assert.equal(result.receipt.enforcementStatus, 'enforced');
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'resolvedModel' in result.receipt);
    assert.equal(result.receipt.resolvedModel, 'configured-value');
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'inputTokens' in result.receipt);
    assert.equal(result.receipt.inputTokens, 900);
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'actorSessionId' in result.receipt);
    assert.ok(typeof result.receipt.actorSessionId === 'string');
    assert.match(result.receipt.actorSessionId, /^sha256:[a-f0-9]{64}$/);
    const usage = result.receipt as Record<string, unknown>;
    assert.equal(usage.provider, 'claude');
    assert.equal(usage.cachedInputTokens, 300);
    assert.equal(usage.outputTokens, 120);
    assert.equal(usage.wallClockMs, 1250);
    assert.equal(usage.runId, runId);
    assert.ok(typeof result.attemptId === 'string');
    assert.equal(usage.attemptId, result.attemptId);
    const attempt = cp.getAttemptById(runId, result.attemptId);
    assert.ok(attempt);
    assert.equal(attempt.usageReceiptId, usage.receiptId);
    const decision = cp.stateStore.getModelRouteDecision(String(usage.decisionId), { runId });
    assert.ok(decision);
    assert.equal(decision.runId, runId);
    assert.ok(decision.executionClass);
    assert.equal(cp.modelRoutingSummary(runId).enforcedTurns, 1);
  });
});

test('a Claude launcher without observed identity stays advisory instead of assuming requested equals actual', async () => {
  await withRun(async (cp, runId) => {
    const adapter = createClaudeAdapter({ launch: async ({ invocation }) => ({
      resolvedModel: invocation && typeof invocation === 'object' && 'model' in invocation ? invocation.model : null,
      resolvedEffort: invocation && typeof invocation === 'object' && 'effort' in invocation ? invocation.effort : null,
      sessionId: 'claude-session-unobserved',
    }) });
    const result = await dispatchKernelTurn({ controlPlane: cp, runId, adapter, registry: registryFor('claude', FRONTIER_ENV), actionContext: { executionMode: 'native-subagent', delegationRequested: true } });
    assert.ok(result.receipt && typeof result.receipt === 'object');
    const receipt = result.receipt as Record<string, unknown>;
    assert.equal(receipt.enforcementStatus, 'advisory');
    assert.equal(receipt.requestedModel, 'configured-value');
    assert.equal(receipt.resolvedModel, 'configured-value');
    assert.equal(receipt.observedModel, null);
    assert.equal(receipt.observedEffort, null);
  });
});

test('a Host that silently answers with a different model records a fallback', async () => {
  await withRun(async (cp, runId) => {
    const adapter = createClaudeAdapter({ launch: async () => ({ resolvedModel: 'some-other-model', sessionId: 's' }) });
    const result = await dispatchKernelTurn({ controlPlane: cp, runId, adapter, registry: registryFor('claude', FRONTIER_ENV), actionContext: { executionMode: 'native-subagent', delegationRequested: true } });
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'enforcementStatus' in result.receipt);
    assert.equal(result.receipt.enforcementStatus, 'fallback');
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'resolvedModel' in result.receipt);
    assert.equal(result.receipt.resolvedModel, 'some-other-model');
  });
});

test('an unconfigured model resolves to the installed Host default and stays advisory', async () => {
  await withRun(async (cp, runId) => {
    const adapter = createClaudeAdapter({ launch: async () => ({ resolvedModel: 'whatever-the-host-runs', sessionId: 's' }) });
    const result = await dispatchKernelTurn({ controlPlane: cp, runId, adapter, registry: registryFor('claude', {}), actionContext: { executionMode: 'native-subagent', delegationRequested: true } });
    assert.ok(result && typeof result === 'object' && 'resolution' in result);
    assert.ok(result.resolution && typeof result.resolution === 'object' && 'source' in result.resolution);
    assert.equal(result.resolution.source, 'host-default');
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'enforcementStatus' in result.receipt);
    assert.equal(result.receipt.enforcementStatus, 'advisory');
  });
});

test('a Host without model switching is recorded as unsupported, never as enforced', async () => {
  await withRun(async (cp, runId) => {
    const result = await dispatchKernelTurn({ controlPlane: cp, runId, adapter: createFableAdapter(), registry: registryFor('fable', FRONTIER_ENV) });
    assert.ok(result && typeof result === 'object' && 'hostDirective' in result);
    assert.ok(result.hostDirective !== null && result.hostDirective !== undefined);
    assert.equal(result.hostDirective.enforcementStrategy, 'unsupported');
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'enforcementStatus' in result.receipt);
    assert.equal(result.receipt.enforcementStatus, 'unsupported');
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'resolvedModel' in result.receipt);
    assert.equal(result.receipt.resolvedModel, null);
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'inputTokens' in result.receipt);
    assert.equal(result.receipt.inputTokens, null);
  });
});

test('a Host that cannot report tokens leaves them unavailable rather than zero', async () => {
  await withRun(async (cp, runId) => {
    const adapter = createCodexAdapter({ parentSessionObserver: stableParentObserver, launch: async ({ invocation }) => { assert.ok(invocation && typeof invocation === 'object'); assert.ok(invocation && typeof invocation === 'object' && 'model' in invocation);
    assert.ok(invocation && typeof invocation === 'object' && 'effort' in invocation);
    return ({ resolvedModel: invocation.model, resolvedEffort: invocation.effort, observedSessionConfig: { model: invocation.model, effort: invocation.effort }, effortObserved: true, sessionId: 'codex-1' }); } });
    const result = await dispatchKernelTurn({ controlPlane: cp, runId, adapter, parentSessionId: 'codex-parent-session', registry: registryFor('codex', FRONTIER_ENV), actionContext: { executionMode: 'native-subagent', delegationRequested: true } });
    assert.ok(result && typeof result === 'object' && 'dispatch' in result);
    assert.ok(result.dispatch && typeof result.dispatch === 'object' && 'invocation' in result.dispatch);
    assert.ok(result.dispatch.invocation && typeof result.dispatch.invocation === 'object');
    assert.ok(result.dispatch.invocation && typeof result.dispatch.invocation === 'object' && 'mechanism' in result.dispatch.invocation);
    assert.equal(result.dispatch.invocation.mechanism, 'worker-model-override');
    assert.ok(result && typeof result === 'object' && 'dispatch' in result);
    assert.ok(result.dispatch && typeof result.dispatch === 'object' && 'invocation' in result.dispatch);    assert.ok(result.dispatch.invocation && typeof result.dispatch.invocation === 'object');
    assert.ok(result.dispatch.invocation && typeof result.dispatch.invocation === 'object' && 'sandbox' in result.dispatch.invocation);
    assert.equal(result.dispatch.invocation.sandbox, 'workspace-write');
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'enforcementStatus' in result.receipt);
    assert.equal(result.receipt.enforcementStatus, 'enforced');
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result && typeof result === 'object' && 'resolution' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'requestedModel' in result.receipt);
    assert.ok(result.resolution && typeof result.resolution === 'object' && 'model' in result.resolution);
    assert.equal(result.receipt.requestedModel, result.resolution.model);
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result && typeof result === 'object' && 'resolution' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'requestedEffort' in result.receipt);
    assert.ok(result.resolution && typeof result.resolution === 'object' && 'effort' in result.resolution);
    assert.equal(result.receipt.requestedEffort, result.resolution.effort);
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'inputTokens' in result.receipt);
    assert.equal(result.receipt.inputTokens, null);
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'outputTokens' in result.receipt);
    assert.equal(result.receipt.outputTokens, null);
    assert.equal(cp.modelRoutingSummary(runId).tokens.reportedTurns, 0);
  });
});

test('Codex actual model and effort mismatch is recorded as a fallback, never silently accepted', async () => {
  await withRun(async (cp, runId) => {
    const adapter = createCodexAdapter({
      parentSessionObserver: stableParentObserver,
      launch: async () => ({
        resolvedModel: 'gpt-6-astra',
        resolvedEffort: 'high',
        observedModel: 'gpt-6-astra',
        observedEffort: 'high',
        observedSessionConfig: { model: 'gpt-6-astra', effort: 'high' },
        effortObserved: true,
        sessionId: 'codex-mismatched-worker',
      }),
    });
    const result = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter,
      parentSessionId: 'codex-parent-session',
      registry: registryFor('codex', {}),
      actionContext: { executionMode: 'native-subagent', delegationRequested: true },
    });
    assert.ok(result && typeof result === 'object' && 'resolution' in result);
    assert.ok(result.resolution && typeof result.resolution === 'object' && 'model' in result.resolution);
    assert.equal(result.resolution.model, CODEX_EXECUTION_POLICY.standard.model);
    assert.ok(result && typeof result === 'object' && 'resolution' in result);
    assert.ok(result.resolution && typeof result.resolution === 'object' && 'effort' in result.resolution);
    assert.equal(result.resolution.effort, CODEX_EXECUTION_POLICY.standard.effort);
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'requestedModel' in result.receipt);
    assert.equal(result.receipt.requestedModel, CODEX_EXECUTION_POLICY.standard.model);
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'requestedEffort' in result.receipt);
    assert.equal(result.receipt.requestedEffort, CODEX_EXECUTION_POLICY.standard.effort);
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'resolvedModel' in result.receipt);
    assert.equal(result.receipt.resolvedModel, 'gpt-6-astra');
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'resolvedEffort' in result.receipt);
    assert.equal(result.receipt.resolvedEffort, 'high');
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'observedModel' in result.receipt);
    assert.equal(result.receipt.observedModel, 'gpt-6-astra');
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'observedEffort' in result.receipt);
    assert.equal(result.receipt.observedEffort, 'high');
    assert.ok(result && typeof result === 'object' && 'dispatch' in result);
    assert.ok(result.dispatch && typeof result.dispatch === 'object' && 'errorCode' in result.dispatch);
    assert.equal(result.dispatch.errorCode, 'model-enforcement-failed');
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'enforcementStatus' in result.receipt);
    assert.equal(result.receipt.enforcementStatus, 'failed');
  });
});

test('Codex without an optional native launcher returns the bounded unit to the owner without worker state', async () => {
  await withRun(async (cp, runId) => {
    const result = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter: createCodexAdapter(),
      registry: registryFor('codex', FRONTIER_ENV),
      env: { MOON_RELAY_KERNEL_WAYFINDER_MODE: 'off' },
    });
    assert.equal(result.dispatched, false);
    assert.equal(result.executionMode, 'owner-direct');
    assert.equal(result.reason, 'owner-session-execution-required');
    assert.ok(result && typeof result === 'object' && 'modelInput' in result);
    assert.ok(result.modelInput !== null && result.modelInput !== undefined);
    assert.ok(result.modelInput.action !== null && result.modelInput.action !== undefined);
    assert.equal(result.modelInput.action.type, 'implement');
    assert.equal(result.receipt, null);
    assert.equal(result.hostDirective, null);
    assert.equal(cp.stateStore.listModelRouteDecisions(runId).length, 0);
    const observedRun3 = await cp.getRun(runId);
    assert.ok(observedRun3);
    assert.ok(typeof observedRun3.workspaceId === 'string');
    const observedRun4 = await cp.getRun(runId);
    assert.ok(observedRun4);
    assert.ok(typeof observedRun4.workspaceId === 'string');
    assert.equal(cp.stateStore.getWorkspaceMutationLockV2(observedRun4.workspaceId), null);
  });
});

test('ordinary owner-direct turns ignore configured review fallbacks', async () => {
  await withRun(async (cp, runId) => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const primary = createClaudeAdapter({ launch: async () => { primaryCalls += 1; return {}; } });
    const fallback = createClaudeAdapter({ launch: async () => { fallbackCalls += 1; return {}; } });
    const result = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter: primary,
      registry: registryFor('claude', FRONTIER_ENV),
      actionContext: { obligationId: 'security-review' },
      reviewFallbacks: [{ adapter: fallback, registry: registryFor('claude', FRONTIER_ENV) }],
    });
    assert.equal(result.executionMode, 'owner-direct');
    assert.equal(result.reason, 'owner-session-execution-required');
    assert.equal(primaryCalls, 0);
    assert.equal(fallbackCalls, 0);
    assert.equal(cp.stateStore.listModelRouteDecisions(runId).length, 0);
  });
});

test('a failing dispatch is recorded as failed and never as an enforced success', async () => {
  await withRun(async (cp, runId) => {
    const adapter = createClaudeAdapter({ launch: async () => { throw new Error('worker crashed'); } });
    const result = await dispatchKernelTurn({ controlPlane: cp, runId, adapter, registry: registryFor('claude', FRONTIER_ENV), actionContext: { executionMode: 'native-subagent', delegationRequested: true } });
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'enforcementStatus' in result.receipt);
    assert.equal(result.receipt.enforcementStatus, 'failed');
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'resultStatus' in result.receipt);
    assert.equal(result.receipt.resultStatus, 'failed');
  });
});

test('kernel-owned actions are never dispatched to a provider', async () => {
  await withRun(async (cp, runId) => {
    const adapter = createClaudeAdapter({ launch: async () => { throw new Error('must not be called'); } });
    const result = await dispatchKernelTurn({ controlPlane: cp, runId, adapter, registry: registryFor('claude', FRONTIER_ENV), actionContext: { actionKind: 'prove' } });
    assert.equal(result.dispatched, false);
    assert.equal(result.reason, 'kernel-owned-action');
    assert.equal(result.receipt, null);
    assert.equal(cp.modelRoutingSummary(runId).kernelOnlyActions, 1);
  });
});

test('the worker receives an execution contract, not the conversation', () => {
  const modelInput = {
    objective: 'add a flag', acceptance: ['flag works'], constraints: ['no new deps'], nonGoals: ['redesign'],
    evidence: [
      { obligationId: 'default', status: 'passed', evidenceClass: 'hard' },
      { obligationId: 'security-review', status: 'failed', evidenceClass: 'judgment' },
    ], knowledge: 'irrelevant prompt block',
    action: { type: 'implement', guidance: 'do it', outstandingObligations: ['default'], obligations: [{ obligationId: 'default' }] },
  };
  const implement = buildExecutionContract(modelInput, { role: 'implementer', permissions: 'workspace_write', riskTier: 'T1' });
  assert.deepEqual(implement.outstandingObligations, ['default']);
  assert.equal(implement.permissions, 'workspace_write');
  assert.equal(JSON.stringify(implement).includes('irrelevant prompt block'), false);

  const review = buildExecutionContract({ ...modelInput, changedPaths: ['src/a.ts'] }, { role: 'reviewer', permissions: 'read_only', riskTier: 'T3', obligationId: 'security-review' });
  assert.deepEqual(Object.keys(review).sort(), ['acceptance', 'changedPaths', 'objective', 'permissions', 'riskTier', 'role', 'verificationEvidence']);
  assert.equal(review.permissions, 'read_only');
  assert.equal(Reflect.get(review, 'constraints'), undefined);
  assert.deepEqual(review.acceptance, []);
  assert.ok(review && typeof review === 'object' && 'verificationEvidence' in review);
  assert.ok(Array.isArray(review.verificationEvidence));
  assert.deepEqual(review.verificationEvidence.map((entry) => entry.obligationId), ['default']);

  const visualReview = buildExecutionContract({ ...modelInput, acceptance: [{ id: 'AC-9' }, { id: 'AC-10' }] }, { role: 'reviewer', permissions: 'read_only', riskTier: 'T3', obligationId: 'judgment-ac-10' });
  assert.deepEqual(visualReview.acceptance, [{ id: 'AC-10' }]);
});

type KernelControlPlane = Awaited<ReturnType<typeof createKernelControlPlane>>;
