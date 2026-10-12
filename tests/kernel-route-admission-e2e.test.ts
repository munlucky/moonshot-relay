// K3 end to end: the admission is created, revalidated, and linked to the usage
// receipt on every dispatched turn — including the honest weaker outcomes.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { openKernelStateStore } from '../src/kernel/state-store.js';
import { dispatchKernelTurn } from '../src/host/kernel/turn-dispatcher.js';
import { createModelRegistry } from '../src/host/kernel/model-registry.js';
import { createClaudeAdapter } from '../src/host/kernel/adapters/claude.js';
import { createCodexAdapter } from '../src/host/kernel/adapters/codex.js';
import { createFableAdapter } from '../src/host/kernel/adapters/fable.js';

const CONFIGURED = { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'configured-frontier', MOON_RELAY_KERNEL_MODEL_VALUE: 'configured-value' };
const stableParentObserver = async ({ parentSessionId }: { parentSessionId?: string | null }) => ({ sessionId: parentSessionId, model: null, effort: null });

const withRun = async (fn: (cp: KernelControlPlane, runId: string, fixture: { runtimeHome: string; projectRoot: string }) => Promise<unknown>, { taskContract = { acceptance: ['works'] } } = {}) => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-adme2e-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-adme2e-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'x', scripts: { 'test:ok': 'node -e "process.exit(0)"' } }));
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    await cp.startRun({ runId: 'r-e2e', objective: 'implement', taskContract });
    return await fn(cp, 'r-e2e', { runtimeHome, projectRoot });
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
};

test('K3-1/10: a value implementation turn is admitted and its receipt carries the lineage', async () => {
  await withRun(async (cp, runId, fixture) => {
    const adapter = createClaudeAdapter({ launch: async ({ invocation }) => { assert.ok(invocation && typeof invocation === 'object'); assert.ok(invocation && typeof invocation === 'object' && 'model' in invocation);
    return ({ resolvedModel: invocation.model, sessionId: 'worker-1', inputTokens: 10, outputTokens: 5 }); } });
    const result = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter,
      registry: createModelRegistry({ surface: 'claude', env: CONFIGURED }),
      economics: { maxCostUnits: 10, estimatedCostUnits: 3 },
      actionContext: { executionMode: 'native-subagent', delegationRequested: true },
    });

    assert.equal(result.dispatched, true);
    assert.ok(result && typeof result === 'object' && 'admission' in result);
    assert.ok(result.admission !== null && result.admission !== undefined);
    assert.equal(result.admission.decision, 'admitted');
    assert.ok(result && typeof result === 'object' && 'admission' in result);
    assert.ok(result.admission !== null && result.admission !== undefined);
    assert.ok(result.admission.requested && typeof result.admission.requested === 'object');
    assert.ok(result.admission.requested && typeof result.admission.requested === 'object' && 'modelClass' in result.admission.requested);
    assert.equal(result.admission.requested.modelClass, 'value_coding');
    assert.ok(result && typeof result === 'object' && 'admission' in result);
    assert.ok(result.admission !== null && result.admission !== undefined);
    assert.ok(result.admission.resolved && typeof result.admission.resolved === 'object');
    assert.ok(result.admission.resolved && typeof result.admission.resolved === 'object' && 'source' in result.admission.resolved);
    assert.equal(result.admission.resolved.source, 'environment');
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'enforcementStatus' in result.receipt);
    assert.equal(result.receipt.enforcementStatus, 'enforced');

    // Everything resolves from persisted state after the process is gone.
    const store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
    try {
      const [receipt] = store.listModelUsageReceipts(runId);
      assert.ok(typeof receipt.admissionId === 'string');
      const admission = store.getRouteAdmission(receipt.admissionId, { runId });
      assert.ok(admission && typeof admission === 'object' && 'digest' in admission);
      assert.equal(admission.digest, receipt.admissionDigest);
      assert.ok(admission && typeof admission === 'object' && 'decisionId' in admission);
      assert.equal(admission.decisionId, receipt.decisionId);
      assert.ok(typeof receipt.capsuleId === 'string');
      const observedValue8 = store.getExecutionCapsule(receipt.capsuleId, { runId });
    assert.ok(observedValue8);
    assert.ok(observedValue8.provenance && typeof observedValue8.provenance === 'object');
    assert.ok(observedValue8.provenance && typeof observedValue8.provenance === 'object' && 'capsuleDigest' in observedValue8.provenance);
    assert.equal(observedValue8.provenance.capsuleDigest, receipt.capsuleDigest);
      assert.ok(admission && typeof admission === 'object' && 'stepId' in admission);
      assert.equal(receipt.stepId, admission.stepId);
    } finally {
      store.close();
    }
  });
});

test('K3-7: a Host that answers with another model is admitted but recorded as a fallback', async () => {
  await withRun(async (cp, runId) => {
    const adapter = createClaudeAdapter({ launch: async () => ({ resolvedModel: 'something-else', sessionId: 's' }) });
    const result = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter,
      registry: createModelRegistry({ surface: 'claude', env: CONFIGURED }),
      actionContext: { executionMode: 'native-subagent', delegationRequested: true },
    });
    // Admission answers "may this dispatch happen"; the receipt answers "what
    // actually ran". The mismatch surfaces in the receipt, not as a success.
    assert.ok(result && typeof result === 'object' && 'admission' in result);
    assert.ok(result.admission !== null && result.admission !== undefined);
    assert.equal(result.admission.decision, 'admitted');
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'enforcementStatus' in result.receipt);
    assert.equal(result.receipt.enforcementStatus, 'fallback');
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'resolvedModel' in result.receipt);
    assert.equal(result.receipt.resolvedModel, 'something-else');
  });
});

test('K3-8: a Host that cannot report tokens leaves them unavailable on an admitted turn', async () => {
  await withRun(async (cp, runId, fixture) => {
    const adapter = createCodexAdapter({ parentSessionObserver: stableParentObserver, launch: async ({ invocation }) => { assert.ok(invocation && typeof invocation === 'object');
    assert.ok(invocation && typeof invocation === 'object' && 'model' in invocation);
    assert.ok(invocation && typeof invocation === 'object' && 'effort' in invocation);
    return ({ resolvedModel: invocation.model, resolvedEffort: invocation.effort, observedSessionConfig: { model: invocation.model, effort: invocation.effort }, effortObserved: true, sessionId: 'codex-1' }); } });
    const result = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter,
      parentSessionId: 'codex-parent-session',
      registry: createModelRegistry({ surface: 'codex', env: CONFIGURED }),
      actionContext: { executionMode: 'native-subagent', delegationRequested: true },
    });
    assert.ok(result && typeof result === 'object' && 'admission' in result);
    assert.ok(result.admission !== null && result.admission !== undefined);
    assert.equal(result.admission.decision, 'admitted');
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'enforcementStatus' in result.receipt);
    assert.equal(result.receipt.enforcementStatus, 'enforced');
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'inputTokens' in result.receipt);
    assert.equal(result.receipt.inputTokens, null);
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'outputTokens' in result.receipt);
    assert.equal(result.receipt.outputTokens, null);
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
    assert.ok(result && typeof result === 'object' && 'resolution' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'observedModel' in result.receipt);
    assert.ok(result.resolution && typeof result.resolution === 'object' && 'model' in result.resolution);
    assert.equal(result.receipt.observedModel, result.resolution.model);
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result && typeof result === 'object' && 'resolution' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'observedEffort' in result.receipt);
    assert.ok(result.resolution && typeof result.resolution === 'object' && 'effort' in result.resolution);
    assert.equal(result.receipt.observedEffort, result.resolution.effort);
    const store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
    try {
      const [stored] = store.listModelUsageReceipts(runId);
      assert.ok(result && typeof result === 'object' && 'resolution' in result);
      assert.ok(result.resolution && typeof result.resolution === 'object' && 'model' in result.resolution);
      assert.equal(stored.requestedModel, result.resolution.model);
      assert.ok(result && typeof result === 'object' && 'resolution' in result);
      assert.ok(result.resolution && typeof result.resolution === 'object' && 'effort' in result.resolution);
      assert.equal(stored.requestedEffort, result.resolution.effort);
      assert.ok(result && typeof result === 'object' && 'resolution' in result);
      assert.ok(result.resolution && typeof result.resolution === 'object' && 'model' in result.resolution);
      assert.equal(stored.observedModel, result.resolution.model);
      assert.ok(result && typeof result === 'object' && 'resolution' in result);
      assert.ok(result.resolution && typeof result.resolution === 'object' && 'effort' in result.resolution);
      assert.equal(stored.observedEffort, result.resolution.effort);
    } finally {
      store.close();
    }
  });
});

test('K3: a Host that can neither select a model nor prove one is advisory, and says so', async () => {
  await withRun(async (cp, runId) => {
    // The generic surface declares nothing it cannot prove. Ordinary work still
    // proceeds on whatever model the Host runs — but the admission and the
    // receipt both refuse to call that the requested class.
    const result = await dispatchKernelTurn({ controlPlane: cp, runId, adapter: createFableAdapter(), registry: createModelRegistry({ surface: 'fable', env: CONFIGURED }) });
    assert.equal(result.dispatched, true);
    assert.ok(result && typeof result === 'object' && 'admission' in result);
    assert.ok(result.admission !== null && result.admission !== undefined);
    assert.equal(result.admission.decision, 'advisory_admitted');
    assert.ok(result && typeof result === 'object' && 'admission' in result);
    assert.ok(result.admission !== null && result.admission !== undefined);
    assert.notEqual(result.admission.decision, 'admitted');
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'enforcementStatus' in result.receipt);
    assert.equal(result.receipt.enforcementStatus, 'unsupported');
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'resolvedModel' in result.receipt);
    assert.equal(result.receipt.resolvedModel, null);
    const observedValue9 = cp.listRouteAdmissions(runId).at(-1);
    assert.ok(observedValue9);
    assert.equal(observedValue9.decision, 'advisory_admitted');
  });
});

test('K3: an advisory admission is recorded as advisory, never as admitted', async () => {
  await withRun(async (cp, runId) => {
    const adapter = createClaudeAdapter({ launch: async () => ({ resolvedModel: 'host-default-model', sessionId: 's' }) });
    const result = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter,
      registry: createModelRegistry({ surface: 'claude', env: {} }),
      actionContext: { executionMode: 'native-subagent', delegationRequested: true },
    });
    assert.equal(result.dispatched, true);
    assert.ok(result && typeof result === 'object' && 'admission' in result);
    assert.ok(result.admission !== null && result.admission !== undefined);
    assert.equal(result.admission.decision, 'advisory_admitted');
    assert.ok(result && typeof result === 'object' && 'admission' in result);
    assert.ok(result.admission !== null && result.admission !== undefined);
    assert.ok(result.admission.resolved && typeof result.admission.resolved === 'object');
    assert.ok(result.admission.resolved && typeof result.admission.resolved === 'object' && 'source' in result.admission.resolved);
    assert.equal(result.admission.resolved.source, 'host-default');
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'enforcementStatus' in result.receipt);
    assert.equal(result.receipt.enforcementStatus, 'advisory');
  });
});

test('K3-6: a permission policy that moved between admission and dispatch stops the turn', async () => {
  await withRun(async (cp, runId) => {
    let launched = false;
    const adapter = createClaudeAdapter({ launch: async () => { launched = true; return { resolvedModel: 'configured-value', sessionId: 's' }; } });
    // The adapter the dispatcher revalidates against reports different
    // capabilities than the ones the admission was computed from.
    const drifting = { ...adapter, capabilities: { ...adapter.capabilities, supportsUsageTokens: !adapter.capabilities.supportsUsageTokens } };
    const original = drifting.capabilities;
    Object.defineProperty(drifting, 'capabilities', {
      get() {
        // First read (admission) sees the recorded snapshot; the revalidation
        // read sees the changed configuration.
        this._reads = (this._reads || 0) + 1;
        return this._reads <= 1 ? adapter.capabilities : original;
      },
    });

    const result = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter: drifting,
      registry: createModelRegistry({ surface: 'claude', env: CONFIGURED }),
      actionContext: { executionMode: 'native-subagent', delegationRequested: true },
    });
    assert.equal(result.dispatched, false);
    assert.equal(launched, false, 'drift is caught before the worker starts');
    assert.ok(result && typeof result === 'object' && 'drift' in result);
    assert.ok(Array.isArray(result.drift));
    assert.ok(result.drift.length > 0);
    assert.ok(result && typeof result === 'object' && 'drift' in result);
    assert.equal(result.drift[0].field, 'hostCapabilityDigest');
  });
});

type KernelControlPlane = Awaited<ReturnType<typeof createKernelControlPlane>>;
