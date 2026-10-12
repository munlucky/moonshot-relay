import { assertTestPresent, assertTestRecord, assertTestString, optionalTestRecord } from './helpers/assert-value.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { dispatchKernelTurn } from '../src/host/kernel/turn-dispatcher.js';
import { createKernelHostReviewBridge } from '../src/host/kernel/lifecycle-bridge.js';
import {
  createIndependentSubagentReviewTransport,
  validateIndependentSubagentReviewAttestation,
  INDEPENDENT_SUBAGENT_REVIEW_DEFAULT_TIMEOUT_MS,
} from '../src/host/kernel/independent-subagent-review.js';
import { MODEL_VISIBLE_PROMPT_FIELDS } from '../src/host/kernel/model-capsule-view.js';
import { createModelRegistry } from '../src/host/kernel/model-registry.js';
import { createClaudeAdapter } from '../src/host/kernel/adapters/claude.js';
import { createCodexAdapter } from '../src/host/kernel/adapters/codex.js';

const REVIEW_ACTION = {
  actionKind: 'review_engineering',
  obligationId: 'security-review',
  executionMode: 'native-subagent',
  delegationRequested: true,
  changedPaths: ['app.mjs'],
};

const prepareReviewRun = async (prefix: string, runId: string) => {
  const root = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), `${prefix}-state-`));
  await mkdir(path.join(root, '.moon-relay'), { recursive: true });
  await writeFile(path.join(root, '.moon-relay', 'track.yaml'), 'track: kernel\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'node -e "process.exit(0)"' } }));
  await writeFile(path.join(root, 'app.mjs'), 'export const value = 0;\n');
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot: root });
  try {
    await cp.startRun({
      runId,
      objective: 'secure change',
      taskContract: {
        surfaces: ['security_boundary'],
        acceptance: ['secure'],
        allowedPaths: ['app.mjs'],
      },
    });
    const implementer = createClaudeAdapter({
      launch: async ({ invocation }) => ({
        resolvedModel: assertTestRecord(invocation).model,
        observedModel: assertTestRecord(invocation).model,
        resolvedEffort: assertTestRecord(invocation).effort,
        observedEffort: assertTestRecord(invocation).effort,
        sessionId: `${runId}-implementer`,
      }),
    });
    const implementation = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter: implementer,
      registry: createModelRegistry({
        surface: 'claude',
        env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'configured-frontier', MOON_RELAY_KERNEL_MODEL_VALUE: 'configured-value' },
      }),
      actionContext: { executionMode: 'native-subagent', delegationRequested: true },
    });
    await writeFile(path.join(root, 'app.mjs'), 'export const value = 1;\n');
    await cp.report(runId, {
      summary: 'implemented',
      capsuleId: assertTestPresent(implementation.executionCapsule).capsuleId,
      stepId: assertTestPresent(implementation.executionCapsule).stepId,
      changedPaths: ['app.mjs'],
    });
    await cp.transition(runId, 'EXECUTE');
    await cp.transition(runId, 'PROVE');
    return { cp, root, runtimeHome };
  } catch (error) {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
    throw error;
  }
};

const cleanupReviewRun = async ({ cp, root, runtimeHome }: { cp: TestControlPlane; root: string; runtimeHome: string }) => {
  await cp.close();
  await rm(runtimeHome, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
};

const latestReviewSubject = (cp: TestControlPlane, runId: string) => {
  const capsule = cp.stateStore.listExecutionCapsules(runId)
    .filter((entry) => entry.role === 'reviewer')
    .at(-1);
  return capsule ? { ...assertTestRecord(capsule.subject), capsuleDigest: optionalTestRecord(capsule.provenance)?.capsuleDigest } : null;
};

const attestationFor = (request: Record<string, unknown>, reviewSubject: NonNullable<ReturnType<typeof latestReviewSubject>>, childSessionId = 'independent-reviewer-session') => ({
  schemaVersion: 1,
  transport: 'independent-subagent',
  executionId: 'independent-review-execution-1',
  childSessionId,
  parentSessionId: request.parentSessionId || null,
  requestedModel: request.model,
  requestedEffort: request.reasoningEffort,
  observedModel: request.model,
  observedEffort: request.reasoningEffort,
  freshContext: true,
  readOnly: true,
  canCommit: false,
  canDelegate: false,
  cleanupStatus: 'clean',
  workspaceIdentityBefore: assertTestRecord(reviewSubject).workspaceIdentity,
  workspaceIdentityAfter: assertTestRecord(reviewSubject).workspaceIdentity,
  mutationRevisionBefore: assertTestRecord(reviewSubject).mutationRevision,
  mutationRevisionAfter: assertTestRecord(reviewSubject).mutationRevision,
  capsuleDigest: reviewSubject.capsuleDigest,
});

test('independent subagent transport becomes the last fallback when native reviewer is absent', async () => {
  const fixture = await prepareReviewRun('kernel-independent-subagent', 'independent-subagent-chain');
  try {
    let request = null;
    const transport = createIndependentSubagentReviewTransport({
      host: {
        spawn_independent_reviewer: async (payload: Record<string, unknown>) => {
          request = payload;
          const reviewSubject = latestReviewSubject(fixture.cp, 'independent-subagent-chain');
          assert.ok(reviewSubject);
          return {
            outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://independent-subagent'] },
            reviewTransportAttestation: attestationFor(payload, reviewSubject),
          };
        },
      },
    });
    const result = await dispatchKernelTurn({
      controlPlane: fixture.cp,
      runId: 'independent-subagent-chain',
      adapter: createCodexAdapter({ nativeAgentHost: {} }),
      registry: createModelRegistry({ surface: 'codex', env: {} }),
      parentSessionId: 'owner-session',
      actionContext: REVIEW_ACTION,
      reviewTransports: [transport],
    });

    assert.equal(assertTestRecord(result.dispatch).dispatchMechanism, 'independent-subagent');
    assert.equal(assertTestRecord(result.dispatch).actorSessionId, 'independent-reviewer-session');
    assert.equal(assertTestPresent(assertTestPresent(result.review).review).verdict, 'pass');
    assert.match(assertTestString(result.reviewReceiptId), /^review-receipt-[a-f0-9]{24}$/);
    assert.equal(fixture.cp.listReviewReceipts('independent-subagent-chain').length, 1);
    assert.equal(assertTestRecord(request).task_name, 'kernel_reviewer');
    assert.equal(assertTestRecord(assertTestRecord(request).child_session).freshSessionRequired, true);
    assert.equal(assertTestRecord(assertTestRecord(request).child_session).canCommit, false);
    assert.equal(assertTestRecord(assertTestRecord(request).child_session).canDelegate, false);
    assert.equal(assertTestRecord(assertTestRecord(request).child_session).permissions, 'read_only');
    const marker = 'MODEL VISIBLE CONTEXT\n';
    const providerPrompt = JSON.parse(assertTestString(assertTestRecord(request).message).slice(assertTestString(assertTestRecord(request).message).indexOf(marker) + marker.length));
    assert.deepEqual(Object.keys(providerPrompt), [...MODEL_VISIBLE_PROMPT_FIELDS]);
    assert.equal(providerPrompt.currentWork.type, 'review');
    assert.match(assertTestString(assertTestRecord(request).message), /independent Kernel review/u);
    assert.match(assertTestString(assertTestRecord(request).message), /security-review/u);
    for (const forbidden of ['reviewSubject', 'mutationRevision', 'executionContract', 'executionCapsule']) {
      assert.doesNotMatch(assertTestString(assertTestRecord(request).message), new RegExp(forbidden, 'u'));
    }
    for (const forbidden of ['executionContract', 'execution_contract', 'executionCapsule', 'execution_capsule', 'reviewSubject', 'envelope', 'control', 'modelPolicy']) {
      assert.equal(Object.hasOwn(assertTestRecord(request), forbidden), false, `launcher request leaked ${forbidden}`);
    }
    assert.doesNotMatch(JSON.stringify(request), /route-host-only|nested-leak/u);
  } finally {
    await cleanupReviewRun(fixture);
  }
});

test('Kernel Host bridge auto-injects the independent subagent fallback and reports ready', async () => {
  const fixture = await prepareReviewRun('kernel-independent-bridge', 'independent-bridge-chain');
  try {
    let request = null;
    const bridge = createKernelHostReviewBridge({
      nativeAgentHost: {
        spawn_independent_reviewer: async (payload: Record<string, unknown>) => {
          request = payload;
          const reviewSubject = latestReviewSubject(fixture.cp, 'independent-bridge-chain');
          assert.ok(reviewSubject);
          return {
            outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://bridge-subagent'] },
            reviewTransportAttestation: attestationFor(payload, reviewSubject, 'bridge-reviewer-session'),
          };
        },
      },
      env: {},
    });
    const run = await fixture.cp.getRun('independent-bridge-chain');
    const readiness = await bridge.assess({
      controlPlane: fixture.cp,
      runId: 'independent-bridge-chain',
      modelInput: {
        action: { type: 'review', independentReviewRequired: true },
      },
    });
    assert.equal(readiness.status, 'READY', JSON.stringify(readiness));
    assert.equal(assertTestRecord(readiness.review).reviewExecutionAvailable, true);
    assert.equal(assertTestRecord(readiness.review).reviewIndependentContextAvailable, true);
    assert.equal(assertTestRecord(readiness.review).model, 'gpt-6-astra');
    assert.equal(assertTestRecord(readiness.review).effort, 'high');

    const result = await bridge.dispatchReview({
      controlPlane: fixture.cp,
      runId: 'independent-bridge-chain',
      modelInput: {
        objective: assertTestPresent(run).objective,
        action: {
          type: 'review',
          independentReviewRequired: true,
          outstandingObligations: ['security-review'],
        },
        changedPaths: ['app.mjs'],
      },
    });
    assert.equal(result.reviewReceiptId !== null, true, JSON.stringify(result));
    assert.equal(assertTestRecord(result.hostReview).status, 'receipt-recorded');
    assert.equal(assertTestRecord(result.hostReview).transport, 'independent-subagent');
    assert.equal(assertTestRecord(request).parent_session_id, null);
  } finally {
    await cleanupReviewRun(fixture);
  }
});

test('the same review point reuses its current receipt instead of reviewing twice', async () => {
  const fixture = await prepareReviewRun('kernel-independent-dedupe', 'independent-dedupe-chain');
  try {
    let launchCount = 0;
    const bridge = createKernelHostReviewBridge({
      nativeAgentHost: {
        spawn_independent_reviewer: async (payload: Record<string, unknown>) => {
          launchCount += 1;
          const reviewSubject = latestReviewSubject(fixture.cp, 'independent-dedupe-chain');
          assert.ok(reviewSubject);
          return {
            outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://dedupe'] },
            reviewTransportAttestation: attestationFor(payload, reviewSubject, 'dedupe-reviewer-session'),
          };
        },
      },
      env: {},
    });
    const modelInput = {
      objective: 'secure change',
      action: {
        type: 'review',
        independentReviewRequired: true,
        outstandingObligations: ['security-review'],
      },
      changedPaths: ['app.mjs'],
    };

    const first = await bridge.dispatchReview({
      controlPlane: fixture.cp,
      runId: 'independent-dedupe-chain',
      modelInput,
    });
    const second = await bridge.dispatchReview({
      controlPlane: fixture.cp,
      runId: 'independent-dedupe-chain',
      modelInput,
    });

    assert.equal(first.reviewReceiptId, second.reviewReceiptId);
    assert.equal(second.deduplicated, true);
    assert.equal(assertTestRecord(second.hostReview).status, 'receipt-recorded');
    assert.equal(assertTestRecord(second.hostReview).transport, 'deduplicated-review-receipt');
    assert.equal(launchCount, 1);
    assert.equal(fixture.cp.listReviewReceipts('independent-dedupe-chain').length, 1);
  } finally {
    await cleanupReviewRun(fixture);
  }
});

test('independent subagent attestation rejects same-session, writable, stale, and mismatched results', () => {
  const base = {
    dispatch: {
      actorSessionId: 'owner',
      reviewTransportAttestation: {
        schemaVersion: 1,
        transport: 'independent-subagent',
        executionId: 'execution',
        childSessionId: 'owner',
        parentSessionId: 'owner',
        requestedModel: 'gpt-6-astra',
        requestedEffort: 'high',
        observedModel: 'wrong-model',
        observedEffort: 'xhigh',
        freshContext: false,
        readOnly: false,
        canCommit: true,
        canDelegate: true,
        cleanupStatus: 'unknown',
        workspaceIdentityBefore: 'old-workspace',
        workspaceIdentityAfter: 'new-workspace',
        actualWorkspaceIdentityBefore: 'old-workspace',
        actualWorkspaceIdentityAfter: 'new-workspace',
        mutationRevisionBefore: 1,
        mutationRevisionAfter: 2,
        capsuleDigest: 'old-capsule',
      },
    },
    invocation: { model: 'gpt-6-astra', effort: 'high' },
    reviewSubject: {
      workspaceIdentity: 'current-workspace',
      mutationRevision: 1,
      capsuleDigest: 'current-capsule',
    },
    parentSessionId: 'owner',
  };
  const result = validateIndependentSubagentReviewAttestation(base);
  assert.equal(result.valid, false);
  for (const reason of [
    'attestation-fresh-context-not-proven',
    'attestation-read-only-not-proven',
    'attestation-commit-capability-not-denied',
    'attestation-delegation-capability-not-denied',
    'attestation-cleanup-not-proven',
    'attestation-observed-model-mismatch',
    'attestation-observed-effort-mismatch',
    'attestation-child-session-not-distinct',
    'attestation-workspace-before-mismatch',
    'attestation-workspace-after-mismatch',
    'attestation-mutation-after-mismatch',
    'attestation-capsule-digest-mismatch',
    'attestation-workspace-mutated',
  ]) assert.ok(result.reasons.includes(reason), reason);
});

test('missing independent subagent launcher remains unavailable and cannot claim capability', () => {
  const transport = createIndependentSubagentReviewTransport({ host: {} });
  assert.equal(transport.nativeDelegationAvailable, false);
  assert.equal(transport.capabilities.supportsIndependentContext, false);
  assert.equal(transport.capabilities.supportsIndependentSubagentReview, false);
});

test('independent subagent reviewer timeout resolves with strict precedence: explicit > injected env > 90000 default', async () => {
  assert.equal(INDEPENDENT_SUBAGENT_REVIEW_DEFAULT_TIMEOUT_MS, 90000);

  // 1. Default when neither explicit timeout nor env is provided
  const defaultTransport = createIndependentSubagentReviewTransport({ host: {}, env: {} });
  assert.equal(defaultTransport.timeoutMs, 90000);

  // 2. Injected env takes precedence over default and ignores process.env
  const envTransport = createIndependentSubagentReviewTransport({
    host: {},
    env: { MOON_RELAY_KERNEL_REVIEW_TIMEOUT_MS: '45000' },
  });
  assert.equal(envTransport.timeoutMs, 45000);

  // 3. Explicit timeoutMs takes top precedence over injected env
  const explicitTransport = createIndependentSubagentReviewTransport({
    host: {},
    timeoutMs: 30000,
    env: { MOON_RELAY_KERNEL_REVIEW_TIMEOUT_MS: '60000' },
  });
  assert.equal(explicitTransport.timeoutMs, 30000);

  // 4. Dispatched request forwards resolved timeoutMs to the launcher
  let capturedRequest = null;
  const mockLauncher = async (request: Record<string, unknown>) => {
    capturedRequest = request;
    return {
      verdict: 'pass',
      findings: [],
      risks: [],
      evidenceRefs: [],
    };
  };

  const activeTransport = createIndependentSubagentReviewTransport({
    spawnIndependentReviewer: mockLauncher,
    env: { MOON_RELAY_KERNEL_REVIEW_TIMEOUT_MS: '55000' },
  });
  assert.equal(activeTransport.timeoutMs, 55000);

  await activeTransport.dispatch({
    decision: { role: 'reviewer' },
    resolution: { model: 'gpt-6-astra', effort: 'high' },
    modelInput: { objective: 'test' },
  });

  assert.ok(capturedRequest, 'launcher should have been invoked');
  assert.equal(assertTestRecord(capturedRequest).timeoutMs, 55000);
  assert.equal(assertTestRecord(capturedRequest).timeout_ms, 55000);
});

type TestControlPlane = Awaited<ReturnType<typeof import('../src/host/kernel/control-plane-runtime.js').createKernelControlPlane>>;
type TestStateStore = Awaited<ReturnType<typeof import('../src/kernel/state-store.js').openKernelStateStore>>;
