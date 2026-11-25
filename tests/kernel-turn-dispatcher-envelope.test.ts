import { assertTestNumber, assertTestPresent, assertTestRecord, assertTestString } from './helpers/assert-value.js';
import { prepareTestHostTurn } from './helpers/kernel-host-test-api.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import {
  buildTurnPromptEnvelope,
  captureHostExecutionSnapshot,
  dispatchKernelTurn,
  isHostExecutionSnapshotFresh,
} from '../src/host/kernel/turn-dispatcher.js';
import { buildNextPayload } from '../src/kernel/run/run-loop.js';
import { createModelRegistry } from '../src/host/kernel/model-registry.js';
import { createClaudeAdapter } from '../src/host/kernel/adapters/claude.js';
import { createCodexAdapter } from '../src/host/kernel/adapters/codex.js';
import { bindNativeCommandEvent, type NativeExecutionObservation } from '../src/host/kernel/adapter-dispatch.js';
import { createFableAdapter } from '../src/host/kernel/adapters/fable.js';
import {
  estimateModelVisibleStablePrefixTokens,
  MODEL_VISIBLE_PROMPT_FIELDS,
  resolveModelVisibleStablePrefix,
} from '../src/host/kernel/model-capsule-view.js';

// Regression for a Codex review finding on PR #19: buildPromptEnvelope was
// exercised only by the replay corpus and unit tests, never by a real
// dispatch, so a real Claude/Codex turn's receipt never carried a
// prefixDigest or cache policy. dispatchKernelTurn now computes the envelope
// on every turn and forwards it to both the adapter and the usage receipt.

const FRONTIER_ENV = { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'configured-frontier', MOON_RELAY_KERNEL_MODEL_VALUE: 'configured-value' };

const withRun = async (fn: (cp: TestControlPlane, runId: string) => Promise<unknown>) => {
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
      // action.step (run-loop.js's buildNextPayload), not at a top-level
      // `step` — this fixture matches that shape deliberately.
      action: { type: 'implement', guidance: 'go', obligations: [{ obligationId: 'default' }], step: { stepId: 'step-1', objective: 'go', allowedPaths: ['src/'], forbiddenPaths: [] } },
    },
    decision: { runId: 'r-1', role: 'implementer', actionKind: 'implement', riskTier: 'T1', modelClass: 'value_coding' },
    resolution: { model: 'model-a', effort: 'high', executionClass: 'standard', modelClass: 'value_coding', surface: 'claude', source: 'profile-config', enforcementIntent: 'enforced' },
    hostCapabilities: { surface: 'claude' },
  });
  assert.match(envelope.cacheIdentity.prefixDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(envelope.cacheIdentity.resolvedModel, 'model-a');
  assert.equal(envelope.control.runId, 'r-1');
  assert.equal(envelope.control.stepId, 'step-1');
});

test('a real dispatch records a non-null prefix digest and cache mode on the receipt', async () => {
  await withRun(async (cp: TestControlPlane, runId: string) => {
    const adapter = createClaudeAdapter({
      launch: async ({ invocation, envelope }) => {
        // The envelope remains available to the Host receipt path, but is
        // intentionally not a provider-launch argument.
        assert.equal(envelope, undefined, 'Host prompt envelope must not cross the provider boundary');
        return { resolvedModel: assertTestRecord(invocation).model, sessionId: 'claude-session-1' };
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
    assert.match(assertTestString(assertTestRecord(result.receipt).promptPrefixDigest), /^sha256:[a-f0-9]{64}$/);
    assert.equal(assertTestRecord(result.receipt).promptPrefixDigest, assertTestRecord(assertTestRecord(result.envelope).cacheIdentity).prefixDigest);
    assert.equal(assertTestRecord(result.receipt).cacheMode, 'shadow');
    assert.match(
      assertTestString(assertTestRecord(result.receipt).executionProfileRevision),
      /^host-execution-profile\.v1:sha256:[a-f0-9]{64}$/,
    );
    assert.equal(
      assertTestRecord(assertTestRecord(result.envelope).modelPolicy).policyRevision,
      'kernel-claude-effort.v1',
    );
    assert.ok(assertTestRecord(result.receipt).sessionLineageId);
    // Regression: without reading the current step from action.step, and
    // without forwarding the envelope's cacheable segment tokens, these two
    // fields stayed null/undefined on every real dispatch.
    assert.ok(assertTestRecord(assertTestRecord(result.envelope).control).stepId, 'the live envelope must carry a real stepId, not the undefined a wrong modelInput.step read would produce');
    assert.ok(assertTestNumber(assertTestRecord(result.receipt).eligiblePrefixTokens) > 0);
    const measurement = assertTestRecord(result.promptMeasurement);
    assert.deepEqual(assertTestRecord(result.receipt).promptMeasurement, result.promptMeasurement);
    assert.ok(assertTestNumber(measurement.renderedPromptBytes) > 0);
    assert.ok(assertTestNumber(measurement.renderedPromptTokenEstimate) > 0);
    assert.ok(assertTestNumber(measurement.providerMessageBytes) > 0);
    assert.ok(assertTestNumber(measurement.providerMessageTokenEstimate) > 0);
    const segmentMeasurements = measurement.segments;
    assert.ok(Array.isArray(segmentMeasurements));
    assert.equal(segmentMeasurements.length, 6);
    assert.deepEqual(
      segmentMeasurements.map((entry) => assertTestRecord(entry).kind),
      ['tool-stable', 'common-host-stable', 'provider-stable', 'project-stable', 'run-stable', 'volatile'],
    );
    assert.notEqual(measurement.renderedPromptBytes, measurement.providerMessageBytes);
    for (const envelopeOnlyKind of ['common-host-stable', 'provider-stable']) {
      const segment: unknown = segmentMeasurements.find(
        (entry: unknown) => assertTestRecord(entry).kind === envelopeOnlyKind,
      );
      assert.ok(segment);
      assert.equal(assertTestRecord(segment).loaded, true);
      assert.equal(assertTestRecord(segment).includedVerbatimInProviderMessage, false);
    }
  });
});

test('the provider does not receive the Host execution contract', async () => {
  await withRun(async (cp: TestControlPlane, runId: string) => {
    let seenProviderInput = null;
    const adapter = createClaudeAdapter({
      launch: async (providerInput) => {
        seenProviderInput = providerInput;
        const { invocation } = providerInput;
        return { resolvedModel: assertTestRecord(invocation).model, sessionId: 'claude-session-1' };
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
    assert.equal(assertTestRecord(seenProviderInput).executionContract, undefined);
    assert.equal(assertTestRecord(seenProviderInput).executionCapsule, undefined);
    assert.equal(assertTestRecord(seenProviderInput).envelope, undefined);
    assert.equal(assertTestRecord(seenProviderInput).control, undefined);
    assert.equal(assertTestRecord(seenProviderInput).modelPolicy, undefined);
    assert.equal(assertTestString(assertTestRecord(seenProviderInput).message).includes('executionContract'), false);
    assert.equal(assertTestString(assertTestRecord(seenProviderInput).message).includes('executionCapsule'), false);
  });
});

test('two independent turns with the same identity fingerprint do not share a session-lineage id', async () => {
  // Regression: with no persisted prior session, resolveSessionLineage was
  // called with previous:null every time, so two wholly separate dispatches
  // that happened to share the same role/model/effort/digests minted the
  // identical sessionLineageId — a downstream aggregate (summarizeCacheEconomics)
  // would then misread them as one continued session even though neither
  // ever actually reused a provider session.
  await withRun(async (cp: TestControlPlane, runId: string) => {
    const adapter = createClaudeAdapter({
      launch: async ({ invocation }) => ({ resolvedModel: assertTestRecord(invocation).model, sessionId: 'claude-session-1' }),
    });
    const registry = createModelRegistry({ surface: 'claude', env: FRONTIER_ENV });
    const actionContext = { executionMode: 'native-subagent', delegationRequested: true };
    const first = await dispatchKernelTurn({ controlPlane: cp, runId, adapter, registry, actionContext });
    const second = await dispatchKernelTurn({ controlPlane: cp, runId, adapter, registry, actionContext });
    assert.equal(assertTestRecord(assertTestRecord(first.envelope).cacheIdentity).prefixDigest, assertTestRecord(assertTestRecord(second.envelope).cacheIdentity).prefixDigest, 'the two turns must share the same identity fingerprint for this regression to be meaningful');
    assert.notEqual(assertTestRecord(first.receipt).sessionLineageId, assertTestRecord(second.receipt).sessionLineageId);
  });
});

test('the provider launcher receives only the six-field prompt projection', async () => {
  // Regression: the raw persisted executionCapsule used to reach the
  // launcher, and a caller-supplied modelVisiblePrompt could bypass the
  // projection boundary.
  await withRun(async (cp: TestControlPlane, runId: string) => {
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
    assert.deepEqual(Object.keys(assertTestRecord(assertTestRecord(seenProviderInput).modelVisiblePrompt)), [...MODEL_VISIBLE_PROMPT_FIELDS]);
    assert.deepEqual(assertTestRecord(seenProviderInput).prompt, assertTestRecord(seenProviderInput).modelVisiblePrompt);
    for (const forbidden of ['executionContract', 'executionCapsule', 'role', 'permissions', 'nonGoals', 'envelope', 'control', 'modelPolicy', 'reviewSubject']) {
      assert.equal(Object.hasOwn(seenProviderInput, forbidden), false, `provider input leaked ${forbidden}`);
      assert.equal(Object.hasOwn(assertTestRecord(assertTestRecord(seenProviderInput).invocation), forbidden), false, `provider invocation leaked ${forbidden}`);
    }
    assert.doesNotMatch(assertTestString(assertTestRecord(seenProviderInput).message), /executionContract|executionCapsule|"role"|"permissions"|"nonGoals"/);
    // The full, unprojected capsule is still what the receipt's lineage uses.
    assert.ok(assertTestPresent(result.executionCapsule).capsuleId);
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
  const compatibilityInput1 = {
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
  };
    const result = await adapter.dispatch(compatibilityInput1);
  assert.equal(result.status, 'completed');
  assert.deepEqual(Object.keys(assertTestRecord(seen)).sort(), ['message', 'modelVisiblePrompt', 'prompt']);
  assert.deepEqual(assertTestRecord(assertTestRecord(seen).modelVisiblePrompt).requiredEvidence, [{ obligationId: 'fable-proof' }]);
  assert.doesNotMatch(assertTestString(assertTestRecord(seen).message), /executionContract|capsuleId|mutationRevision|routeDecision|provider|lease|control|modelPolicy/u);
});

test('Host Dispatcher owns the one equivalent transport retry after a pure pre-spawn failure', async () => {
  await withRun(async (cp: TestControlPlane, runId: string) => {
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
          resolvedModel: assertTestRecord(invocation).model,
          resolvedEffort: assertTestRecord(invocation).effort,
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
    assert.equal(assertTestRecord(result.dispatch).dispatchMechanism, 'owner-direct');
    assert.equal(assertTestRecord(result.dispatch).fallbackReason, 'pre-spawn-native-transport-failure');
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
  await withRun(async (cp: TestControlPlane, runId: string) => {
    let nextCalls = 0;
    const origNext = cp.next.bind(cp);
    cp.next = async (...args) => {
      nextCalls += 1;
      const res = await origNext(...args);
      assert.ok('action' in res && res.action && 'step' in res.action && res.action.step);
      assert.equal(res.action.type, 'implement');
      res.action.guidance = 'implement bounded work';
      assertTestRecord(res.action.step).allowedPaths = ['src/app.mjs'];
      return res;
    };

    const adapter = {
      surface: 'codex',
      ownerDirectDefault: true,
      nativeDelegationAvailable: true,
      capabilities: { surface: 'codex', nativeSubagent: true, supportsSubagentModel: true },
      dispatch: async ({ invocation }: Parameters<Parameters<typeof dispatchKernelTurn>[0]['adapter']['dispatch']>[0]) => ({
        status: 'completed',
        resultStatus: 'completed',
        resolvedModel: assertTestRecord(invocation).model || 'gpt-5.6-sol',
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
  await withRun(async (cp: TestControlPlane, runId: string) => {
    const stepId = cp.getCurrentStep(runId)?.stepId;
    const snapshot = captureHostExecutionSnapshot({ controlPlane: cp, runId, requestedStepId: stepId });
    assert.ok(snapshot, 'the live run must provide a complete execution snapshot');
    assert.equal(isHostExecutionSnapshotFresh({ controlPlane: cp, runId, snapshot, requestedStepId: stepId }), true);

    const currentIdentity = assertTestPresent(cp.stateStore.getRun(runId)).currentWorkspaceIdentity;
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
  await withRun(async (cp: TestControlPlane, runId: string) => {
    let nextCalls = 0;
    const origNext = cp.next.bind(cp);
    cp.next = async (...args) => {
      nextCalls += 1;
      return origNext(...args);
    };

    let captured = false;
    cp.captureBaseline = async () => {
      captured = true;
      return { status: 'captured', baselineFailures: [], workspaceIdentity: assertTestString(assertTestPresent(await cp.getRun(runId)).currentWorkspaceIdentity), capturedAt: new Date().toISOString(), results: [] };
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

test('B2a: prepareNext and status deduplicate internal verifications, reviews, completionDecision, and command discovery queries', async () => {
  await withRun(async (cp: TestControlPlane, runId: string) => {
    let getVerificationsCalls = 0;
    let listReviewReceiptsCalls = 0;
    let getCompletionDecisionCalls = 0;
    const origGetVerifications = cp.stateStore.getVerifications.bind(cp.stateStore);
    const origListReviewReceipts = cp.stateStore.listReviewReceipts.bind(cp.stateStore);
    const origGetCompletionDecision = cp.stateStore.getCompletionDecision.bind(cp.stateStore);

    cp.stateStore.getVerifications = ((...args: Parameters<typeof origGetVerifications>) => {
      getVerificationsCalls += 1;
      return origGetVerifications(...args);
    }) as typeof origGetVerifications;
    cp.stateStore.listReviewReceipts = ((...args: Parameters<typeof origListReviewReceipts>) => {
      listReviewReceiptsCalls += 1;
      return origListReviewReceipts(...args);
    }) as typeof origListReviewReceipts;
    cp.stateStore.getCompletionDecision = ((...args: Parameters<typeof origGetCompletionDecision>) => {
      getCompletionDecisionCalls += 1;
      return origGetCompletionDecision(...args);
    }) as typeof origGetCompletionDecision;

    try {
      const nextPayload = await cp.next(runId);
      assert.equal(assertTestRecord(nextPayload).runId, runId);
      assert.equal(getVerificationsCalls, 1, `next() must query getVerifications once, got ${getVerificationsCalls}`);
      assert.equal(listReviewReceiptsCalls, 1, `next() must query listReviewReceipts once, got ${listReviewReceiptsCalls}`);
      assert.equal(getCompletionDecisionCalls, 1, `next() must query getCompletionDecision once, got ${getCompletionDecisionCalls}`);

      getVerificationsCalls = 0;
      listReviewReceiptsCalls = 0;
      getCompletionDecisionCalls = 0;

      const statusPayload = await cp.status(runId);
      assert.ok(statusPayload && 'run' in statusPayload);
      assert.equal(getVerificationsCalls, 1, `status() must query getVerifications once, got ${getVerificationsCalls}`);
      assert.equal(listReviewReceiptsCalls, 1, `status() must query listReviewReceipts once, got ${listReviewReceiptsCalls}`);
      assert.equal(getCompletionDecisionCalls, 1, `status() must query getCompletionDecision once, got ${getCompletionDecisionCalls}`);
    } finally {
      cp.stateStore.getVerifications = origGetVerifications;
      cp.stateStore.listReviewReceipts = origListReviewReceipts;
      cp.stateStore.getCompletionDecision = origGetCompletionDecision;
    }
  });
});

type TestControlPlane = Awaited<ReturnType<typeof import('../src/host/kernel/control-plane-runtime.js').createKernelControlPlane>>;
type TestStateStore = Awaited<ReturnType<typeof import('../src/kernel/state-store.js').openKernelStateStore>>;


test('Native command events bind to the Canonical Attempt without treating a handle as an OS PID', () => {
  const owner = { runId: 'run-a', stepId: 'step-a', attemptId: 'attempt-a', workspaceId: 'workspace-a' };
  const startedTurn = { threadId: 'thread-a', turnId: 'turn-a' };
  const valid = bindNativeCommandEvent(owner, {
    method: 'item/started',
    params: {
      threadId: 'thread-a',
      turnId: 'turn-a',
      item: { type: 'commandExecution', id: 'item-a', processId: 1454 },
      owner: { attemptId: 'forged-attempt', workspaceId: 'forged-workspace' },
    },
  }, startedTurn);
  assert.deepEqual(valid, { ...owner, method: 'item/started', threadId: 'thread-a', turnId: 'turn-a', itemId: 'item-a', processId: '1454' });
  assert.equal(bindNativeCommandEvent(owner, { method: 'item/started', params: { threadId: 'thread-a', turnId: 'turn-a', item: { type: 'reasoning', id: 'item-a', processId: 1454 } } }, startedTurn), null);
  assert.equal(bindNativeCommandEvent(owner, { method: 'item/started', params: { threadId: 'thread-a', item: { type: 'commandExecution', id: 'item-a', processId: 1454 } } }, startedTurn), null);
  assert.equal(bindNativeCommandEvent(owner, { method: 'turn/completed', params: { threadId: 'thread-a', turnId: 'turn-a', item: { type: 'commandExecution', id: 'item-a', processId: 1454 } } }, startedTurn), null);
  assert.equal(bindNativeCommandEvent(owner, { method: 'item/completed', params: { threadId: 'thread-a', turnId: 'turn-a', item: { type: 'commandExecution', id: 'item-a', processId: -1 } } }, startedTurn)?.processId, null);
  assert.equal(bindNativeCommandEvent(owner, { method: 'item/started', params: { threadId: 'other-thread', turnId: 'turn-a', item: { type: 'commandExecution', id: 'item-a', processId: 1454 } } }, startedTurn), null);
  assert.equal(bindNativeCommandEvent(owner, { method: 'item/started', params: { threadId: 'thread-a', turnId: 'other-turn', item: { type: 'commandExecution', id: 'item-a', processId: 1454 } } }, startedTurn), null);
  assert.equal(bindNativeCommandEvent(owner, { method: 'item/started', params: { threadId: 'thread-a', turnId: 'turn-a', item: { type: 'commandExecution', id: 'item-a', processId: 1454 } } }, null), null);
});

test('Host-owned Native observation binds live events to the existing Attempt and does not confer termination authority', async () => {
  await withRun(async (cp: TestControlPlane, runId: string) => {
    const seen: NativeExecutionObservation[] = [];
    let dispatchedOwner: Record<string, unknown> | null = null;
    const adapter = createCodexAdapter({
      parentSessionObserver: async ({ parentSessionId }) => ({
        sessionId: parentSessionId, model: 'owner-selected-model', effort: 'high',
      }),
      nativeLaunch: async ({ invocation, executionOwner, observeNativeExecutionEvent, message }) => {
        dispatchedOwner = assertTestRecord(executionOwner);
        assert.ok(typeof observeNativeExecutionEvent === 'function');
        const report = observeNativeExecutionEvent as (event: unknown, startedTurn: { threadId: string; turnId: string }) => void;
        const startedTurn = { threadId: 'native-thread', turnId: 'native-turn' };
        report({
          method: 'item/started',
          params: {
            threadId: 'native-thread',
            turnId: 'native-turn',
            item: { type: 'commandExecution', id: 'native-item', processId: 1454 },
          },
        }, startedTurn);
        // Non-command events and incomplete handles cannot produce a trusted
        // command owner. The native handle 1454 is not an OS PID.
        report({ method: 'item/started', params: {
          threadId: 'native-thread', turnId: 'native-turn',
          item: { type: 'reasoning', id: 'reasoning-item', processId: 1024 },
        } }, startedTurn);
        report({ method: 'item/started', params: {
          threadId: 'other-thread', turnId: 'native-turn',
          item: { type: 'commandExecution', id: 'misrouted-item', processId: 2048 },
        } }, startedTurn);
        assert.doesNotMatch(String(message), /attemptId|workspaceId|executionOwner/u);
        const requested = assertTestRecord(invocation);
        return {
          resolvedModel: requested.model,
          resolvedEffort: requested.effort,
          observedSessionConfig: { model: requested.model, effort: requested.effort },
          effortObserved: true,
          sessionId: 'isolated-native-session',
        };
      },
    });
    const dispatched = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter,
      registry: createModelRegistry({ surface: 'codex', env: FRONTIER_ENV }),
      parentSessionId: 'codex-parent-session',
      actionContext: { executionMode: 'native-subagent', delegationRequested: true },
      onNativeExecution: (observation) => { seen.push(observation); },
    });
    const actualOwner = assertTestRecord(dispatchedOwner);
    assert.ok(actualOwner.attemptId, 'the Host must pass a canonical owner to a Native launcher');
    assert.equal(seen.length, 1, 'only a matching commandExecution event is observable');
    assert.equal(seen[0].runId, runId);
    assert.equal(seen[0].attemptId, actualOwner.attemptId);
    assert.equal(seen[0].stepId, actualOwner.stepId);
    assert.equal(seen[0].workspaceId, actualOwner.workspaceId);
    assert.ok(typeof seen[0].attemptId === 'string' && seen[0].attemptId);
    assert.ok(typeof seen[0].workspaceId === 'string' && seen[0].workspaceId);
    assert.equal(seen[0].threadId, 'native-thread');
    assert.equal(seen[0].turnId, 'native-turn');
    assert.equal(seen[0].itemId, 'native-item');
    assert.equal(seen[0].processId, '1454');
    assert.equal('osPid' in seen[0], false);
    assert.equal('writerTerminated' in seen[0], false);
    assert.equal('writerFenced' in seen[0], false);
  });
});

test('P1: buildTurnPromptEnvelope separates projectStable knowledge from volatile taskKnowledge across step transitions', async () => {
  await withRun(async (cp: TestControlPlane, runId: string) => {
    const run = assertTestPresent(await cp.getRun(runId));
    const projectId = assertTestString(run.projectId);
    cp.stateStore.saveKnowledgeRecord(projectId, 'kr-policy-1', {
      recordType: 'policy_anchor',
      status: 'committed',
      trustTier: 'authoritative',
      recordJson: {
        id: 'kr-policy-1',
        type: 'policy_anchor',
        statement: 'All state transitions must be fail-closed',
        status: 'committed',
        trustTier: 'authoritative',
        scope: [],
        isGlobal: true,
      },
    });
    cp.stateStore.saveKnowledgeRecord(projectId, 'kr-constraint-global', {
      recordType: 'ontology_constraint',
      status: 'committed',
      trustTier: 'verified',
      recordJson: {
        id: 'kr-constraint-global',
        type: 'ontology_constraint',
        statement: 'Kernel authority is never delegated to raw provider output',
        severity: 'invariant',
        status: 'committed',
        trustTier: 'verified',
        scope: [],
        isGlobal: true,
      },
    });
    cp.stateStore.saveKnowledgeRecord(projectId, 'kr-constraint-scoped', {
      recordType: 'ontology_constraint',
      status: 'committed',
      trustTier: 'verified',
      recordJson: {
        id: 'kr-constraint-scoped',
        type: 'ontology_constraint',
        statement: 'Auth paths must verify session lineage',
        severity: 'critical',
        status: 'committed',
        trustTier: 'verified',
        scope: ['src/auth/**'],
        isGlobal: false,
      },
    });
    cp.stateStore.saveKnowledgeRecord(projectId, 'kr-fact-1', {
      recordType: 'semantic_fact',
      status: 'committed',
      trustTier: 'verified',
      recordJson: {
        id: 'kr-fact-1',
        type: 'semantic_fact',
        statement: 'Prompt envelope segments stabilize provider prefix caching',
        status: 'committed',
        trustTier: 'verified',
        scope: ['src/host/**'],
        isGlobal: false,
      },
    });
    cp.stateStore.updateProjectKnowledgeRevision(projectId, 1, 2);

    await cp.refreshStageKnowledge(runId, { stage: 'FRAME', strict: true });
    const firstNext = assertTestRecord(await cp.next(runId));
    const segments = assertTestRecord(firstNext.knowledgeSegments);
    const projectStable = assertTestRecord(segments.projectStable);
    assert.equal(Array.isArray(projectStable.policyAnchors), true);
    assert.equal((projectStable.policyAnchors as unknown[]).length, 1);
    assert.equal(Array.isArray(projectStable.ontologyConstraints), true);
    assert.equal((projectStable.ontologyConstraints as unknown[]).length, 1);
    assert.equal(Array.isArray(segments.taskKnowledge), true);
    assert.ok((segments.taskKnowledge as unknown[]).length >= 1);

    const decision = { runId, role: 'implementer', actionKind: 'implement', riskTier: 'T1', modelClass: 'value_coding' };
    const resolution = { model: 'model-a', effort: 'high', executionClass: 'standard', modelClass: 'value_coding', surface: 'claude', source: 'profile-config', enforcementIntent: 'enforced' } as const;
    const firstEnvelope = buildTurnPromptEnvelope({
      modelInput: firstNext,
      decision,
      resolution,
      hostCapabilities: { surface: 'claude' },
    });
    const findSeg = (env: typeof firstEnvelope, kind: string) => assertTestPresent(env.segments.find((s) => s.kind === kind));
    const firstProjSeg = findSeg(firstEnvelope, 'project-stable');
    const firstVolSeg = findSeg(firstEnvelope, 'volatile');
    assert.match(firstProjSeg.content, /All state transitions must be fail-closed/);
    assert.match(firstProjSeg.content, /Kernel authority is never delegated to raw provider output/);
    assert.doesNotMatch(firstProjSeg.content, /Prompt envelope segments stabilize provider prefix caching/);
    assert.match(firstVolSeg.content, /Prompt envelope segments stabilize provider prefix caching/);

    // Simulate a second step/stage turn where volatile taskKnowledge and step change,
    // while projectStable knowledge remains identical.
    const secondNext = {
      ...firstNext,
      knowledgeSegments: {
        projectStable: segments.projectStable,
        taskKnowledge: [{ id: 'kr-fact-2', type: 'semantic_fact', statement: 'Step 2 specific fact' }],
      },
      action: {
        ...assertTestRecord(firstNext.action),
        step: {
          stepId: 'step-2',
          objective: 'Second work unit',
          allowedPaths: ['src/other/**'],
          forbiddenPaths: [],
        },
      },
    };
    const secondEnvelope = buildTurnPromptEnvelope({
      modelInput: secondNext,
      decision,
      resolution,
      hostCapabilities: { surface: 'claude' },
    });
    const secondProjSeg = findSeg(secondEnvelope, 'project-stable');
    const secondVolSeg = findSeg(secondEnvelope, 'volatile');
    assert.equal(firstProjSeg.digest, secondProjSeg.digest);
    assert.equal(firstEnvelope.cacheIdentity.prefixDigest, secondEnvelope.cacheIdentity.prefixDigest);
    assert.notEqual(firstVolSeg.digest, secondVolSeg.digest);
    assert.match(secondVolSeg.content, /Step 2 specific fact/);
  });
});

test('P1: real dispatchKernelTurn preserves byte-identical providerMessage stable prefix across FRAME -> EXECUTE stage and step transitions', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-p1-live-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-p1-live-proj-'));
  spawnSync('git', ['init', '--quiet'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.name', 'P1 Test'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.email', 'p1@example.invalid'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'p1-live-fixture',
    scripts: { test: 'node -e "process.exit(0)"' },
  }));
  await writeFile(path.join(projectRoot, 'step1.txt'), 'v0\n');
  await writeFile(path.join(projectRoot, 'step2.txt'), 'v0\n');
  spawnSync('git', ['add', '.'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['commit', '-m', 'init', '--quiet'], { cwd: projectRoot, encoding: 'utf8' });

  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    const runId = 'r-p1-provider-prefix';
    const started = await cp.startRun({
      runId,
      objective: 'Verify provider message prefix invariance across stages and steps',
      taskContract: {
        complex: true,
        constraints: ['preserve fail-closed invariants'],
        acceptance: [
          { acceptance: 'step 1 updated', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: 'step1-test' } },
          { acceptance: 'step 2 updated', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: 'step2-test' } },
        ],
        steps: [
          { objective: 'Update step1.txt', allowedPaths: ['step1.txt'], acceptanceIds: ['AC-1'], obligationIds: ['step1-test'] },
          { objective: 'Update step2.txt', allowedPaths: ['step2.txt'], acceptanceIds: ['AC-2'], obligationIds: ['step2-test'] },
        ],
      },
    });
    const projectId = assertTestString(started.projectId);
    cp.stateStore.saveKnowledgeRecord(projectId, 'kr-policy-live', {
      recordType: 'policy_anchor',
      status: 'committed',
      trustTier: 'authoritative',
      recordJson: {
        id: 'kr-policy-live',
        type: 'policy_anchor',
        statement: 'Never weaken Kernel completion gates',
        status: 'committed',
        trustTier: 'authoritative',
        scope: [],
        isGlobal: true,
      },
    });
    cp.stateStore.saveKnowledgeRecord(projectId, 'kr-policy-quarantined', {
      recordType: 'policy_anchor',
      status: 'committed',
      trustTier: 'quarantined',
      recordJson: {
        id: 'kr-policy-quarantined',
        type: 'policy_anchor',
        statement: 'FRAME-only quarantined anchor must not pollute projectStable',
        status: 'committed',
        trustTier: 'quarantined',
        scope: [],
        isGlobal: true,
      },
    });
    cp.stateStore.saveKnowledgeRecord(projectId, 'kr-domain-frame-only', {
      recordType: 'domain_term',
      status: 'committed',
      trustTier: 'verified',
      recordJson: {
        id: 'kr-domain-frame-only',
        type: 'domain_term',
        statement: 'Verify provider prefix terminology in FRAME',
        status: 'committed',
        trustTier: 'verified',
        scope: [],
        isGlobal: true,
      },
    });
    cp.stateStore.saveKnowledgeRecord(projectId, 'kr-api-execute-only', {
      recordType: 'api_contract',
      status: 'committed',
      trustTier: 'verified',
      recordJson: {
        id: 'kr-api-execute-only',
        type: 'api_contract',
        statement: 'Verify provider prefix API contract in EXECUTE',
        status: 'committed',
        trustTier: 'verified',
        scope: [],
        isGlobal: true,
      },
    });
    cp.stateStore.updateProjectKnowledgeRevision(projectId, 1, 2);
    await cp.refreshStageKnowledge(runId, { stage: 'FRAME', strict: true });

    const seenMessages: string[] = [];
    const seenPrompts: Record<string, unknown>[] = [];
    const adapter = createClaudeAdapter({
      launch: async (providerInput) => {
        const record = assertTestRecord(providerInput);
        seenMessages.push(assertTestString(record.message));
        seenPrompts.push(assertTestRecord(record.modelVisiblePrompt));
        return {
          resolvedModel: assertTestRecord(record.invocation).model,
          observedModel: assertTestRecord(record.invocation).model,
          resolvedEffort: assertTestRecord(record.invocation).effort,
          observedEffort: assertTestRecord(record.invocation).effort,
          sessionId: `claude-p1-session-${seenMessages.length}`,
        };
      },
    });
    const registry = createModelRegistry({ surface: 'claude', env: FRONTIER_ENV });
    const actionContext = { executionMode: 'native-subagent', delegationRequested: true };

    // Turn 1: Run is in FRAME, executing Step 1
    const turn1 = await dispatchKernelTurn({ controlPlane: cp, runId, adapter, registry, env: FRONTIER_ENV, actionContext });
    assert.equal(turn1.dispatched, true);

    // Complete Step 1 via cp.report -> advances Run state through EXECUTE -> PROVE and Step cursor to Step 2
    await writeFile(path.join(projectRoot, 'step1.txt'), 'v1\n');
    const step1Report = await cp.report(runId, {
      summary: 'completed step 1',
      capsuleId: assertTestPresent(turn1.executionCapsule).capsuleId,
      stepId: assertTestPresent(turn1.executionCapsule).stepId,
      changedPaths: ['step1.txt'],
      verifications: [{ obligationId: 'step1-test', commandRef: 'test' }],
    });
    assert.equal(assertTestRecord(assertTestRecord(step1Report).step).state, 'passed');

    // Move Run into EXECUTE for Step 2 and refresh stage knowledge so stage-dependent facts change
    await cp.refreshStageKnowledge(runId, { stage: 'PROVE', strict: true });
    const turn2 = await dispatchKernelTurn({ controlPlane: cp, runId, adapter, registry, env: FRONTIER_ENV, actionContext });
    assert.equal(turn2.dispatched, true);
    assert.equal(seenMessages.length, 2);

    assert.deepEqual(Object.keys(seenPrompts[0]), [...MODEL_VISIBLE_PROMPT_FIELDS]);
    assert.deepEqual(Object.keys(seenPrompts[0]).slice(0, 4), ['relevantProjectKnowledge', 'objective', 'acceptance', 'constraints']);
    assert.doesNotMatch(JSON.stringify(seenPrompts[0].relevantProjectKnowledge), /Stage:|quarantined|domain_term|api_contract/);
    assert.match(JSON.stringify(seenPrompts[0].relevantProjectKnowledge), /Never weaken Kernel completion gates/);
    assert.match(JSON.stringify(assertTestRecord(seenPrompts[0].currentWork).taskKnowledge), /quarantined|FRAME/);
    assert.doesNotMatch(JSON.stringify(assertTestRecord(seenPrompts[1].currentWork).taskKnowledge || []), /quarantined/);

    const prefix1 = resolveModelVisibleStablePrefix({ prompt: seenPrompts[0], env: FRONTIER_ENV });
    const prefix2 = resolveModelVisibleStablePrefix({ prompt: seenPrompts[1], env: FRONTIER_ENV });
    assert.equal(prefix1, prefix2, 'actual providerMessage stable prefix must stay byte-identical across stages and steps');
    assert.equal(seenMessages[0].startsWith(prefix1), true);
    assert.equal(seenMessages[1].startsWith(prefix2), true);
    assert.notEqual(seenMessages[0], seenMessages[1], 'volatile tail must still reflect step and stage taskKnowledge updates');

    const expectedPrefixTokens = estimateModelVisibleStablePrefixTokens({ prompt: seenPrompts[0], env: FRONTIER_ENV });
    assert.equal(assertTestRecord(turn1.receipt).eligiblePrefixTokens, expectedPrefixTokens);
    assert.equal(assertTestRecord(turn2.receipt).eligiblePrefixTokens, expectedPrefixTokens);
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});
