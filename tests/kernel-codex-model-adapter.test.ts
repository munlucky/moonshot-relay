import { assertTestPresent, assertTestRecord, assertTestString, optionalTestRecord } from './helpers/assert-value.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { CODEX_CAPABILITIES, CODEX_WORKER_OUTPUT_SCHEMA, buildCodexInvocation, createCodexAdapter, selectCodexMechanism } from '../src/host/kernel/adapters/codex.js';
import { resolveModelRoute } from '../src/kernel/run/model-routing.js';
import { buildUsageReceipt } from '../src/host/kernel/usage-receipt.js';
import { isWorkUnitBounded, resolveCodexActorRoute } from '../src/host/kernel/codex-actor-router.js';
import { compareCodexMainSessionInvariance, buildCodexMainSessionPolicy } from '../src/host/kernel/codex-session-observer.js';
import { MODEL_VISIBLE_PROMPT_FIELDS } from '../src/host/kernel/model-capsule-view.js';

const decisionFor = (actionKind: string, riskTier = 'T1') => resolveModelRoute({ runId: 'r-codex', actionKind, riskTier, obligationId: 'default' });
const resolution = (model: string | null) => ({ model, effort: model ? 'high' : null, enforcementIntent: model ? 'enforced' : 'advisory' });
const stableParentObserver = async ({ parentSessionId }: { parentSessionId?: unknown }) => ({
  sessionId: parentSessionId,
  model: 'owner-selected-model',
  effort: 'owner-selected-effort',
});

test('the installed Codex profile still pins no global model', async () => {
  const config = await readFile(new URL('../package/profile-templates/codex/.codex/config.toml', import.meta.url), 'utf8');
  // A global frontier pin would make every cheap implementation turn expensive,
  // which is the exact outcome this routing work exists to avoid.
  assert.equal(/^model\s*=/m.test(config), false);
  assert.equal(/^model_provider\s*=/m.test(config), false);
});

test('model selection happens per worker invocation, in declared capability order', () => {
  const withWorker = { ...CODEX_CAPABILITIES, supportsSubagentModel: true };
  assert.equal(selectCodexMechanism({ capabilities: withWorker, resolution: resolution('m') }), 'worker-model-override');
  assert.equal(selectCodexMechanism({ capabilities: CODEX_CAPABILITIES, resolution: resolution('m') }), 'session-model-override');
  const profileOnly = { ...CODEX_CAPABILITIES, supportsSessionModelOverride: false, supportsLaunchProfile: true };
  assert.equal(selectCodexMechanism({ capabilities: profileOnly, resolution: resolution('m') }), 'launch-profile');
  const neither = { ...CODEX_CAPABILITIES, supportsSessionModelOverride: false, supportsLaunchProfile: false };
  assert.equal(selectCodexMechanism({ capabilities: neither, resolution: resolution('m') }), 'advisory');
  assert.equal(selectCodexMechanism({ capabilities: CODEX_CAPABILITIES, resolution: resolution(null) }), 'host-default');
});

test('the invocation carries the sandbox and approval policy the permissions imply', () => {
  const implement = buildCodexInvocation({ decision: decisionFor('implement'), resolution: resolution('value-model'), capabilities: CODEX_CAPABILITIES });
  assert.equal(implement.sandbox, 'workspace-write');
  assert.equal(implement.approvalPolicy, 'on-failure');
  assert.equal(implement.freshSessionRequired, false);
  assert.equal(implement.profile, 'default');

  const review = buildCodexInvocation({ decision: decisionFor('review_engineering', 'T3'), resolution: resolution('frontier-model'), capabilities: CODEX_CAPABILITIES });
  assert.equal(review.sandbox, 'read-only');
  assert.equal(review.approvalPolicy, 'on-request');
  assert.equal(review.freshSessionRequired, true);
  assert.equal(review.profile, 'review');
});

test('a launch profile is named by the materialized overlay, never by provider model id', () => {
  // Regression: this used to assert 'kernel-frontier'/'kernel-value', names
  // codex-profile-materializer.mjs never writes — a launch-profile dispatch
  // would have requested a profile that does not exist. The profile is now
  // named by the action shape a Kernel model class alone cannot distinguish
  // (a protected review and a routine implementation can share
  // frontier_reasoning), matching the four overlays that actually get written.
  const profileOnly = { ...CODEX_CAPABILITIES, supportsSessionModelOverride: false, supportsLaunchProfile: true };
  const plan = buildCodexInvocation({ decision: decisionFor('plan'), resolution: resolution('m'), capabilities: profileOnly });
  const review = buildCodexInvocation({ decision: decisionFor('review_engineering'), resolution: resolution('m'), capabilities: profileOnly });
  const implement = buildCodexInvocation({ decision: decisionFor('implement'), resolution: resolution('m'), capabilities: profileOnly });
  assert.equal(plan.profile, 'plan');
  assert.equal(review.profile, 'review');
  assert.equal(implement.profile, 'default');
  assert.ok(!/^kernel-/.test(plan.profile));
});

test('Codex reports no usage tokens, so they stay unavailable rather than zero', async () => {
  const adapter = createCodexAdapter({ parentSessionObserver: stableParentObserver, launch: async ({ invocation }) => ({ resolvedModel: assertTestRecord(invocation).model, resolvedEffort: assertTestRecord(invocation).effort, observedSessionConfig: { model: assertTestRecord(invocation).model, effort: assertTestRecord(invocation).effort }, effortObserved: true, sessionId: 'codex-session', wallClockMs: 4200 }) });
  assert.equal(adapter.capabilities.supportsUsageTokens, false);
  const decision = decisionFor('implement');
  const dispatch = await adapter.dispatch({ decision, resolution: resolution('value-model'), strategy: 'session', parentSessionId: 'codex-parent-session', executionContract: {}, executionMode: 'native-subagent', delegationRequested: true });
  const receipt = buildUsageReceipt({ decision, capabilities: adapter.capabilities, strategy: 'session', resolution: resolution('value-model'), dispatch, actorSessionId: dispatch.actorSessionId });
  assert.equal(receipt.enforcementStatus, 'enforced');
  assert.equal(receipt.inputTokens, null);
  assert.equal(receipt.outputTokens, null);
  assert.equal(receipt.wallClockMs, 4200);
});

test('an unresolvable model is advisory and never reported as enforced', async () => {
  const adapter = createCodexAdapter({ parentSessionObserver: stableParentObserver, launch: async () => ({ resolvedModel: 'whatever-the-cli-defaults-to', sessionId: 'codex-session' }) });
  const decision = decisionFor('implement');
  const dispatch = await adapter.dispatch({ decision, resolution: resolution(null), strategy: 'session', parentSessionId: 'codex-parent-session', executionContract: {}, executionMode: 'native-subagent', delegationRequested: true });
  assert.equal(assertTestPresent(dispatch.invocation).mechanism, 'host-default');
  const receipt = buildUsageReceipt({ decision, capabilities: adapter.capabilities, strategy: 'session', resolution: resolution(null), dispatch, actorSessionId: 'codex-session' });
  assert.equal(receipt.enforcementStatus, 'advisory');
});

test('the Codex actor route keeps owner-direct as the default while preserving fresh-session intent', () => {
  const route = resolveCodexActorRoute({
    decision: { role: 'implementer', actionKind: 'debug', workProfile: { repeatedFailure: true } },
    invocation: { model: 'gpt-5.6-sol', effort: 'xhigh', freshSessionRequired: true, mechanism: 'session-model-override' },
    capabilities: CODEX_CAPABILITIES,
  });
  assert.equal(route.role, 'debugger');
  assert.equal(route.dispatchMechanism, 'owner-direct');
  assert.equal(route.sessionPolicy, 'fresh');
  assert.equal(route.ownerDirectAllowed, true);
  assert.equal(route.executionMode, 'owner-direct');
  assert.deepEqual(route.delegation, { mode: 'optional', available: false, requested: false });
  assert.deepEqual(route.execution, { role: 'debugger', mode: 'owner-direct', delegation: 'optional' });
});

test('the main Codex session invariance guard requires identity stability, not a model or effort pin', () => {
  const stable = compareCodexMainSessionInvariance({
    expectedSessionId: 'main-session',
    before: { sessionId: 'main-session', model: 'gpt-5.6-sol', effort: 'high' },
    after: { sessionId: 'main-session', model: 'gpt-5.6-luna', effort: 'max' },
  });
  assert.equal(stable.exact, true);
  const changed = compareCodexMainSessionInvariance({
    expectedSessionId: 'main-session',
    before: { sessionId: 'main-session', model: 'gpt-5.6-sol', effort: 'high' },
    after: { sessionId: 'other-session', model: 'gpt-5.6-luna', effort: 'max' },
  });
  assert.equal(changed.exact, false);
  assert.equal(changed.reason, 'after-parent-session-not-stable');
});

test('a parent session observation mismatch blocks Codex work before the launcher runs', async () => {
  let launched = false;
  const adapter = createCodexAdapter({
    launch: async () => { launched = true; return {}; },
  });
  const dispatch = await adapter.dispatch({
    decision: decisionFor('implement'),
    resolution: resolution('gpt-5.6-luna'),
    parentSessionId: 'main-session',
    parentSessionConfig: {
      before: { sessionId: 'main-session', model: 'gpt-5.6-sol', effort: 'high' },
      after: { sessionId: 'other-session', model: 'gpt-5.6-luna', effort: 'max' },
    },
    executionContract: {},
    executionMode: 'native-subagent', delegationRequested: true,
  });
  assert.equal(launched, false);
  assert.equal(dispatch.status, 'failed');
  assert.equal(dispatch.errorCode, 'parent-session-invariant-failed');
  assert.match(assertTestString(dispatch.enforcementReason), /parent-session-not-stable/);
});

test('missing parent session telemetry is an actionable unsupported capability, not a model-policy failure', async () => {
  let launched = false;
  const adapter = createCodexAdapter({
    parentSessionObserver: async () => null,
    launch: async () => {
      launched = true;
      return {};
    },
  });
  const dispatch = await adapter.dispatch({
    decision: decisionFor('implement'),
    resolution: { model: 'gpt-5.6-luna', effort: 'max', enforcementIntent: 'enforced' },
    parentSessionId: 'external-node-parent',
    executionContract: {},
    executionMode: 'native-subagent', delegationRequested: true,
  });
  assert.equal(launched, false);
  assert.equal(dispatch.status, 'unsupported');
  assert.equal(dispatch.resultStatus, 'failed');
  assert.equal(dispatch.enforcementStatus, 'unsupported');
  assert.equal(dispatch.errorCode, 'codex-host-capability-unsupported');
  assert.equal(dispatch.outcome, null);
  assert.equal(dispatch.actorSessionId, null);
  assert.equal(assertTestPresent(dispatch.capability).capability, 'parent-session-telemetry');
  assert.match(assertTestPresent(dispatch.capability).remediation, /native Codex Host bridge|before\/after parent session observations/);
});

test('owner model and effort telemetry may be absent while session identity remains enforced', () => {
  const observed = buildCodexMainSessionPolicy({
    parentSessionId: 'main-session',
    observed: { sessionId: 'main-session', model: 'gpt-5.6-sol' },
  });
  assert.equal(observed.observationStatus, 'observed');
  assert.equal(observed.capability, null);
  assert.equal(observed.observedModel, 'gpt-5.6-sol');
  assert.equal(observed.observedEffort, null);

  const mismatch = buildCodexMainSessionPolicy({
    parentSessionId: 'main-session',
    observed: { sessionId: 'other-session', model: 'gpt-5.6-sol', effort: 'high' },
  });
  assert.equal(mismatch.observationStatus, 'failed');
  assert.equal(mismatch.capability, null);
});

test('the production native launcher sends explicit model and effort and observes parent invariance around the child', async () => {
  const parentPhases: unknown[] = [];
  let request: unknown = null;
  const nativeAgentHost = {
    spawn_agent: async (payload: Record<string, unknown>) => {
      request = payload;
      return {
        session_id: 'native-child-session',
        status: 'completed',
        terminalEvents: [
          { type: 'turn.completed', model: 'gpt-5.6-luna', reasoning_effort: 'max' },
        ],
        outcome: {
          status: 'completed',
          summary: 'native worker completed',
          changedPaths: ['src/worker.mjs'],
          risks: [],
          requestedVerifications: [],
          judgments: [],
          knowledgeObservations: [],
          blocker: null,
        },
      };
    },
  };
  const adapter = createCodexAdapter({
    nativeAgentHost,
    parentSessionObserver: async ({ parentSessionId, phase }) => {
      parentPhases.push(phase);
      return { sessionId: parentSessionId, model: 'owner-selected-model', effort: 'owner-selected-effort' };
    },
  });
  const dispatch = await adapter.dispatch({
    decision: decisionFor('implement'),
    resolution: { model: 'gpt-5.6-luna', effort: 'max', enforcementIntent: 'enforced' },
    parentSessionId: 'main-session',
    executionContract: { permissions: 'workspace_write' },
    workingDirectory: '/workspace/worker',
    concurrencyGroup: 'run-1',
    childSession: { canDelegate: false, canCommit: false },
    executionMode: 'native-subagent', delegationRequested: true,
  });
  assert.deepEqual(parentPhases, ['before', 'after']);
  assert.equal(assertTestRecord(request).task_name, 'kernel_implementer');
  assert.equal(assertTestRecord(request).model, 'gpt-5.6-luna');
  assert.equal(assertTestRecord(request).reasoning_effort, 'max');
  assert.equal(assertTestRecord(request).working_directory, '/workspace/worker');
  assert.equal(assertTestRecord(request).concurrency_group, 'run-1');
  assert.deepEqual(assertTestRecord(request).child_session, { canDelegate: false, canCommit: false });
  assert.equal(dispatch.dispatchMechanism, 'native-subagent');
  assert.equal(dispatch.status, 'completed');
  assert.equal(dispatch.enforcementStatus, 'enforced');
  assert.equal(assertTestRecord(dispatch.parentSessionPolicy).observationStatus, 'enforced');
  assert.equal(assertTestRecord(dispatch.parentSessionPolicy).observedModel, 'owner-selected-model');
  assert.equal(dispatch.actorSessionId, 'native-child-session');
});

test('native reviewer dispatch uses the read-only review contract and schema', async () => {
  let request: unknown = null;
  const adapter = createCodexAdapter({
    nativeAgentHost: {
      spawn_agent: async (payload) => {
        request = payload;
        return {
          session_id: 'native-reviewer-session',
          terminalEvents: [{ type: 'turn.completed', model: 'gpt-5.6-sol', reasoning_effort: 'high' }],
          outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://native'] },
        };
      },
    },
    parentSessionObserver: stableParentObserver,
  });
  const dispatch = await adapter.dispatch({
    decision: decisionFor('review_engineering', 'T3'),
    resolution: { model: 'gpt-5.6-sol', effort: 'high', enforcementIntent: 'enforced' },
    parentSessionId: 'main-session',
    executionContract: { permissions: 'read_only' },
    executionMode: 'native-subagent', delegationRequested: true,
  });
  assert.equal(dispatch.status, 'completed');
  assert.equal(assertTestRecord(assertTestPresent(dispatch.outcome)).verdict, 'pass');
  assert.match(assertTestString(assertTestRecord(request).message), /independent Kernel review/i);
  assert.doesNotMatch(assertTestString(assertTestRecord(request).message), /bounded Kernel worker action/i);
});

test('captured Codex provider message is reprojected to the six-field prompt contract', async () => {
  let request: unknown = null;
  const adapter = createCodexAdapter({
    nativeAgentHost: {
      spawn_agent: async (payload) => {
        request = payload;
        return {
          session_id: 'native-prompt-session',
          terminalEvents: [{ type: 'turn.completed', model: 'gpt-5.6-luna', reasoning_effort: 'high' }],
          outcome: {
            status: 'completed',
            summary: 'prompt contract checked',
            changedPaths: [],
            risks: [],
            requestedVerifications: [],
            judgments: [],
            knowledgeObservations: [],
            blocker: null,
          },
        };
      },
    },
    parentSessionObserver: stableParentObserver,
  });
  const modelInput = {
    objective: 'caller objective',
    acceptance: ['caller acceptance'],
    constraints: ['caller constraint'],
    knowledge: ['caller knowledge'],
    requiredEvidence: [{ obligationId: 'caller-obligation' }],
    action: {
      type: 'implement',
      guidance: 'caller guidance',
      step: {
        objective: 'caller step',
        allowedPaths: ['src/**'],
        forbiddenPaths: ['secrets/**'],
        expectedOutputs: ['source'],
      },
    },
  };
  const compatibilityInput1 = {
    decision: decisionFor('implement'),
    resolution: { model: 'gpt-5.6-luna', effort: 'high', enforcementIntent: 'enforced' },
    modelInput,
    executionCapsule: {
      capsuleId: 'capsule-host-only',
      role: 'reviewer',
      permissions: { filesystem: 'read_only' },
      nonGoals: ['host-only value'],
      objective: 'capsule objective',
      workUnit: { objective: 'capsule step', allowedPaths: ['wrong/**'] },
      repositoryContext: { knowledgeRecords: ['host-only knowledge'] },
      verification: { obligations: [{ obligationId: 'host-only-obligation' }] },
      mutationRevision: 99,
      provenance: { capsuleDigest: 'host-only-digest' },
    },
    modelVisiblePrompt: { executionContract: 'caller bypass', role: 'attacker', permissions: 'write' },
    executionContract: { role: 'reviewer', permissions: 'read_only', nonGoals: ['must not leak'] },
    parentSessionId: 'main-session',
    executionMode: 'native-subagent',
    delegationRequested: true,
  };
    const dispatch = await adapter.dispatch(compatibilityInput1);

  assert.equal(dispatch.status, 'completed');
  const marker = 'MODEL VISIBLE CONTEXT\n';
  const visible = JSON.parse(assertTestString(assertTestRecord(request).message).slice(assertTestString(assertTestRecord(request).message).indexOf(marker) + marker.length));
  assert.deepEqual(Object.keys(visible), [...MODEL_VISIBLE_PROMPT_FIELDS]);
  assert.equal(visible.objective, 'caller objective');
  assert.deepEqual(visible.currentWork.allowedPaths, ['src/**']);
  assert.doesNotMatch(assertTestString(assertTestRecord(request).message), /executionContract|executionCapsule|execution_contract|execution_capsule|"role"|"permissions"|"nonGoals"/);
  for (const forbidden of ['execution_contract', 'execution_capsule', 'role', 'permissions', 'nonGoals', 'envelope', 'control', 'modelPolicy', 'reviewSubject']) {
    assert.equal(Object.hasOwn(assertTestRecord(request), forbidden), false, `provider request leaked ${forbidden}`);
  }
});

test('a parent session identity change observed after child execution fails the whole dispatch closed', async () => {
  let phase: unknown = null;
  let launched = false;
  const adapter = createCodexAdapter({
    parentSessionObserver: async ({ parentSessionId, phase: currentPhase }) => {
      phase = currentPhase;
      return {
        model: currentPhase === 'before' ? 'gpt-5.6-sol' : 'gpt-5.6-luna',
        effort: currentPhase === 'before' ? 'high' : 'max',
        sessionId: currentPhase === 'before' ? parentSessionId : 'other-session',
      };
    },
    launch: async ({ invocation }) => {
      launched = true;
      return { resolvedModel: assertTestRecord(invocation).model, resolvedEffort: assertTestRecord(invocation).effort, observedSessionConfig: { model: assertTestRecord(invocation).model, effort: assertTestRecord(invocation).effort }, sessionId: 'worker-session' };
    },
  });
  const dispatch = await adapter.dispatch({
    decision: decisionFor('implement'),
    resolution: { model: 'gpt-5.6-luna', effort: 'max', enforcementIntent: 'enforced' },
    parentSessionId: 'main-session',
    executionContract: {},
    executionMode: 'native-subagent', delegationRequested: true,
  });
  assert.equal(launched, true);
  assert.equal(phase, 'after');
  assert.equal(dispatch.status, 'failed');
  assert.equal(dispatch.errorCode, 'parent-session-invariant-failed');
  assert.match(assertTestString(dispatch.enforcementReason), /after-parent-session-not-stable/);
});

test('the default Host observer proves the canonical parent rollout before and after a child dispatch', async () => {
  const parentCodexHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-codex-parent-rollout-'));
  const providerCodexHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-codex-provider-rollout-'));
  const threadId = '01234567-89ab-cdef-0123-456789abcdef';
  const now = new Date();
  const sessionsDir = path.join(parentCodexHome, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(path.join(sessionsDir, `rollout-${threadId}.jsonl`), [
    JSON.stringify({ type: 'session_meta', payload: { session_id: threadId } }),
    JSON.stringify({ type: 'turn_context', model: 'owner-selected-model', reasoning_effort: 'owner-selected-effort' }),
  ].join('\n'));
  let childEnvironment: unknown = null;
  try {
    const adapter = createCodexAdapter({
      env: { CODEX_HOME: providerCodexHome },
      parentSessionEnvironment: { CODEX_HOME: parentCodexHome },
      launch: async ({ invocation, environment }) => {
        childEnvironment = environment;
        return { resolvedModel: assertTestRecord(invocation).model, resolvedEffort: assertTestRecord(invocation).effort, observedSessionConfig: { model: assertTestRecord(invocation).model, effort: assertTestRecord(invocation).effort }, sessionId: 'codex:worker-child' };
      },
    });
    const dispatch = await adapter.dispatch({
      decision: decisionFor('implement'),
      resolution: { model: 'gpt-5.6-luna', effort: 'max', enforcementIntent: 'enforced' },
      parentSessionId: `codex:${threadId}`,
      executionContract: {},
      environment: { CODEX_HOME: providerCodexHome },
      executionMode: 'native-subagent', delegationRequested: true,
    });
    assert.equal(dispatch.status, 'completed');
    assert.equal(assertTestRecord(dispatch.parentSessionPolicy).observationStatus, 'enforced');
    assert.equal(assertTestRecord(dispatch.parentSessionPolicy).observedSessionId, `codex:${threadId}`);
    assert.equal(assertTestRecord(childEnvironment).CODEX_HOME, providerCodexHome);
    assert.notEqual(assertTestRecord(childEnvironment).CODEX_HOME, parentCodexHome);
  } finally {
    await rm(parentCodexHome, { recursive: true, force: true });
    await rm(providerCodexHome, { recursive: true, force: true });
  }
});

test('an explicitly delegated Codex launcher cannot silently execute in the parent session', async () => {
  const adapter = createCodexAdapter({
    parentSessionObserver: stableParentObserver,
    launch: async ({ invocation }) => ({
      resolvedModel: assertTestRecord(invocation).model,
      resolvedEffort: assertTestRecord(invocation).effort,
      effortObserved: true,
      sessionId: 'main-session',
    }),
  });
  const dispatch = await adapter.dispatch({
    decision: decisionFor('implement'),
    resolution: resolution('gpt-5.6-luna'),
    parentSessionId: 'main-session',
    executionContract: {},
    executionMode: 'native-subagent', delegationRequested: true,
  });
  assert.equal(dispatch.dispatchMechanism, 'native-subagent');
  assert.equal(dispatch.status, 'failed');
  assert.equal(dispatch.enforcementReason, 'worker-session-not-distinct');
});

test('a Codex launcher failure stays a dispatch failure instead of becoming telemetry unsupported', async () => {
  const adapter = createCodexAdapter({
    parentSessionObserver: stableParentObserver,
    launch: async () => {
      throw new Error("invalid_json_schema: Missing 'verifications'");
    },
  });
  const dispatch = await adapter.dispatch({
    decision: decisionFor('implement'),
    resolution: resolution('gpt-5.6-luna'),
    parentSessionId: 'main-session',
    executionContract: {},
    executionMode: 'native-subagent', delegationRequested: true,
  });
  assert.equal(dispatch.dispatchMechanism, 'native-subagent');
  assert.equal(dispatch.status, 'failed');
  assert.equal(dispatch.resultStatus, 'failed');
  assert.equal(dispatch.enforcementStatus, 'failed');
  assert.equal(dispatch.enforcementReason, 'codex-launch-failed');
  assert.equal(dispatch.errorCode, 'codex-launch-failed');
  assert.match(assertTestString(dispatch.errorSummary), /invalid_json_schema/);
});

test('a native model mismatch fails a mutating dispatch directly without CLI fallback', async () => {
  const calls: unknown[] = [];
  const workerRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-codex-native-mismatch-'));
  const marker = path.join(workerRoot, 'native-marker');
  try {
    const adapter = createCodexAdapter({
      parentSessionObserver: stableParentObserver,
      capabilities: { supportsSubagentModel: true },
      nativeLaunch: async ({ workingDirectory }) => {
        calls.push('native');
        await writeFile(path.join(assertTestString(workingDirectory), 'native-marker'), 'native touched the workspace');
        return { resolvedModel: 'gpt-5.6-sol', resolvedEffort: 'high', observedSessionConfig: { model: 'gpt-5.6-sol', effort: 'high' }, effortObserved: true, sessionId: 'native-session' };
      },
    });
    const dispatch = await adapter.dispatch({
      decision: resolveModelRoute({ runId: 'r-codex-fallback', actionKind: 'implement', complexity: 'standard' }),
      resolution: { model: 'gpt-5.6-luna', effort: 'max', enforcementIntent: 'enforced' },
      parentSessionId: 'parent-session',
      workingDirectory: workerRoot,
      executionContract: {},
      executionMode: 'native-subagent', delegationRequested: true,
    });
    assert.deepEqual(calls, ['native']);
    assert.equal(dispatch.status, 'failed');
    assert.equal(dispatch.dispatchMechanism, 'native-subagent');
    assert.equal(dispatch.errorCode, 'model-enforcement-failed');
    assert.equal(await readFile(marker, 'utf8'), 'native touched the workspace');
  } finally {
    await rm(workerRoot, { recursive: true, force: true });
  }
});

test('when native observation mismatches the dispatch fails closed', async () => {
  const adapter = createCodexAdapter({
    parentSessionObserver: stableParentObserver,
    capabilities: { supportsSubagentModel: true },
    nativeLaunch: async () => ({ resolvedModel: 'wrong-model', resolvedEffort: 'low', observedSessionConfig: { model: 'wrong-model', effort: 'low' }, effortObserved: true, sessionId: 'native-session' }),
  });
  const dispatch = await adapter.dispatch({
    decision: resolveModelRoute({ runId: 'r-codex-failed', actionKind: 'implement' }),
    resolution: { model: 'gpt-5.6-luna', effort: 'max', enforcementIntent: 'enforced' },
    parentSessionId: 'parent-session',
    executionContract: {},
    executionMode: 'native-subagent', delegationRequested: true,
  });
  assert.equal(dispatch.status, 'failed');
  assert.equal(dispatch.errorCode, 'model-enforcement-failed');
  assert.equal(dispatch.enforcementReason, 'model-mismatch');
});

test('a Codex adapter without a native launcher returns owner-direct intent, not a worker blocker', async () => {
  let parentObserved = false;
  const adapter = createCodexAdapter({
    parentSessionObserver: async () => {
      parentObserved = true;
      return null;
    },
  });
  const dispatch = await adapter.dispatch({
    decision: decisionFor('implement'),
    resolution: resolution('gpt-5.6-luna'),
    parentSessionId: 'owner-session',
    executionCapsule: { capsuleId: 'capsule-test' },
    executionContract: { role: 'implementer', permissions: 'workspace_write' },
  });
  assert.equal(parentObserved, false, 'owner-direct must not require parent telemetry');
  assert.equal(dispatch.status, 'owner-direct');
  assert.equal(dispatch.resultStatus, 'interrupted');
  assert.equal(dispatch.dispatchMechanism, 'owner-direct');
  assert.equal(assertTestRecord(dispatch).executionMode, 'owner-direct');
  assert.deepEqual(assertTestRecord(dispatch).delegation, { mode: 'optional', available: false, actorRole: 'implementer' });
  assert.equal(dispatch.outcome, null);
  assert.equal(dispatch.report, null);
  assert.equal(dispatch.errorCode, null);
});

test('a Codex adapter without a native launcher blocks only a required independent review', async () => {
  const dispatch = await createCodexAdapter().dispatch({
    decision: {
      ...decisionFor('review_engineering', 'T3'),
      role: 'reviewer',
      independentContextRequired: true,
    },
    resolution: { model: 'gpt-5.6-sol', effort: 'xhigh', enforcementIntent: 'enforced' },
    executionContract: { role: 'reviewer', independentReviewRequired: true },
  });
  assert.equal(dispatch.status, 'review-required');
  assert.equal(dispatch.resultStatus, 'interrupted');
  assert.equal(dispatch.errorCode, null);
  assert.equal(dispatch.capability, null);
  assert.equal(assertTestRecord(dispatch).executionMode, 'independent-review');
  assert.deepEqual(assertTestRecord(dispatch).delegation, { mode: 'required', available: false, requested: false, actorRole: 'reviewer' });
  assert.equal(assertTestRecord(assertTestRecord(dispatch).review).status, 'pending');
});

test('pre-spawn observed session config counts as provider execution evidence', async () => {
  const adapter = createCodexAdapter({
    parentSessionObserver: stableParentObserver,
    nativeLaunch: async () => ({
      status: 'failed',
      resultStatus: 'failed',
      errorCode: 'transport-unavailable',
      failureCategory: 'provider/infrastructure',
      failureStage: 'pre-spawn',
      observedSessionConfig: { model: 'gpt-5.6-sol', effort: 'xhigh' },
    }),
  });
  const dispatch = await adapter.dispatch({
    decision: decisionFor('review_engineering', 'T3'),
    resolution: { model: 'gpt-5.6-sol', effort: 'xhigh', enforcementIntent: 'enforced' },
    parentSessionId: 'review-owner',
    executionContract: { role: 'reviewer', permissions: 'read_only', independentReviewRequired: true },
    executionMode: 'native-subagent',
    delegationRequested: true,
  });
  assert.equal(dispatch.status, 'failed');
  assert.equal(dispatch.errorCode, 'transport-unavailable');
  assert.equal(optionalTestRecord(assertTestRecord(dispatch).launcherFailure)?.providerExecutionEvidence, true);
  assert.equal(assertTestRecord(dispatch).runtimePreflight, null);
});

test('Correction 1: mutation action + bounded capsule + capable host -> native worker selected automatically', async () => {
  let launched = false;
  let receivedChildSession: unknown = null;
  const adapter = createCodexAdapter({
    parentSessionObserver: stableParentObserver,
    nativeLaunch: async ({ invocation, childSession }) => {
      launched = true;
      receivedChildSession = childSession;
      return {
        status: 'completed',
        resultStatus: 'completed',
        sessionId: 'child-worker-1',
        observedSessionConfig: { model: assertTestRecord(invocation).model, effort: assertTestRecord(invocation).effort },
        outcome: {
          status: 'completed',
          summary: 'implemented step',
          changedPaths: ['src/app.mjs'],
          risks: [],
          verifications: [],
          requestedVerifications: [],
          judgments: [],
          knowledgeObservations: [],
          blocker: null,
        },
      };
    },
  });

  const decision = decisionFor('implement');
  const executionCapsule = {
    stepId: 'step-1',
    workUnit: { stepId: 'step-1', allowedPaths: ['src/app.mjs'] },
  };

  const dispatch = await adapter.dispatch({
    decision,
    resolution: resolution('gpt-5.6-sol'),
    strategy: 'session',
    parentSessionId: 'main-session',
    parentSessionConfig: {
      before: { sessionId: 'main-session', model: 'gpt-5.6-sol', effort: 'high' },
      after: { sessionId: 'main-session', model: 'gpt-5.6-sol', effort: 'high' },
    },
    executionCapsule,
    modelInput: { action: { type: 'implement', step: { stepId: 'step-1', allowedPaths: ['src/app.mjs'] } } },
    executionContract: {},
  });

  assert.equal(launched, true, 'native worker must be launched automatically');
  assert.equal(dispatch.dispatchMechanism, 'native-subagent');
  assert.equal(dispatch.status, 'completed');
  assert.deepEqual(receivedChildSession, {
    canDelegate: false,
    canCommit: false,
    maxNestedAgents: 0,
  });
});

test('Correction 1: read/non-mutating work remains owner-direct even on capable host', async () => {
  let launched = false;
  const adapter = createCodexAdapter({
    parentSessionObserver: stableParentObserver,
    nativeLaunch: async () => { launched = true; return {}; },
  });

  const decision = { ...decisionFor('understand'), role: 'planner' };
  const executionCapsule = {
    stepId: 'step-1',
    workUnit: { stepId: 'step-1', allowedPaths: ['src/app.mjs'] },
  };

  const dispatch = await adapter.dispatch({
    decision,
    resolution: resolution('gpt-5.6-sol'),
    parentSessionId: 'main-session',
    executionCapsule,
    modelInput: { action: { type: 'read' } },
    executionContract: {},
  });

  assert.equal(launched, false, 'read action must not launch native worker');
  assert.equal(dispatch.status, 'owner-direct');
  assert.equal(dispatch.dispatchMechanism, 'owner-direct');
  assert.equal(assertTestRecord(dispatch).executionMode, 'owner-direct');
});

test('Correction 1: post-spawn worker failure does not fall back to owner-direct', async () => {
  let launchAttempts = 0;
  const adapter = createCodexAdapter({
    parentSessionObserver: stableParentObserver,
    nativeLaunch: async () => {
      launchAttempts += 1;
      return {
        status: 'failed',
        resultStatus: 'failed',
        errorCode: 'worker-crashed',
        failureStage: 'post-spawn',
        sessionId: 'failed-child',
      };
    },
  });

  const decision = decisionFor('implement');
  const executionCapsule = {
    stepId: 'step-1',
    workUnit: { stepId: 'step-1', allowedPaths: ['src/app.mjs'] },
  };

  const dispatch = await adapter.dispatch({
    decision,
    resolution: resolution('gpt-5.6-sol'),
    parentSessionId: 'main-session',
    parentSessionConfig: {
      before: { sessionId: 'main-session', model: 'gpt-5.6-sol', effort: 'high' },
      after: { sessionId: 'main-session', model: 'gpt-5.6-sol', effort: 'high' },
    },
    executionCapsule,
    modelInput: { action: { type: 'implement', step: { stepId: 'step-1', allowedPaths: ['src/app.mjs'] } } },
    executionContract: {},
  });

  assert.equal(launchAttempts, 1, 'must attempt worker launch exactly once');
  assert.equal(dispatch.status, 'failed');
  assert.equal(dispatch.dispatchMechanism, 'native-subagent');
  assert.notEqual(dispatch.status, 'owner-direct');
});

test('Correction 1: child worker capabilities strictly keep canDelegate=false, canCommit=false, maxNestedAgents=0', async () => {
  let observedChild: unknown = null;
  const adapter = createCodexAdapter({
    parentSessionObserver: stableParentObserver,
    nativeLaunch: async ({ childSession }) => {
      observedChild = childSession;
      return {
        status: 'completed',
        resultStatus: 'completed',
        sessionId: 'child-1',
        outcome: {
          status: 'completed',
          summary: 'done',
          changedPaths: ['src/app.mjs'],
          risks: [],
          verifications: [],
          requestedVerifications: [],
          judgments: [],
          knowledgeObservations: [],
          blocker: null,
        },
      };
    },
  });

  await adapter.dispatch({
    decision: decisionFor('implement'),
    resolution: resolution('gpt-5.6-sol'),
    parentSessionId: 'main-session',
    parentSessionConfig: {
      before: { sessionId: 'main-session', model: 'gpt-5.6-sol', effort: 'high' },
      after: { sessionId: 'main-session', model: 'gpt-5.6-sol', effort: 'high' },
    },
    executionCapsule: { stepId: 'step-1', workUnit: { stepId: 'step-1', allowedPaths: ['src/app.mjs'] } },
    modelInput: { action: { type: 'implement', step: { stepId: 'step-1', allowedPaths: ['src/app.mjs'] } } },
    childSession: { canDelegate: true, canCommit: true, maxNestedAgents: 5 },
    executionContract: {},
  });

  assert.deepEqual(observedChild, {
    canDelegate: false,
    canCommit: false,
    maxNestedAgents: 0,
  });
});

test('isWorkUnitBounded rejects root wildcards and empty paths while accepting scoped paths', () => {
  assert.equal(isWorkUnitBounded({ stepId: 'step-1', allowedPaths: ['**', 'src/**'] }), false);
  assert.equal(isWorkUnitBounded({ stepId: 'step-1', allowedPaths: ['*', 'src/app.mjs'] }), false);
  assert.equal(isWorkUnitBounded({ stepId: 'step-1', allowedPaths: ['src/**'] }), true);
  assert.equal(isWorkUnitBounded({ stepId: 'step-1', allowedPaths: ['src/app.mjs'] }), true);
  assert.equal(isWorkUnitBounded({ stepId: 'step-1', allowedPaths: [] }), false);
  assert.equal(isWorkUnitBounded({ stepId: null, allowedPaths: ['src/**'] }), false);
  assert.equal(isWorkUnitBounded({ stepId: 'step-1', allowedPaths: ['   '] }), false);
});

test('Correction 4: Codex adapter reports a pure pre-spawn failure without choosing another transport', async () => {
  let nativeAttempts = 0;
  let ownerDirectAttempts = 0;
  const adapter = createCodexAdapter({
    parentSessionObserver: stableParentObserver,
    launch: async ({ invocation }) => {
      ownerDirectAttempts += 1;
      return {
        status: 'completed',
        resultStatus: 'completed',
        resolvedModel: assertTestRecord(invocation).model,
        resolvedEffort: assertTestRecord(invocation).effort,
        sessionId: 'owner-session-1',
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

  const decision = decisionFor('implement');
  const executionCapsule = {
    stepId: 'step-1',
    workUnit: { stepId: 'step-1', allowedPaths: ['src/app.mjs'] },
  };

  const dispatch = await adapter.dispatch({
    decision,
    resolution: resolution('gpt-5.6-sol'),
    parentSessionId: 'main-session',
    parentSessionConfig: {
      before: { sessionId: 'main-session', model: 'gpt-5.6-sol', effort: 'high' },
      after: { sessionId: 'main-session', model: 'gpt-5.6-sol', effort: 'high' },
    },
    executionCapsule,
    modelInput: { action: { type: 'implement', step: { stepId: 'step-1', allowedPaths: ['src/app.mjs'] } } },
    executionContract: {},
  });

  assert.equal(nativeAttempts, 1, 'native worker launch must be attempted');
  assert.equal(ownerDirectAttempts, 0, 'adapter must not choose the owner transport');
  assert.equal(dispatch.dispatchMechanism, 'native-subagent');
  assert.equal(dispatch.fallbackReason, null);
  assert.equal(dispatch.status, 'failed');
});

test('Correction 4: pre-spawn failure with observedSessionConfig does not fall back to owner-direct', async () => {
  let ownerDirectAttempts = 0;
  const adapter = createCodexAdapter({
    parentSessionObserver: stableParentObserver,
    launch: async () => {
      ownerDirectAttempts += 1;
      return { status: 'completed' };
    },
    nativeLaunch: async () => ({
      status: 'failed',
      resultStatus: 'failed',
      errorCode: 'launcher-unavailable',
      failureStage: 'pre-spawn',
      observedSessionConfig: { model: 'gpt-5.6-sol', effort: 'high' },
    }),
  });

  const decision = decisionFor('implement');
  const executionCapsule = {
    stepId: 'step-1',
    workUnit: { stepId: 'step-1', allowedPaths: ['src/app.mjs'] },
  };

  const dispatch = await adapter.dispatch({
    decision,
    resolution: resolution('gpt-5.6-sol'),
    parentSessionId: 'main-session',
    parentSessionConfig: {
      before: { sessionId: 'main-session', model: 'gpt-5.6-sol', effort: 'high' },
      after: { sessionId: 'main-session', model: 'gpt-5.6-sol', effort: 'high' },
    },
    executionCapsule,
    modelInput: { action: { type: 'implement', step: { stepId: 'step-1', allowedPaths: ['src/app.mjs'] } } },
    executionContract: {},
  });

  assert.equal(ownerDirectAttempts, 0, 'owner-direct launch must not be invoked when execution evidence exists');
  assert.equal(dispatch.status, 'failed');
  assert.equal(dispatch.dispatchMechanism, 'native-subagent');
});

test('Correction 4: pre-spawn failure with sessionId does not fall back to owner-direct', async () => {
  let ownerDirectAttempts = 0;
  const adapter = createCodexAdapter({
    parentSessionObserver: stableParentObserver,
    launch: async () => {
      ownerDirectAttempts += 1;
      return { status: 'completed' };
    },
    nativeLaunch: async () => ({
      status: 'failed',
      resultStatus: 'failed',
      errorCode: 'launcher-unavailable',
      failureStage: 'pre-spawn',
      sessionId: 'child-session-leaked',
    }),
  });

  const decision = decisionFor('implement');
  const executionCapsule = {
    stepId: 'step-1',
    workUnit: { stepId: 'step-1', allowedPaths: ['src/app.mjs'] },
  };

  const dispatch = await adapter.dispatch({
    decision,
    resolution: resolution('gpt-5.6-sol'),
    parentSessionId: 'main-session',
    parentSessionConfig: {
      before: { sessionId: 'main-session', model: 'gpt-5.6-sol', effort: 'high' },
      after: { sessionId: 'main-session', model: 'gpt-5.6-sol', effort: 'high' },
    },
    executionCapsule,
    modelInput: { action: { type: 'implement', step: { stepId: 'step-1', allowedPaths: ['src/app.mjs'] } } },
    executionContract: {},
  });

  assert.equal(ownerDirectAttempts, 0, 'owner-direct launch must not be invoked when sessionId exists');
  assert.equal(dispatch.status, 'failed');
  assert.equal(dispatch.dispatchMechanism, 'native-subagent');
});

type TestControlPlane = Awaited<ReturnType<typeof import('../src/host/kernel/control-plane-runtime.js').createKernelControlPlane>>;
type TestStateStore = Awaited<ReturnType<typeof import('../src/kernel/state-store.js').openKernelStateStore>>;

test('W3: Codex knowledge observations expose verification binding identifiers', () => {
  const properties = assertTestRecord(CODEX_WORKER_OUTPUT_SCHEMA.properties);
  const knowledgeObservations = assertTestRecord(properties.knowledgeObservations);
  const item = assertTestRecord(knowledgeObservations.items);
  const itemProperties = assertTestRecord(item.properties);
  const required = Array.isArray(item.required) ? item.required.map(String) : [];

  assert.ok(itemProperties.acceptanceIds);
  assert.ok(itemProperties.obligationIds);
  assert.ok(required.includes('acceptanceIds'));
  assert.ok(required.includes('obligationIds'));
});
