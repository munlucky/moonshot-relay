import { prepareTestHostTurn } from './helpers/kernel-host-test-api.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';
import {
  buildTurnPromptEnvelope,
  captureHostExecutionSnapshot,
  dispatchKernelTurn,
  isHostExecutionSnapshotFresh,
} from '../scripts/host/kernel/turn-dispatcher.mjs';
import { buildNextPayload } from '../scripts/kernel/run/run-loop.mjs';
import { createModelRegistry } from '../scripts/host/kernel/model-registry.mjs';
import { createClaudeAdapter } from '../scripts/host/kernel/adapters/claude.mjs';
import { createCodexAdapter } from '../scripts/host/kernel/adapters/codex.mjs';
import { createFableAdapter } from '../scripts/host/kernel/adapters/fable.mjs';
import { MODEL_VISIBLE_PROMPT_FIELDS } from '../scripts/host/kernel/model-capsule-view.mjs';

// Regression for a Codex review finding on PR #19: buildPromptEnvelope was
// exercised only by the replay corpus and unit tests, never by a real
// dispatch, so a real Claude/Codex turn's receipt never carried a
// prefixDigest or cache policy. dispatchKernelTurn now computes the envelope
// on every turn and forwards it to both the adapter and the usage receipt.

const FRONTIER_ENV = { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'configured-frontier', MOON_RELAY_KERNEL_MODEL_VALUE: 'configured-value' };

const withRun = async (fn) => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-envelope-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-envelope-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' } }));
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    await cp.startRun({ runId: 'r-envelope', objective: 'exercise the prompt envelope on a live dispatch' });
    return await fn(cp, 'r-envelope');
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
};

test('buildTurnPromptEnvelope compiles a real cache identity from a next() payload', () => {
  const envelope = buildTurnPromptEnvelope({
    modelInput: {
      objective: 'Ship the feature',
      acceptance: ['it works'],
      constraints: [],
      nonGoals: [],
      evidence: [{ obligationId: 'default', status: 'pending', evidenceDigest: 'sha256:aaa' }],
      // The real next() payload nests the current work unit under
      // action.step (run-loop.mjs's buildNextPayload), not at a top-level
      // `step` — this fixture matches that shape deliberately.
      action: { type: 'implement', guidance: 'go', obligations: [{ obligationId: 'default' }], step: { stepId: 'step-1', objective: 'go', allowedPaths: ['src/'], forbiddenPaths: [] } },
    },
    decision: { runId: 'r-1', role: 'implementer', actionKind: 'implement', riskTier: 'T1', modelClass: 'value_coding' },
    resolution: { model: 'model-a', effort: 'high' },
    hostCapabilities: { surface: 'claude' },
  });
  assert.match(envelope.cacheIdentity.prefixDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(envelope.cacheIdentity.resolvedModel, 'model-a');
  assert.equal(envelope.control.runId, 'r-1');
  assert.equal(envelope.control.stepId, 'step-1');
});

test('a real dispatch records a non-null prefix digest and cache mode on the receipt', async () => {
  await withRun(async (cp, runId) => {
    const adapter = createClaudeAdapter({
      launch: async ({ invocation, envelope }) => {
        // The envelope remains available to the Host receipt path, but is
        // intentionally not a provider-launch argument.
        assert.equal(envelope, undefined, 'Host prompt envelope must not cross the provider boundary');
        return { resolvedModel: invocation.model, sessionId: 'claude-session-1' };
      },
    });
    const result = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter,
      registry: createModelRegistry({ surface: 'claude', env: FRONTIER_ENV }),
      actionContext: { executionMode: 'native-subagent', delegationRequested: true },
    });
    assert.equal(result.dispatched, true);
    assert.ok(result.envelope);
    assert.match(result.receipt.promptPrefixDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(result.receipt.promptPrefixDigest, result.envelope.cacheIdentity.prefixDigest);
    assert.equal(result.receipt.cacheMode, 'shadow');
    assert.ok(result.receipt.sessionLineageId);
    // Regression: without reading the current step from action.step, and
    // without forwarding the envelope's cacheable segment tokens, these two
    // fields stayed null/undefined on every real dispatch.
    assert.ok(result.envelope.control.stepId, 'the live envelope must carry a real stepId, not the undefined a wrong modelInput.step read would produce');
    assert.ok(result.receipt.eligiblePrefixTokens > 0);
  });
});

test('the provider does not receive the Host execution contract', async () => {
  await withRun(async (cp, runId) => {
    let seenProviderInput = null;
    const adapter = createClaudeAdapter({
      launch: async (providerInput) => {
        seenProviderInput = providerInput;
        const { invocation } = providerInput;
        return { resolvedModel: invocation.model, sessionId: 'claude-session-1' };
      },
    });
    await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter,
      registry: createModelRegistry({ surface: 'claude', env: FRONTIER_ENV }),
      actionContext: { executionMode: 'native-subagent', delegationRequested: true },
    });
    assert.ok(seenProviderInput);
    assert.equal(seenProviderInput.executionContract, undefined);
    assert.equal(seenProviderInput.executionCapsule, undefined);
    assert.equal(seenProviderInput.envelope, undefined);
    assert.equal(seenProviderInput.control, undefined);
    assert.equal(seenProviderInput.modelPolicy, undefined);
    assert.equal(seenProviderInput.message.includes('executionContract'), false);
    assert.equal(seenProviderInput.message.includes('executionCapsule'), false);
  });
});

test('two independent turns with the same identity fingerprint do not share a session-lineage id', async () => {
  // Regression: with no persisted prior session, resolveSessionLineage was
  // called with previous:null every time, so two wholly separate dispatches
  // that happened to share the same role/model/effort/digests minted the
  // identical sessionLineageId — a downstream aggregate (summarizeCacheEconomics)
  // would then misread them as one continued session even though neither
  // ever actually reused a provider session.
  await withRun(async (cp, runId) => {
    const adapter = createClaudeAdapter({
      launch: async ({ invocation }) => ({ resolvedModel: invocation.model, sessionId: 'claude-session-1' }),
    });
    const registry = createModelRegistry({ surface: 'claude', env: FRONTIER_ENV });
    const actionContext = { executionMode: 'native-subagent', delegationRequested: true };
    const first = await dispatchKernelTurn({ controlPlane: cp, runId, adapter, registry, actionContext });
    const second = await dispatchKernelTurn({ controlPlane: cp, runId, adapter, registry, actionContext });
    assert.equal(first.envelope.cacheIdentity.prefixDigest, second.envelope.cacheIdentity.prefixDigest, 'the two turns must share the same identity fingerprint for this regression to be meaningful');
    assert.notEqual(first.receipt.sessionLineageId, second.receipt.sessionLineageId);
  });
});

test('the provider launcher receives only the six-field prompt projection', async () => {
  // Regression: the raw persisted executionCapsule used to reach the
  // launcher, and a caller-supplied modelVisiblePrompt could bypass the
  // projection boundary.
  await withRun(async (cp, runId) => {
    let seenProviderInput = null;
    const adapter = createClaudeAdapter({
      launch: async (providerInput) => { seenProviderInput = providerInput; return { resolvedModel: 'model-a', sessionId: 'claude-session-1' }; },
    });
    const result = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter,
      registry: createModelRegistry({ surface: 'claude', env: FRONTIER_ENV }),
      actionContext: { executionMode: 'native-subagent', delegationRequested: true },
    });
    assert.ok(seenProviderInput, 'the fake provider must receive a prompt');
    assert.deepEqual(Object.keys(seenProviderInput.modelVisiblePrompt), [...MODEL_VISIBLE_PROMPT_FIELDS]);
    assert.deepEqual(seenProviderInput.prompt, seenProviderInput.modelVisiblePrompt);
    for (const forbidden of ['executionContract', 'executionCapsule', 'role', 'permissions', 'nonGoals', 'envelope', 'control', 'modelPolicy', 'reviewSubject']) {
      assert.equal(Object.hasOwn(seenProviderInput, forbidden), false, `provider input leaked ${forbidden}`);
      assert.equal(Object.hasOwn(seenProviderInput.invocation, forbidden), false, `provider invocation leaked ${forbidden}`);
    }
    assert.doesNotMatch(seenProviderInput.message, /executionContract|executionCapsule|"role"|"permissions"|"nonGoals"/);
    // The full, unprojected capsule is still what the receipt's lineage uses.
    assert.ok(result.executionCapsule.capsuleId);
  });
});

test('the Fable launcher receives only the sanitized prompt boundary', async () => {
  let seen = null;
  const adapter = createFableAdapter({
    launch: async (providerInput) => {
      seen = providerInput;
      return { status: 'completed' };
    },
  });
  const result = await adapter.dispatch({
    decision: { role: 'implementer', modelClass: 'value_coding', permissions: { filesystem: 'workspace_write' } },
    resolution: { model: 'host-only-model', effort: 'high' },
    modelInput: {
      objective: 'fable objective',
      action: { type: 'implement', step: { allowedPaths: ['src/**'] } },
      requiredEvidence: [{ obligationId: 'fable-proof', provider: { leaseId: 'nested-leak' } }],
      executionContract: { mutationRevision: 7 },
    },
    executionCapsule: { capsuleId: 'capsule-host-only', mutationRevision: 7, provenance: { routeDecisionId: 'route-host-only' } },
    envelope: { control: { runId: 'run-host-only' }, modelPolicy: { resolvedModel: 'host-only-model' } },
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(Object.keys(seen).sort(), ['message', 'modelVisiblePrompt', 'prompt']);
  assert.deepEqual(seen.modelVisiblePrompt.requiredEvidence, [{ obligationId: 'fable-proof' }]);
  assert.doesNotMatch(seen.message, /executionContract|capsuleId|mutationRevision|routeDecision|provider|lease|control|modelPolicy/u);
});

test('Host Dispatcher owns the one equivalent transport retry after a pure pre-spawn failure', async () => {
  await withRun(async (cp, runId) => {
    let nativeAttempts = 0;
    let ownerDirectAttempts = 0;
    const adapter = createCodexAdapter({
      parentSessionObserver: async ({ parentSessionId }) => ({
        sessionId: parentSessionId,
        model: 'owner-model',
        effort: 'owner-effort',
      }),
      launch: async ({ invocation }) => {
        ownerDirectAttempts += 1;
        return {
          status: 'completed',
          resultStatus: 'completed',
          resolvedModel: invocation.model,
          resolvedEffort: invocation.effort,
          sessionId: 'owner-session-1',
          outcome: { status: 'completed', summary: 'owner transport completed' },
        };
      },
      nativeLaunch: async () => {
        nativeAttempts += 1;
        return {
          status: 'failed',
          resultStatus: 'failed',
          errorCode: 'launcher-unavailable',
          failureStage: 'pre-spawn',
        };
      },
    });
    const result = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter,
      registry: createModelRegistry({ surface: 'codex', env: FRONTIER_ENV }),
      actionContext: { executionMode: 'native-subagent', delegationRequested: true },
      parentSessionId: 'main-session',
      parentSessionConfig: {
        before: { sessionId: 'main-session', model: 'owner-model', effort: 'owner-effort' },
        after: { sessionId: 'main-session', model: 'owner-model', effort: 'owner-effort' },
      },
    });

    assert.equal(nativeAttempts, 1, 'the native transport must be attempted once');
    assert.equal(ownerDirectAttempts, 1, 'the Host may select one equivalent owner transport');
    assert.equal(result.dispatched, true);
    assert.equal(result.dispatch.dispatchMechanism, 'owner-direct');
    assert.equal(result.dispatch.fallbackReason, 'pre-spawn-native-transport-failure');
    assert.deepEqual(result.transportFallback, {
      preSpawn: true,
      providerExecutionObserved: false,
      semanticOutcomeObserved: false,
      mutationEvidenceObserved: false,
      failed: true,
      contractPreserved: true,
      safeToRetryTransport: true,
      reason: 'pre-spawn-native-transport-failure',
      from: 'native-subagent',
      to: 'owner-direct',
    });
  });
});

test('Correction 3: normal bounded mutation turn does not invoke controlPlane.next multiple times for same state', async () => {
  await withRun(async (cp, runId) => {
    let nextCalls = 0;
    const origNext = cp.next.bind(cp);
    cp.next = async (...args) => {
      nextCalls += 1;
      const res = await origNext(...args);
      return {
        ...res,
        action: {
          type: 'implement',
          guidance: 'implement bounded work',
          step: { stepId: cp.getCurrentStep(runId)?.stepId || 'step-1', allowedPaths: ['src/app.mjs'] },
        },
      };
    };

    const adapter = {
      surface: 'codex',
      ownerDirectDefault: true,
      nativeDelegationAvailable: true,
      capabilities: { surface: 'codex', nativeSubagent: true, supportsSubagentModel: true },
      dispatch: async ({ invocation }) => ({
        status: 'completed',
        resultStatus: 'completed',
        resolvedModel: invocation?.model || 'gpt-5.6-sol',
        sessionId: 'child-session-1',
        outcome: { status: 'completed', changedPaths: ['src/app.mjs'] },
      }),
    };

    await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter,
      registry: createModelRegistry({ surface: 'codex', env: FRONTIER_ENV }),
      actionContext: {},
    });

    assert.equal(nextCalls, 1, `controlPlane.next must be called exactly once, got ${nextCalls}`);
  });
});

test('ordinary Kernel actions expose a role without selecting Host transport', () => {
  const payload = buildNextPayload({
    run: { runId: 'r-action-contract', objective: 'bounded implementation', status: 'active', acceptanceCriteria: [] },
    requiredObligations: ['unit-test'],
    contract: {
      acceptance: [{ id: 'AC-1', statement: 'bounded implementation' }],
      constraints: [],
      nonGoals: [],
      risks: [],
      completionPredicate: { requiredOutcomes: [] },
    },
  });

  assert.equal(payload.action.type, 'implement');
  assert.deepEqual(payload.action.execution, {
    role: 'implementer',
    delegation: { mode: 'optional' },
  });
  assert.equal(Object.hasOwn(payload.action.execution, 'executionMode'), false);
});

test('preloaded Host execution snapshots become stale when the mutation revision advances', async () => {
  await withRun(async (cp, runId) => {
    const stepId = cp.getCurrentStep(runId)?.stepId;
    const snapshot = captureHostExecutionSnapshot({ controlPlane: cp, runId, requestedStepId: stepId });
    assert.ok(snapshot, 'the live run must provide a complete execution snapshot');
    assert.equal(isHostExecutionSnapshotFresh({ controlPlane: cp, runId, snapshot, requestedStepId: stepId }), true);

    const currentIdentity = cp.stateStore.getRun(runId).currentWorkspaceIdentity;
    const firstIdentity = currentIdentity === `sha256:${'a'.repeat(64)}`
      ? `sha256:${'b'.repeat(64)}`
      : `sha256:${'a'.repeat(64)}`;
    const secondIdentity = firstIdentity === `sha256:${'a'.repeat(64)}`
      ? `sha256:${'b'.repeat(64)}`
      : `sha256:${'a'.repeat(64)}`;
    cp.stateStore.observeWorkspaceIdentity(runId, firstIdentity);
    cp.stateStore.observeWorkspaceIdentity(runId, secondIdentity);
    assert.equal(isHostExecutionSnapshotFresh({ controlPlane: cp, runId, snapshot, requestedStepId: stepId }), false);
  });
});

test('Correction 3: baseline-required recalculates modelInput via additional next call', async () => {
  await withRun(async (cp, runId) => {
    let nextCalls = 0;
    const origNext = cp.next.bind(cp);
    cp.next = async (...args) => {
      nextCalls += 1;
      return origNext(...args);
    };

    let captured = false;
    cp.captureBaseline = async () => {
      captured = true;
      return { status: 'captured', baselineFailures: [] };
    };

    await prepareTestHostTurn(cp, runId, {
      hostCapabilities: { surface: 'codex', nativeSubagent: true },
      modelInput: {
        action: { type: 'baseline-required', commandRefs: ['test'] },
      },
    });

    assert.equal(captured, true, 'captureBaseline must be called');
    assert.equal(nextCalls, 1, 'recalculation must call cp.next');
  });
});
