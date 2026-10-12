import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { dispatchKernelTurn, resolveTurnModelPolicy } from '../src/host/kernel/turn-dispatcher.js';
import { createModelRegistry } from '../src/host/kernel/model-registry.js';
import { createCodexAdapter } from '../src/host/kernel/adapters/codex.js';
import { CODEX_MODELS } from '../src/host/kernel/codex-model-policy.js';

// Regression for a Codex review finding: the provider-specific model policy
// switch must reach dispatchKernelTurn instead of only computing a diagnostic.
// resolved the logical class through the registry, never the Wave 5/6
// Sol/Terra/Luna or Claude-effort recommendation.

const withRun = async (fn: (cp: KernelControlPlane, runId: string) => Promise<unknown>, envOverrides = {}) => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-modelpolicy-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-modelpolicy-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  // The routing fixture still represents an executable Kernel run. Declare a
  // real proof command so proof-policy preflight can succeed before the test
  // reaches the model-routing boundary it is meant to exercise.
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'x',
    scripts: { test: 'node -e "process.exit(0)"' },
  }));
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot, env: envOverrides });
  try {
    await cp.startRun({ runId: 'r-modelpolicy', objective: 'exercise the model-policy mode switch' });
    return await fn(cp, 'r-modelpolicy');
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
};

const stableParentObserver = async ({ parentSessionId }: { parentSessionId?: string | null }) => ({ sessionId: parentSessionId, model: null, effort: null });

test('resolveTurnModelPolicy recommends Luna/max for a standard Codex implement turn', () => {
  const recommendation = resolveTurnModelPolicy({
    decision: { actionKind: 'implement', riskTier: 'T1', reasonCodes: ['ACTION_DEFAULT'] },
    hostCapabilities: { surface: 'codex' },
  });
  assert.ok(recommendation && typeof recommendation === 'object' && 'model' in recommendation);
  assert.equal(recommendation.model, CODEX_MODELS.luna);
  assert.ok(recommendation && typeof recommendation === 'object' && 'effort' in recommendation);
  assert.equal(recommendation.effort, 'max');
});

test('resolveTurnModelPolicy recommends a Claude effort with no model override', () => {
  const recommendation = resolveTurnModelPolicy({
    decision: { actionKind: 'review_engineering', riskTier: 'T1', reasonCodes: ['ACTION_DEFAULT'] },
    hostCapabilities: { surface: 'claude' },
  });
  assert.ok(recommendation && typeof recommendation === 'object' && 'model' in recommendation);
  assert.equal(recommendation.model, null);
  assert.ok(recommendation && typeof recommendation === 'object' && 'effort' in recommendation);
  assert.equal(recommendation.effort, 'medium');
});

test('an unrecognized surface gets no recommendation', () => {
  assert.equal(resolveTurnModelPolicy({ decision: { actionKind: 'implement', reasonCodes: [] }, hostCapabilities: { surface: 'fable' } }), null);
});

test('Codex shadow mode computes the recommendation but does not apply it', async () => {
  await withRun(async (cp, runId) => {
    const adapter = createCodexAdapter({ parentSessionObserver: stableParentObserver, launch: async ({ invocation }) => { assert.ok(invocation && typeof invocation === 'object'); assert.ok(invocation && typeof invocation === 'object' && 'effort' in invocation);
    return ({ resolvedModel: 'host-configured', resolvedEffort: invocation.effort, effortObserved: true, sessionId: 'codex-session-1' }); } });
    const result = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter,
      parentSessionId: 'codex-parent-session',
      registry: createModelRegistry({ surface: 'codex' }),
      env: { MOON_RELAY_KERNEL_CODEX_MODEL_POLICY_MODE: 'shadow' },
      actionContext: { executionMode: 'native-subagent', delegationRequested: true },
    });
    assert.equal(result.dispatched, true);
    // The final Codex profile defaults on; explicitly selecting shadow must
    // leave the registry resolution unchanged.
    assert.ok(result && typeof result === 'object' && 'resolution' in result);
    assert.ok(result.resolution && typeof result.resolution === 'object' && 'model' in result.resolution);
    assert.notEqual(result.resolution.model, CODEX_MODELS.luna);
    assert.ok(result && typeof result === 'object' && 'resolution' in result);
    assert.ok(result.resolution && typeof result.resolution === 'object' && 'model' in result.resolution);
    assert.equal(result.resolution.model, null);
    assert.ok(result && typeof result === 'object' && 'resolution' in result);
    assert.ok(result.resolution && typeof result.resolution === 'object' && 'effort' in result.resolution);
    assert.equal(result.resolution.effort, null);
  });
});

test('Codex-specific on mode applies Luna/max to the actual dispatch', async () => {
  await withRun(async (cp, runId) => {
    const launchObservation: { invocation?: unknown } = {};
    const adapter = createCodexAdapter({
      parentSessionObserver: stableParentObserver,
      launch: async ({ invocation }) => { launchObservation.invocation = invocation; assert.ok(invocation && typeof invocation === 'object' && 'model' in invocation);
      assert.ok(invocation && typeof invocation === 'object' && 'effort' in invocation);
      return { resolvedModel: invocation.model, resolvedEffort: invocation.effort, effortObserved: true, sessionId: 'codex-session-default-on' }; },
    });
    const result = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter,
      parentSessionId: 'codex-parent-session',
      registry: createModelRegistry({ surface: 'codex' }),
      env: { MOON_RELAY_KERNEL_CODEX_MODEL_POLICY_MODE: 'on' },
      actionContext: { executionMode: 'native-subagent', delegationRequested: true },
    });
    assert.ok(result && typeof result === 'object' && 'resolution' in result);
    assert.ok(result.resolution && typeof result.resolution === 'object' && 'model' in result.resolution);
    assert.equal(result.resolution.model, CODEX_MODELS.luna);
    assert.ok(result && typeof result === 'object' && 'resolution' in result);
    assert.ok(result.resolution && typeof result.resolution === 'object' && 'effort' in result.resolution);
    assert.equal(result.resolution.effort, 'max');
    assert.ok(launchObservation.invocation && typeof launchObservation.invocation === 'object' && 'model' in launchObservation.invocation);
    assert.equal(launchObservation.invocation.model, CODEX_MODELS.luna);
    assert.ok(launchObservation.invocation && typeof launchObservation.invocation === 'object' && 'effort' in launchObservation.invocation);
    assert.equal(launchObservation.invocation.effort, 'max');
  });
});

test('MOON_RELAY_KERNEL_MODEL_POLICY_MODE=on applies the recommendation to the actual dispatch', async () => {
  await withRun(async (cp, runId) => {
    const launchObservation: { invocation?: unknown } = {};
    const adapter = createCodexAdapter({
      parentSessionObserver: stableParentObserver,
      launch: async ({ invocation }) => { launchObservation.invocation = invocation; assert.ok(invocation && typeof invocation === 'object' && 'model' in invocation);
      assert.ok(invocation && typeof invocation === 'object' && 'effort' in invocation);
      return { resolvedModel: invocation.model, resolvedEffort: invocation.effort, effortObserved: true, sessionId: 'codex-session-2' }; },
    });
    const result = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter,
      parentSessionId: 'codex-parent-session',
      registry: createModelRegistry({ surface: 'codex' }),
      env: { MOON_RELAY_KERNEL_MODEL_POLICY_MODE: 'on' },
      actionContext: { executionMode: 'native-subagent', delegationRequested: true },
    });
    assert.equal(result.dispatched, true);
    assert.ok(result && typeof result === 'object' && 'resolution' in result);
    assert.ok(result.resolution && typeof result.resolution === 'object' && 'model' in result.resolution);
    assert.equal(result.resolution.model, CODEX_MODELS.luna);
    assert.ok(result && typeof result === 'object' && 'resolution' in result);
    assert.ok(result.resolution && typeof result.resolution === 'object' && 'effort' in result.resolution);
    assert.equal(result.resolution.effort, 'max');
    assert.ok(result && typeof result === 'object' && 'resolution' in result);
    assert.ok(result.resolution && typeof result.resolution === 'object' && 'source' in result.resolution);
    assert.equal(result.resolution.source, 'model-policy');
    assert.ok(launchObservation.invocation && typeof launchObservation.invocation === 'object' && 'model' in launchObservation.invocation);
    assert.equal(launchObservation.invocation.model, CODEX_MODELS.luna, 'the adapter must dispatch with the applied resolution, not the registry default');
  });
});

test('model-policy mode never claims enforced on Claude with no concrete model configured', async () => {
  // Regression: Claude's recommendation supplies only an effort (model:
  // null). Applying it unconditionally still flipped source/enforcementIntent
  // to 'model-policy'/'enforced' even though resolution.model stayed null —
  // which is exactly what admission's checkRoleRules() uses to decide a T3
  // review ran on a proven, enforced model. A registry with nothing
  // configured must keep reporting an unenforced, no-model resolution.
  const { createClaudeAdapter } = await import('../src/host/kernel/adapters/claude.js');
  await withRun(async (cp, runId) => {
    const adapter = createClaudeAdapter({ launch: async () => ({ sessionId: 'claude-session-3' }) });
    const result = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter,
      registry: createModelRegistry({ surface: 'claude' }),
      env: { MOON_RELAY_KERNEL_MODEL_POLICY_MODE: 'on' },
      actionContext: { executionMode: 'native-subagent', delegationRequested: true },
    });
    assert.ok(result && typeof result === 'object' && 'resolution' in result);
    assert.ok(result.resolution && typeof result.resolution === 'object' && 'model' in result.resolution);
    assert.equal(result.resolution.model, null);
    assert.ok(result && typeof result === 'object' && 'resolution' in result);
    assert.ok(result.resolution && typeof result.resolution === 'object' && 'source' in result.resolution);
    assert.notEqual(result.resolution.source, 'model-policy');
    assert.ok(result && typeof result === 'object' && 'resolution' in result);
    assert.ok(result.resolution && typeof result.resolution === 'object' && 'enforcementIntent' in result.resolution);
    assert.notEqual(result.resolution.enforcementIntent, 'enforced');
  });
});

test('an escalation signal does not change the Codex standard execution class', () => {
  const recommendation = resolveTurnModelPolicy({
    decision: { actionKind: 'implement', riskTier: 'T1', reasonCodes: ['ESCALATION_LOCKED'] },
    hostCapabilities: { surface: 'codex' },
  });
  assert.ok(recommendation && typeof recommendation === 'object' && 'executionClass' in recommendation);
  assert.equal(recommendation.executionClass, 'standard');
  assert.ok(recommendation && typeof recommendation === 'object' && 'model' in recommendation);
  assert.equal(recommendation.model, CODEX_MODELS.luna);
  assert.ok(recommendation && typeof recommendation === 'object' && 'effort' in recommendation);
  assert.equal(recommendation.effort, 'max');
});

test('an explicit invocation-override model survives model-policy mode', async () => {
  // Regression: 'invocation-override' is the registry's own highest-
  // precedence source (§10.2) — an explicit per-call model request. Applying
  // the model-policy recommendation on top of it silently ran Terra/Sol/Luna
  // instead of the model a caller explicitly asked for.
  await withRun(async (cp, runId) => {
    let seenModel = null;
    const adapter = createCodexAdapter({
      parentSessionObserver: stableParentObserver,
      launch: async ({ invocation }) => { assert.ok(invocation && typeof invocation === 'object' && 'model' in invocation);
      seenModel = invocation.model; assert.ok(invocation && typeof invocation === 'object' && 'model' in invocation);
      assert.ok(invocation && typeof invocation === 'object' && 'effort' in invocation);
      return { resolvedModel: invocation.model, resolvedEffort: invocation.effort, effortObserved: true, sessionId: 'codex-session-4' }; },
    });
    const result = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter,
      parentSessionId: 'codex-parent-session',
      registry: createModelRegistry({ surface: 'codex' }),
      overrides: { value_coding: 'explicit-strong-model' },
      env: { MOON_RELAY_KERNEL_CODEX_MODEL_POLICY_MODE: 'on' },
      actionContext: { executionMode: 'native-subagent', delegationRequested: true },
    });
    assert.ok(result && typeof result === 'object' && 'resolution' in result);
    assert.ok(result.resolution && typeof result.resolution === 'object' && 'source' in result.resolution);
    assert.equal(result.resolution.source, 'invocation-override');
    assert.ok(result && typeof result === 'object' && 'resolution' in result);
    assert.ok(result.resolution && typeof result.resolution === 'object' && 'model' in result.resolution);
    assert.equal(result.resolution.model, 'explicit-strong-model');
    assert.equal(seenModel, 'explicit-strong-model');
  });
});

test('shadow mode still records the model-policy escalation reason on the receipt', async () => {
  // Regression: modelEscalationReason was gated on modelPolicyMode==='on',
  // discarding the only receipt-level evidence of the recommendation shadow
  // mode is supposed to let an operator measure before turning it on.
  await withRun(async (cp, runId) => {
    const adapter = createCodexAdapter({ parentSessionObserver: stableParentObserver, launch: async ({ invocation }) => { assert.ok(invocation && typeof invocation === 'object');
    assert.ok(invocation && typeof invocation === 'object' && 'effort' in invocation);
    return ({ resolvedModel: 'host-configured', resolvedEffort: invocation.effort, effortObserved: true, sessionId: 'codex-session-5' }); } });
    const result = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter,
      parentSessionId: 'codex-parent-session',
      registry: createModelRegistry({ surface: 'codex' }),
      actionContext: {
        actionKind: 'review_engineering',
        obligationId: 'security-review',
        executionMode: 'native-subagent',
        delegationRequested: true,
      },
      env: { MOON_RELAY_KERNEL_CODEX_MODEL_POLICY_MODE: 'shadow' },
    });
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'cacheMode' in result.receipt);
    assert.equal(result.receipt.cacheMode, 'shadow');
    assert.ok(result && typeof result === 'object' && 'resolution' in result);
    assert.ok(result.resolution && typeof result.resolution === 'object' && 'model' in result.resolution);
    assert.notEqual(result.resolution.model, CODEX_MODELS.sol, 'shadow must not apply the recommendation to the actual resolution');
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'modelEscalationReason' in result.receipt);
    assert.equal(result.receipt.modelEscalationReason, null);
  });
});

type KernelControlPlane = Awaited<ReturnType<typeof createKernelControlPlane>>;
