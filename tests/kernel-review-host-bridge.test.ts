import { assertTestArray, assertTestNumber, assertTestPresent, assertTestRecord, assertTestString } from './helpers/assert-value.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { hashSessionId } from '../src/contracts/model-execution.js';
import { dispatchKernelTurn } from '../src/host/kernel/turn-dispatcher.js';
import { createCodexAdapter } from '../src/host/kernel/adapters/codex.js';
import { createClaudeAdapter } from '../src/host/kernel/adapters/claude.js';
import { createModelRegistry } from '../src/host/kernel/model-registry.js';
import { resolveReviewTransports } from '../src/host/kernel/review-transport-resolver.js';
import { resolveCodexModelPolicy } from '../src/host/kernel/codex-model-policy.js';
import { buildEvidenceIdentity } from '../src/kernel/proof/evidence-reuse.js';
import { normalizeTaskContract } from '../src/kernel/task/task-contract.js';

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

test('reviewer outcome cannot pass without the complete host-recorded chain', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-review-bridge-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-review-bridge-state-'));
  await mkdir(path.join(root, '.moon-relay'), { recursive: true });
  await writeFile(path.join(root, '.moon-relay', 'track.yaml'), 'track: kernel\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'node -e "process.exit(0)"' } }));
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot: root });
  try {
    await cp.startRun({ runId: 'review-chain', objective: 'secure change', taskContract: { acceptance: ['secure'], securityBoundary: true } });
    await assert.rejects(() => cp.ingestReviewerOutcome({
      runId: 'review-chain',
      stepId: 'step-1-1',
      capsuleId: 'capsule-missing',
      routeDecisionId: 'route-missing',
      usageReceiptId: 'usage-missing',
      reviewerSessionId: 'reviewer',
      outcome: { verdict: 'pass', findings: [], evidenceRefs: [], reviewedMutationRevision: 0 },
    }), /incomplete_review_chain/);
    assert.equal(cp.listReviewReceipts('review-chain').length, 0);
  } finally {
    await cp.close();
  }
});
test('an owner-bound two-command run supplies truthful implementation provenance to review', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-review-owner-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-review-owner-state-'));
  await mkdir(path.join(root, '.moon-relay'), { recursive: true });
  await writeFile(path.join(root, '.moon-relay', 'track.yaml'), 'track: kernel\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'node -e "process.exit(0)"' } }));
  const env = {
    MOON_RELAY_KERNEL_SESSION_ID: 'owner-session',
    MOON_RELAY_KERNEL_RUN_ID: 'owner-review-chain',
  };
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot: root, env, requireHostBinding: true });
  try {
    await cp.ensureRun({
      runId: 'owner-review-chain',
      objective: 'secure change',
      taskContract: { acceptance: ['secure'], securityBoundary: true },
    });
    const capsule = await cp.buildReviewerCapsule('owner-review-chain', {
      stage: 'engineering',
      obligationId: 'security-review',
    });
    assert.equal(capsule.implementationReceipt.actorSessionId, hashSessionId('unknown-host:owner-session'));
    assert.equal(assertTestRecord(capsule.implementationReceipt).usageReceiptId, undefined);
  } finally {
    await cp.close();
  }
});

test('the native Host review bridge ingests the observed outcome into a Kernel review receipt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-review-native-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-review-native-state-'));
  await mkdir(path.join(root, '.moon-relay'), { recursive: true });
  await writeFile(path.join(root, '.moon-relay', 'track.yaml'), 'track: kernel\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'node -e "process.exit(0)"' } }));
  await writeFile(path.join(root, 'app.mjs'), 'export const value = 0;\n');
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot: root });
  try {
    await cp.startRun({
      runId: 'native-review-chain',
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
        sessionId: 'native-review-implementer',
      }),
    });
    const implementation = await dispatchKernelTurn({
      controlPlane: cp,
      runId: 'native-review-chain',
      adapter: implementer,
      registry: createModelRegistry({
        surface: 'claude',
        env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'configured-frontier', MOON_RELAY_KERNEL_MODEL_VALUE: 'configured-value' },
      }),
      actionContext: { executionMode: 'native-subagent', delegationRequested: true },
    });
    await writeFile(path.join(root, 'app.mjs'), 'export const value = 1;\n');
    await cp.report('native-review-chain', {
      summary: 'implemented',
      capsuleId: assertTestPresent(implementation.executionCapsule).capsuleId,
      stepId: assertTestPresent(implementation.executionCapsule).stepId,
      changedPaths: ['app.mjs'],
    });
    await cp.transition('native-review-chain', 'EXECUTE');
    await cp.transition('native-review-chain', 'PROVE');
    const reviewedRun = await cp.getRun('native-review-chain');
    const reviewPolicy = resolveCodexModelPolicy({ executionClass: 'review' });
    let nativeRequest: unknown = null;
    const reviewer = createCodexAdapter({
      nativeAgentHost: {
        spawn_agent: async (payload) => {
          nativeRequest = payload;
          return {
            session_id: 'native-reviewer-session',
            terminalEvents: [{ type: 'turn.completed', model: reviewPolicy.model, reasoning_effort: reviewPolicy.effort }],
            outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://native'] },
          };
        },
      },
      parentSessionObserver: async ({ parentSessionId }) => ({
        sessionId: parentSessionId,
        model: reviewPolicy.model,
        effort: reviewPolicy.effort,
      }),
    });
    const result = await dispatchKernelTurn({
      controlPlane: cp,
      runId: 'native-review-chain',
      adapter: reviewer,
      registry: createModelRegistry({ surface: 'codex', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: assertTestString(reviewPolicy.model) } }),
      parentSessionId: 'native-owner-session',
      actionContext: {
        actionKind: 'review_engineering',
        obligationId: 'security-review',
        executionMode: 'native-subagent',
        delegationRequested: true,
        changedPaths: ['app.mjs'],
      },
    });
    assert.equal(assertTestRecord(nativeRequest).task_name, 'kernel_reviewer');
    assert.equal(assertTestRecord(assertTestRecord(nativeRequest).child_session).canCommit, false);
    assert.equal(assertTestRecord(nativeRequest).execution_capsule, undefined, 'the provider request must not receive the Host capsule');
    assert.equal(assertTestRecord(nativeRequest).execution_contract, undefined, 'the provider request must not receive the Host contract');
    assert.doesNotMatch(assertTestString(assertTestRecord(nativeRequest).message), /"role"|"permissions"|"nonGoals"|executionCapsule|executionContract/);
    assert.equal(assertTestPresent(assertTestPresent(result.review).review).verdict, 'pass');
    assert.match(assertTestString(result.reviewReceiptId), /^review-receipt-[a-f0-9]{24}$/);
    assert.equal(assertTestPresent(assertTestPresent(result.reviewReceipt).reviewer).usageReceiptId, assertTestRecord(result.receipt).receiptId);
    assert.equal(assertTestPresent(assertTestPresent(result.reviewReceipt).subject).mutationRevision, assertTestPresent(reviewedRun).mutationRevision);
    assert.equal(cp.listReviewReceipts('native-review-chain').length, 1);
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('report idempotency replays one canonical operation and retries with a new attempt identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-report-idempotency-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-report-idempotency-state-'));
  await mkdir(path.join(root, '.moon-relay'), { recursive: true });
  await writeFile(path.join(root, '.moon-relay', 'track.yaml'), 'track: kernel\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    scripts: { 'test:fail': 'node -e "process.exit(1)"' },
  }));
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot: root });
  try {
    await cp.startRun({ runId: 'report-idempotency', objective: 'retry reporting' });
    const firstAttempt = cp.beginAttempt('report-idempotency');
    const firstPayload = {
      attemptId: assertTestPresent(firstAttempt).attemptId,
      summary: 'first attempt',
      changedPaths: [],
      verifications: [{ obligationId: 'default', commandRef: 'test:fail' }],
    };
    const first = await cp.report('report-idempotency', firstPayload);
    const duplicate = await cp.report('report-idempotency', firstPayload);
    assert.equal(assertTestPresent(first).status, 'evidence-failed');
    assert.equal(assertTestPresent(duplicate).status, 'evidence-failed');
    assert.equal(assertTestRecord(assertTestPresent(duplicate)).idempotentReplay, true);
    assert.equal(assertTestRecord(assertTestPresent(duplicate)).attemptNumber, assertTestRecord(assertTestPresent(first)).attemptNumber);

    const secondAttempt = cp.beginAttempt('report-idempotency', { stepId: assertTestPresent(firstAttempt).stepId, retryReason: 'evidence-failed' });
    const retry = await cp.report('report-idempotency', {
      ...firstPayload,
      attemptId: assertTestPresent(secondAttempt).attemptId,
      summary: 'second attempt',
    });
    assert.equal(assertTestPresent(retry).status, 'evidence-failed');
    assert.equal(assertTestRecord(assertTestPresent(retry)).attemptNumber, assertTestNumber(assertTestRecord(assertTestPresent(first)).attemptNumber) + 1);
    const status = await cp.status('report-idempotency');
    assert.equal(assertTestRecord(assertTestRecord(assertTestRecord(assertTestPresent(status)).measurement).retryCount).value, 1);
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('an unavailable primary reviewer transport falls back without duplicating the review receipt', async () => {
  const fixture = await prepareReviewRun('kernel-review-fallback', 'review-fallback-chain');
  try {
    let fallbackCalls = 0;
    const fallback = createClaudeAdapter({
      launch: async ({ invocation }) => {
        fallbackCalls += 1;
        return {
          resolvedModel: assertTestRecord(invocation).model,
          observedModel: assertTestRecord(invocation).model,
          resolvedEffort: assertTestRecord(invocation).effort,
          observedEffort: assertTestRecord(invocation).effort,
          sessionId: 'fallback-reviewer',
          outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://fallback'] },
        };
      },
    });
    const result = await dispatchKernelTurn({
      controlPlane: fixture.cp,
      runId: 'review-fallback-chain',
      adapter: createCodexAdapter(),
      registry: createModelRegistry({ surface: 'codex', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'codex-frontier' } }),
      actionContext: REVIEW_ACTION,
      reviewFallbacks: [{
        adapter: fallback,
        registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'claude-frontier' } }),
      }],
    });

    assert.equal(fallbackCalls, 1);
    assert.equal(assertTestPresent(assertTestPresent(result.review).review).verdict, 'pass');
    assert.equal(assertTestRecord(assertTestPresent(result.hostDirective).hostCapabilities).surface, 'claude');
    assert.equal(fixture.cp.listReviewReceipts('review-fallback-chain').length, 1);
    const reviewerAttempts = fixture.cp.stateStore.getStepAttempts('review-fallback-chain')
      .filter((attempt) => fixture.cp.stateStore.getModelRouteDecision(assertTestString(attempt.routeDecisionId), { runId: 'review-fallback-chain' })?.role === 'reviewer');
    assert.equal(reviewerAttempts.length, 2);
    assert.equal(reviewerAttempts[0].status, 'interrupted');
    assert.equal(reviewerAttempts[1].parentAttemptId, reviewerAttempts[0].attemptId);
  } finally {
    await cleanupReviewRun(fixture);
  }
});

test('a pre-spawn reviewer transport failure can use the next concrete transport', async () => {
  const fixture = await prepareReviewRun('kernel-review-preflight', 'review-preflight-chain');
  try {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    let fallbackInvocation: unknown = null;
    const originalEnv = { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'main-review-model' };
    const primary = createClaudeAdapter({
      launch: async () => {
        primaryCalls += 1;
        const error = new Error('CLI version mismatch');
        assertTestRecord(error).code = 'cli-version-mismatch';
        assertTestRecord(error).details = { failureCategory: 'provider/infrastructure', failureStage: 'pre-spawn' };
        throw error;
      },
    });
    const fallback = createClaudeAdapter({
      launch: async (payload) => {
        fallbackCalls += 1;
        fallbackInvocation = payload;
        const { invocation } = payload;
        return {
          resolvedModel: assertTestRecord(invocation).model,
          observedModel: assertTestRecord(invocation).model,
          resolvedEffort: assertTestRecord(invocation).effort,
          observedEffort: assertTestRecord(invocation).effort,
          sessionId: 'preflight-fallback-reviewer',
          outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://preflight-fallback'] },
        };
      },
    });
    const result = await dispatchKernelTurn({
      controlPlane: fixture.cp,
      runId: 'review-preflight-chain',
      adapter: primary,
      registry: createModelRegistry({ surface: 'claude', env: originalEnv }),
      env: originalEnv,
      parentSessionId: 'review-owner',
      toolPolicy: { reviewer: { filesystem: 'read-only' } },
      permissionPolicy: { filesystem: 'read_only' },
      economics: { maxCostUnits: 10 },
      actionContext: REVIEW_ACTION,
      reviewFallbacks: [{
        adapter: fallback,
        registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'candidate-model' } }),
        env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'attacker-model' },
        overrides: { frontier_reasoning: { model: 'attacker-model' } },
        actionContext: { actionKind: 'implement', delegationRequested: false },
        parentSessionId: 'attacker-parent',
        parentSessionConfig: { before: { sessionId: 'attacker-parent' }, after: { sessionId: 'attacker-parent' } },
        toolPolicy: { reviewer: 'unsafe' },
        permissionPolicy: { filesystem: 'workspace_write' },
        economics: { maxCostUnits: 0 },
      }],
    });

    assert.equal(primaryCalls, 1);
    assert.equal(fallbackCalls, 1);
    assert.equal(assertTestPresent(assertTestPresent(result.review).review).verdict, 'pass');
    assert.equal(fixture.cp.listReviewReceipts('review-preflight-chain').length, 1);
    assert.equal(assertTestRecord(fallbackInvocation).parentSessionId, 'review-owner');
    assert.equal(assertTestRecord(fallbackInvocation).environment, originalEnv);
    assert.equal(assertTestRecord(assertTestRecord(fallbackInvocation).invocation).model, 'main-review-model');
    assert.equal(assertTestRecord(assertTestRecord(fallbackInvocation).invocation).subagent, 'kernel-reviewer');
    const reviewerAttempts = fixture.cp.stateStore.getStepAttempts('review-preflight-chain')
      .filter((attempt) => fixture.cp.stateStore.getModelRouteDecision(assertTestString(attempt.routeDecisionId), { runId: 'review-preflight-chain' })?.role === 'reviewer');
    assert.equal(reviewerAttempts.length, 2);
    assert.equal(reviewerAttempts[0].status, 'interrupted');
    assert.equal(reviewerAttempts[1].status, 'started');
    assert.equal(reviewerAttempts[1].parentAttemptId, reviewerAttempts[0].attemptId);
    const reviewerUsageReceipts = fixture.cp.stateStore.listModelUsageReceipts('review-preflight-chain')
      .filter((receipt) => fixture.cp.stateStore.getModelRouteDecision(receipt.decisionId, { runId: 'review-preflight-chain' })?.role === 'reviewer');
    assert.equal(reviewerUsageReceipts.length, 2);
    assert.notEqual(reviewerUsageReceipts[0].receiptId, reviewerUsageReceipts[1].receiptId);
  } finally {
    await cleanupReviewRun(fixture);
  }
});

test('review outcome ingestion rejects a workspace mutation after reviewer dispatch', async () => {
  const fixture = await prepareReviewRun('kernel-review-ingest-stale', 'review-ingest-stale-chain');
  try {
    const reviewer = createClaudeAdapter({
      launch: async ({ invocation }) => {
        await writeFile(path.join(fixture.root, 'app.mjs'), 'export const value = 2;\n');
        return {
          resolvedModel: assertTestRecord(invocation).model,
          observedModel: assertTestRecord(invocation).model,
          resolvedEffort: assertTestRecord(invocation).effort,
          observedEffort: assertTestRecord(invocation).effort,
          sessionId: 'ingest-stale-reviewer',
          outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://ingest-stale'] },
        };
      },
    });
    const result = await dispatchKernelTurn({
      controlPlane: fixture.cp,
      runId: 'review-ingest-stale-chain',
      adapter: reviewer,
      registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'stale-review-model' } }),
      actionContext: REVIEW_ACTION,
    });

    assert.equal(assertTestPresent(result.review).status, 'blocked');
    assert.equal(assertTestPresent(result.review).blockedReason, 'incomplete_review_chain');
    assert.equal(result.reviewReceipt, null);
    assert.equal(fixture.cp.listReviewReceipts('review-ingest-stale-chain').length, 0);
  } finally {
    await cleanupReviewRun(fixture);
  }
});

test('direct review recording rechecks the live workspace before minting a receipt', async () => {
  const fixture = await prepareReviewRun('kernel-review-record-stale', 'review-record-stale-chain');
  try {
    await writeFile(path.join(fixture.root, 'app.mjs'), 'export const value = 3;\n');
    await assert.rejects(
      () => fixture.cp.recordReview('review-record-stale-chain', {
        stage: 'engineering',
        verdict: 'pass',
        reviewerId: 'unrouted-reviewer',
        findings: [],
      }),
      /incomplete_review_chain: review workspace identity changed during review-recording/,
    );
    assert.equal(fixture.cp.listReviewReceipts('review-record-stale-chain').length, 0);
  } finally {
    await cleanupReviewRun(fixture);
  }
});

test('each attempted fallback hop gets a fresh child after a skipped reviewer transport', async () => {
  const fixture = await prepareReviewRun('kernel-review-multi-hop', 'review-multi-hop-chain');
  try {
    let finalFallbackCalls = 0;
    const transportFailure = (calls: { count: number }) => async () => {
      calls.count += 1;
      return {
        status: 'failed',
        resultStatus: 'failed',
        errorCode: 'transport-unavailable',
        failureCategory: 'provider/infrastructure',
        failureStage: 'pre-spawn',
      };
    };
    const primaryCount = { count: 0 };
    const firstFallbackCount = { count: 0 };
    const primary = createClaudeAdapter({ launch: transportFailure(primaryCount) });
    const firstFallback = createClaudeAdapter({ launch: transportFailure(firstFallbackCount) });
    const skippedFallback = createClaudeAdapter();
    const finalFallback = createClaudeAdapter({
      launch: async ({ invocation }) => {
        finalFallbackCalls += 1;
        return {
          resolvedModel: assertTestRecord(invocation).model,
          observedModel: assertTestRecord(invocation).model,
          resolvedEffort: assertTestRecord(invocation).effort,
          observedEffort: assertTestRecord(invocation).effort,
          sessionId: 'multi-hop-final-reviewer',
          outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://multi-hop-final'] },
        };
      },
    });
    const registry = createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'multi-hop-review-model' } });
    const result = await dispatchKernelTurn({
      controlPlane: fixture.cp,
      runId: 'review-multi-hop-chain',
      adapter: primary,
      registry,
      actionContext: REVIEW_ACTION,
      reviewFallbacks: [
        { adapter: firstFallback, registry },
        { adapter: skippedFallback, registry },
        { adapter: finalFallback, registry },
      ],
    });

    assert.equal(primaryCount.count, 1);
    assert.equal(firstFallbackCount.count, 1);
    assert.equal(finalFallbackCalls, 1);
    assert.equal(assertTestPresent(assertTestPresent(result.review).review).verdict, 'pass');
    assert.equal(fixture.cp.listReviewReceipts('review-multi-hop-chain').length, 1);
    const reviewerAttempts = fixture.cp.stateStore.getStepAttempts('review-multi-hop-chain')
      .filter((attempt) => fixture.cp.stateStore.getModelRouteDecision(assertTestString(attempt.routeDecisionId), { runId: 'review-multi-hop-chain' })?.role === 'reviewer');
    assert.equal(reviewerAttempts.length, 3);
    assert.equal(reviewerAttempts[0].status, 'interrupted');
    assert.equal(reviewerAttempts[1].status, 'interrupted');
    assert.equal(reviewerAttempts[1].parentAttemptId, reviewerAttempts[0].attemptId);
    assert.equal(reviewerAttempts[2].parentAttemptId, reviewerAttempts[1].attemptId);
  } finally {
    await cleanupReviewRun(fixture);
  }
});

test('a pre-spawn launcher echo is not provider evidence and cannot retarget a same-surface fallback', async () => {
  const fixture = await prepareReviewRun('kernel-review-echo', 'review-echo-chain');
  try {
    let fallbackCalls = 0;
    const primary = createClaudeAdapter({
      launch: async ({ invocation }) => ({
        status: 'failed',
        resultStatus: 'failed',
        errorCode: 'transport-unavailable',
        failureCategory: 'provider/infrastructure',
        failureStage: 'pre-spawn',
        // These values are request echoes, not evidence that a provider ran.
        resolvedModel: assertTestRecord(invocation).model,
        observedModel: assertTestRecord(invocation).model,
        resolvedEffort: assertTestRecord(invocation).effort,
        observedEffort: assertTestRecord(invocation).effort,
      }),
    });
    const fallback = createClaudeAdapter({
      launch: async ({ invocation }) => {
        fallbackCalls += 1;
        assert.equal(assertTestRecord(invocation).model, 'main-review-model');
        return {
          resolvedModel: assertTestRecord(invocation).model,
          observedModel: assertTestRecord(invocation).model,
          resolvedEffort: assertTestRecord(invocation).effort,
          observedEffort: assertTestRecord(invocation).effort,
          sessionId: 'echo-fallback-reviewer',
          outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://echo-fallback'] },
        };
      },
    });
    const result = await dispatchKernelTurn({
      controlPlane: fixture.cp,
      runId: 'review-echo-chain',
      adapter: primary,
      registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'main-review-model' } }),
      actionContext: REVIEW_ACTION,
      reviewFallbacks: [{
        adapter: fallback,
        registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'attacker-model' } }),
      }],
    });

    assert.equal(fallbackCalls, 1);
    assert.equal(assertTestPresent(assertTestPresent(result.review).review).verdict, 'pass');
    assert.equal(fixture.cp.listReviewReceipts('review-echo-chain').length, 1);
  } finally {
    await cleanupReviewRun(fixture);
  }
});

test('a valid failing reviewer verdict is terminal and never invokes a fallback reviewer', async () => {
  const fixture = await prepareReviewRun('kernel-review-fail', 'review-fail-chain');
  try {
    let fallbackCalls = 0;
    const primary = createClaudeAdapter({
      launch: async ({ invocation }) => ({
        resolvedModel: assertTestRecord(invocation).model,
        observedModel: assertTestRecord(invocation).model,
        resolvedEffort: assertTestRecord(invocation).effort,
        observedEffort: assertTestRecord(invocation).effort,
        sessionId: 'failing-reviewer',
        outcome: { verdict: 'fail', findings: [], risks: ['test finding'], evidenceRefs: ['review://fail'] },
      }),
    });
    const fallback = createClaudeAdapter({ launch: async () => { fallbackCalls += 1; return {}; } });
    const result = await dispatchKernelTurn({
      controlPlane: fixture.cp,
      runId: 'review-fail-chain',
      adapter: primary,
      registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'claude-frontier' } }),
      actionContext: REVIEW_ACTION,
      reviewFallbacks: [{
        adapter: fallback,
        registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'claude-frontier' } }),
      }],
    });

    assert.equal(fallbackCalls, 0);
    assert.equal(assertTestPresent(assertTestPresent(result.review).review).verdict, 'fail');
    assert.equal(fixture.cp.listReviewReceipts('review-fail-chain').length, 1);
  } finally {
    await cleanupReviewRun(fixture);
  }
});

test('a malformed reviewer outcome is terminal and never invokes a fallback reviewer', async () => {
  const fixture = await prepareReviewRun('kernel-review-malformed', 'review-malformed-chain');
  try {
    let fallbackCalls = 0;
    const primary = createClaudeAdapter({
      launch: async ({ invocation }) => ({
        resolvedModel: assertTestRecord(invocation).model,
        observedModel: assertTestRecord(invocation).model,
        resolvedEffort: assertTestRecord(invocation).effort,
        observedEffort: assertTestRecord(invocation).effort,
        sessionId: 'malformed-reviewer',
        outcome: { verdict: 'pass' },
      }),
    });
    const fallback = createClaudeAdapter({ launch: async () => { fallbackCalls += 1; return {}; } });
    const result = await dispatchKernelTurn({
      controlPlane: fixture.cp,
      runId: 'review-malformed-chain',
      adapter: primary,
      registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'claude-frontier' } }),
      actionContext: REVIEW_ACTION,
      reviewFallbacks: [{
        adapter: fallback,
        registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'claude-frontier' } }),
      }],
    });

    assert.equal(fallbackCalls, 0);
    assert.equal(assertTestPresent(result.review).status, 'blocked');
    assert.equal(assertTestPresent(result.review).blockedReason, 'incomplete_review_chain');
    assert.equal(result.reviewReceipt, null);
    const usageReceipts = fixture.cp.stateStore.listModelUsageReceipts('review-malformed-chain');
    assert.equal(usageReceipts.filter((receipt) => fixture.cp.stateStore.getModelRouteDecision(receipt.decisionId, { runId: 'review-malformed-chain' })?.role === 'reviewer').length, 1);
  } finally {
    await cleanupReviewRun(fixture);
  }
});

test('a thrown reviewer outcome is terminal and never invokes a fallback reviewer', async () => {
  const fixture = await prepareReviewRun('kernel-review-thrown-outcome', 'review-thrown-outcome-chain');
  try {
    let fallbackCalls = 0;
    const primary = createClaudeAdapter({
      launch: async () => {
        const error = new Error('review transport returned a semantic result');
        assertTestRecord(error).code = 'transport-unavailable';
        assertTestRecord(error).details = {
          failureCategory: 'provider/infrastructure',
          failureStage: 'pre-spawn',
          outcome: { verdict: 'fail', findings: [], risks: ['thrown reviewer result'], evidenceRefs: ['review://thrown'] },
        };
        throw error;
      },
    });
    const fallback = createClaudeAdapter({ launch: async () => { fallbackCalls += 1; return {}; } });
    const result = await dispatchKernelTurn({
      controlPlane: fixture.cp,
      runId: 'review-thrown-outcome-chain',
      adapter: primary,
      registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'claude-frontier' } }),
      actionContext: REVIEW_ACTION,
      reviewFallbacks: [{
        adapter: fallback,
        registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'claude-frontier' } }),
      }],
    });

    assert.equal(fallbackCalls, 0);
    assert.equal(assertTestRecord(assertTestRecord(result.dispatch).outcome).verdict, 'fail');
    assert.equal(assertTestPresent(result.review).status, 'blocked');
    assert.equal(assertTestPresent(result.review).blockedReason, 'transport-unavailable');
  } finally {
    await cleanupReviewRun(fixture);
  }
});

test('Codex preserves a thrown reviewer outcome and never invokes a fallback reviewer', async () => {
  const fixture = await prepareReviewRun('kernel-review-codex-thrown-outcome', 'review-codex-thrown-outcome-chain');
  try {
    let fallbackCalls = 0;
    const primary = createCodexAdapter({
      nativeLaunch: async () => {
        const error = new Error('Codex reviewer returned a semantic result while launching');
        assertTestRecord(error).code = 'transport-unavailable';
        assertTestRecord(error).details = {
          failureCategory: 'provider/infrastructure',
          failureStage: 'pre-spawn',
          outcome: { verdict: 'blocked', findings: [], risks: ['thrown Codex reviewer result'], evidenceRefs: ['review://codex-thrown'] },
        };
        throw error;
      },
      parentSessionObserver: async ({ parentSessionId }) => ({
        sessionId: parentSessionId,
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
      }),
    });
    const fallback = createClaudeAdapter({ launch: async () => { fallbackCalls += 1; return {}; } });
    const result = await dispatchKernelTurn({
      controlPlane: fixture.cp,
      runId: 'review-codex-thrown-outcome-chain',
      adapter: primary,
      registry: createModelRegistry({ surface: 'codex', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'gpt-5.6-sol' } }),
      parentSessionId: 'review-owner',
      actionContext: REVIEW_ACTION,
      reviewFallbacks: [{
        adapter: fallback,
        registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'claude-frontier' } }),
      }],
    });

    assert.equal(fallbackCalls, 0);
    assert.equal(assertTestRecord(assertTestRecord(result.dispatch).outcome).verdict, 'blocked');
    assert.equal(assertTestPresent(result.review).status, 'blocked');
    assert.equal(assertTestPresent(result.review).blockedReason, 'transport-unavailable');
  } finally {
    await cleanupReviewRun(fixture);
  }
});

test('review fallback stops when the primary transport changes the capsule workspace', async () => {
  const fixture = await prepareReviewRun('kernel-review-stale-fallback', 'review-stale-fallback-chain');
  try {
    let fallbackCalls = 0;
    const primary = createClaudeAdapter({
      launch: async () => {
        await writeFile(path.join(fixture.root, 'app.mjs'), 'export const value = 2;\n');
        const error = new Error('review transport failed after touching the workspace');
        assertTestRecord(error).code = 'transport-unavailable';
        assertTestRecord(error).details = { failureCategory: 'provider/infrastructure', failureStage: 'pre-spawn' };
        throw error;
      },
    });
    const fallback = createClaudeAdapter({ launch: async () => { fallbackCalls += 1; return {}; } });
    const result = await dispatchKernelTurn({
      controlPlane: fixture.cp,
      runId: 'review-stale-fallback-chain',
      adapter: primary,
      registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'claude-frontier' } }),
      actionContext: REVIEW_ACTION,
      reviewFallbacks: [{
        adapter: fallback,
        registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'claude-frontier' } }),
      }],
    });

    assert.equal(fallbackCalls, 0);
    assert.equal(result.reason, 'review-subject-stale');
    assert.equal(assertTestPresent(result.review).blockedReason, 'review-subject-stale');
    const reviewerAttempts = fixture.cp.stateStore.getStepAttempts('review-stale-fallback-chain')
      .filter((attempt) => fixture.cp.stateStore.getModelRouteDecision(assertTestString(attempt.routeDecisionId), { runId: 'review-stale-fallback-chain' })?.role === 'reviewer');
    assert.equal(reviewerAttempts.length, 1);
    assert.equal(reviewerAttempts[0].status, 'interrupted');
  } finally {
    await cleanupReviewRun(fixture);
  }
});

test('a post-spawn transport-shaped failure is terminal and never invokes a fallback reviewer', async () => {
  const fixture = await prepareReviewRun('kernel-review-postspawn', 'review-postspawn-chain');
  try {
    let fallbackCalls = 0;
    const primary = createClaudeAdapter({
      launch: async ({ invocation }) => ({
        status: 'failed',
        resultStatus: 'failed',
        resolvedModel: assertTestRecord(invocation).model,
        observedModel: assertTestRecord(invocation).model,
        resolvedEffort: assertTestRecord(invocation).effort,
        observedEffort: assertTestRecord(invocation).effort,
        sessionId: 'postspawn-reviewer',
        errorCode: 'transport-unavailable',
        failureCategory: 'provider/infrastructure',
        failureStage: 'launch',
        runtimePreflight: {
          status: 'failed',
          errorCode: 'transport-unavailable',
          failureCategory: 'provider/infrastructure',
          failureStage: 'pre-spawn',
        },
      }),
    });
    const fallback = createClaudeAdapter({ launch: async () => { fallbackCalls += 1; return {}; } });
    const result = await dispatchKernelTurn({
      controlPlane: fixture.cp,
      runId: 'review-postspawn-chain',
      adapter: primary,
      registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'claude-frontier' } }),
      actionContext: REVIEW_ACTION,
      reviewFallbacks: [{
        adapter: fallback,
        registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'claude-frontier' } }),
      }],
    });

    assert.equal(fallbackCalls, 0);
    assert.equal(assertTestPresent(result.review).status, 'blocked');
    assert.equal(assertTestPresent(result.review).blockedReason, 'transport-unavailable');
    assert.equal(result.reviewReceipt, null);
  } finally {
    await cleanupReviewRun(fixture);
  }
});

test('provider telemetry makes a contradictory pre-spawn reviewer failure terminal', async () => {
  const fixture = await prepareReviewRun('kernel-review-telemetry', 'review-telemetry-chain');
  try {
    let fallbackCalls = 0;
    const primary = createClaudeAdapter({
      launch: async ({ invocation }) => ({
        status: 'failed',
        resultStatus: 'failed',
        resolvedModel: assertTestRecord(invocation).model,
        observedModel: assertTestRecord(invocation).model,
        inputTokens: 17,
        errorCode: 'transport-unavailable',
        failureCategory: 'provider/infrastructure',
        failureStage: 'pre-spawn',
      }),
    });
    const fallback = createClaudeAdapter({ launch: async () => { fallbackCalls += 1; return {}; } });
    const result = await dispatchKernelTurn({
      controlPlane: fixture.cp,
      runId: 'review-telemetry-chain',
      adapter: primary,
      registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'claude-frontier' } }),
      actionContext: REVIEW_ACTION,
      reviewFallbacks: [{
        adapter: fallback,
        registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'claude-frontier' } }),
      }],
    });

    assert.equal(fallbackCalls, 0);
    assert.equal(assertTestPresent(result.review).status, 'blocked');
    assert.equal(assertTestPresent(result.review).blockedReason, 'transport-unavailable');
  } finally {
    await cleanupReviewRun(fixture);
  }
});

test('Codex preserves nested provider evidence as a terminal launcher failure', async () => {
  const fixture = await prepareReviewRun('kernel-review-codex-telemetry', 'review-codex-telemetry-chain');
  try {
    let fallbackCalls = 0;
    const primary = createCodexAdapter({
      nativeLaunch: async () => {
        const error = new Error('provider session already existed');
        assertTestRecord(error).code = 'transport-unavailable';
        assertTestRecord(error).details = {
          status: 'failed',
          failureCategory: 'provider/infrastructure',
          failureStage: 'pre-spawn',
          sessionId: 'provider-session-existed',
          providerRequestId: 'provider-request-existed',
          terminalEvents: [{ type: 'turn.completed', responseId: 'response-existed' }],
        };
        throw error;
      },
      parentSessionObserver: async ({ parentSessionId }) => ({
        sessionId: parentSessionId,
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
      }),
    });
    const fallback = createClaudeAdapter({ launch: async () => { fallbackCalls += 1; return {}; } });
    const result = await dispatchKernelTurn({
      controlPlane: fixture.cp,
      runId: 'review-codex-telemetry-chain',
      adapter: primary,
      registry: createModelRegistry({ surface: 'codex', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'gpt-5.6-sol' } }),
      parentSessionId: 'review-owner',
      actionContext: REVIEW_ACTION,
      reviewFallbacks: [{
        adapter: fallback,
        registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'claude-frontier' } }),
      }],
    });

    assert.equal(fallbackCalls, 0);
    assert.equal(assertTestPresent(result.review).status, 'blocked');
    assert.equal(assertTestPresent(result.review).blockedReason, 'transport-unavailable');
    assert.equal(fixture.cp.listReviewReceipts('review-codex-telemetry-chain').length, 0);
  } finally {
    await cleanupReviewRun(fixture);
  }
});

test('Codex does not treat a pre-spawn model echo as provider execution evidence', async () => {
  const fixture = await prepareReviewRun('kernel-review-codex-echo', 'review-codex-echo-chain');
  try {
    let fallbackCalls = 0;
    const primary = createCodexAdapter({
      nativeLaunch: async ({ invocation }) => ({
        status: 'failed',
        resultStatus: 'failed',
        errorCode: 'transport-unavailable',
        failureCategory: 'provider/infrastructure',
        failureStage: 'pre-spawn',
        resolvedModel: assertTestRecord(invocation).model,
        observedModel: assertTestRecord(invocation).model,
        resolvedEffort: assertTestRecord(invocation).effort,
        observedEffort: assertTestRecord(invocation).effort,
      }),
      parentSessionObserver: async ({ parentSessionId }) => ({
        sessionId: parentSessionId,
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
      }),
    });
    const fallback = createClaudeAdapter({
      launch: async ({ invocation }) => {
        fallbackCalls += 1;
        return {
          resolvedModel: assertTestRecord(invocation).model,
          observedModel: assertTestRecord(invocation).model,
          resolvedEffort: assertTestRecord(invocation).effort,
          observedEffort: assertTestRecord(invocation).effort,
          sessionId: 'codex-echo-fallback-reviewer',
          outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://codex-echo-fallback'] },
        };
      },
    });
    const result = await dispatchKernelTurn({
      controlPlane: fixture.cp,
      runId: 'review-codex-echo-chain',
      adapter: primary,
      registry: createModelRegistry({ surface: 'codex', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'gpt-5.6-sol' } }),
      parentSessionId: 'review-owner',
      actionContext: REVIEW_ACTION,
      reviewFallbacks: [{
        adapter: fallback,
        registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'claude-frontier' } }),
      }],
    });

    assert.equal(fallbackCalls, 1);
    assert.equal(assertTestPresent(assertTestPresent(result.review).review).verdict, 'pass');
    assert.equal(assertTestRecord(result.receipt).resolvedModel, 'claude-frontier');
  } finally {
    await cleanupReviewRun(fixture);
  }
});

test('observed session config makes a Claude pre-spawn reviewer failure terminal', async () => {
  const fixture = await prepareReviewRun('kernel-review-claude-observed-config', 'review-claude-observed-config-chain');
  try {
    let fallbackCalls = 0;
    const primary = createClaudeAdapter({
      launch: async () => ({
        status: 'failed',
        resultStatus: 'failed',
        errorCode: 'transport-unavailable',
        failureCategory: 'provider/infrastructure',
        failureStage: 'pre-spawn',
        observedConfig: { model: 'claude-frontier', effort: 'high' },
      }),
    });
    const fallback = createClaudeAdapter({ launch: async () => { fallbackCalls += 1; return {}; } });
    const result = await dispatchKernelTurn({
      controlPlane: fixture.cp,
      runId: 'review-claude-observed-config-chain',
      adapter: primary,
      registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'claude-frontier' } }),
      actionContext: REVIEW_ACTION,
      reviewFallbacks: [{
        adapter: fallback,
        registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'claude-fallback' } }),
      }],
    });

    assert.equal(fallbackCalls, 0);
    assert.equal(assertTestPresent(result.review).status, 'blocked');
    assert.equal(assertTestPresent(result.review).blockedReason, 'transport-unavailable');
    assert.equal(result.reviewReceipt, null);
  } finally {
    await cleanupReviewRun(fixture);
  }
});

test('nested Codex observed session config makes a pre-spawn reviewer failure terminal', async () => {
  const fixture = await prepareReviewRun('kernel-review-codex-observed-config', 'review-codex-observed-config-chain');
  try {
    let fallbackCalls = 0;
    const primary = createCodexAdapter({
      nativeLaunch: async () => {
        const error = new Error('provider session was observed');
        assertTestRecord(error).code = 'transport-unavailable';
        assertTestRecord(error).details = {
          failureCategory: 'provider/infrastructure',
          failureStage: 'pre-spawn',
          observedSessionConfig: { model: 'gpt-5.6-sol', effort: 'xhigh' },
        };
        throw error;
      },
      parentSessionObserver: async ({ parentSessionId }) => ({
        sessionId: parentSessionId,
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
      }),
    });
    const fallback = createClaudeAdapter({ launch: async () => { fallbackCalls += 1; return {}; } });
    const result = await dispatchKernelTurn({
      controlPlane: fixture.cp,
      runId: 'review-codex-observed-config-chain',
      adapter: primary,
      registry: createModelRegistry({ surface: 'codex', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'gpt-5.6-sol' } }),
      parentSessionId: 'review-owner',
      actionContext: REVIEW_ACTION,
      reviewFallbacks: [{
        adapter: fallback,
        registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'claude-fallback' } }),
      }],
    });

    assert.equal(fallbackCalls, 0);
    assert.equal(assertTestPresent(result.review).status, 'blocked');
    assert.equal(assertTestPresent(result.review).blockedReason, 'transport-unavailable');
    assert.equal(result.reviewReceipt, null);
  } finally {
    await cleanupReviewRun(fixture);
  }
});

test('explicitly negative provider evidence still permits a safe reviewer fallback', async () => {
  const fixture = await prepareReviewRun('kernel-review-negative-evidence', 'review-negative-evidence-chain');
  try {
    let fallbackCalls = 0;
    const primary = createClaudeAdapter({
      launch: async () => ({
        status: 'failed',
        resultStatus: 'failed',
        errorCode: 'transport-unavailable',
        failureCategory: 'provider/infrastructure',
        failureStage: 'pre-spawn',
        providerExecutionEvidence: false,
      }),
    });
    const fallback = createClaudeAdapter({
      launch: async ({ invocation }) => {
        fallbackCalls += 1;
        return {
          resolvedModel: assertTestRecord(invocation).model,
          observedModel: assertTestRecord(invocation).model,
          resolvedEffort: assertTestRecord(invocation).effort,
          observedEffort: assertTestRecord(invocation).effort,
          sessionId: 'negative-evidence-fallback-reviewer',
          outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://negative-evidence-fallback'] },
        };
      },
    });
    const result = await dispatchKernelTurn({
      controlPlane: fixture.cp,
      runId: 'review-negative-evidence-chain',
      adapter: primary,
      registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'claude-frontier' } }),
      actionContext: REVIEW_ACTION,
      reviewFallbacks: [{
        adapter: fallback,
        registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'claude-fallback' } }),
      }],
    });

    assert.equal(fallbackCalls, 1);
    assert.equal(assertTestPresent(assertTestPresent(result.review).review).verdict, 'pass');
  } finally {
    await cleanupReviewRun(fixture);
  }
});

test('Codex does not synthesize provider evidence for an empty pre-spawn failure', async () => {
  const fixture = await prepareReviewRun('kernel-review-codex-empty-failure', 'review-codex-empty-failure-chain');
  try {
    let fallbackCalls = 0;
    const primary = createCodexAdapter({
      nativeLaunch: async () => ({
        status: 'failed',
        resultStatus: 'failed',
        errorCode: 'transport-unavailable',
        failureCategory: 'provider/infrastructure',
        failureStage: 'pre-spawn',
      }),
      parentSessionObserver: async ({ parentSessionId }) => ({
        sessionId: parentSessionId,
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
      }),
    });
    const fallback = createClaudeAdapter({
      launch: async ({ invocation }) => {
        fallbackCalls += 1;
        return {
          resolvedModel: assertTestRecord(invocation).model,
          observedModel: assertTestRecord(invocation).model,
          resolvedEffort: assertTestRecord(invocation).effort,
          observedEffort: assertTestRecord(invocation).effort,
          sessionId: 'codex-empty-failure-fallback-reviewer',
          outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://codex-empty-failure-fallback'] },
        };
      },
    });
    const result = await dispatchKernelTurn({
      controlPlane: fixture.cp,
      runId: 'review-codex-empty-failure-chain',
      adapter: primary,
      registry: createModelRegistry({ surface: 'codex', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'gpt-5.6-sol' } }),
      parentSessionId: 'review-owner',
      actionContext: REVIEW_ACTION,
      reviewFallbacks: [{
        adapter: fallback,
        registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'claude-fallback' } }),
      }],
    });

    assert.equal(fallbackCalls, 1);
    assert.equal(assertTestPresent(assertTestPresent(result.review).review).verdict, 'pass');
  } finally {
    await cleanupReviewRun(fixture);
  }
});

test('same-session reviewer integrity failure is fail-closed and does not fall back', async () => {
  const fixture = await prepareReviewRun('kernel-review-lineage', 'review-lineage-chain');
  try {
    let fallbackCalls = 0;
    const primary = createCodexAdapter({
      nativeAgentHost: {
        spawn_agent: async () => ({
          session_id: 'same-review-owner',
          terminalEvents: [{ type: 'turn.completed', model: 'gpt-5.6-sol', reasoning_effort: 'xhigh' }],
        }),
      },
      parentSessionObserver: async ({ parentSessionId }) => ({
        sessionId: parentSessionId,
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
      }),
    });
    const fallback = createClaudeAdapter({ launch: async () => { fallbackCalls += 1; return {}; } });
    const result = await dispatchKernelTurn({
      controlPlane: fixture.cp,
      runId: 'review-lineage-chain',
      adapter: primary,
      registry: createModelRegistry({ surface: 'codex', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'gpt-5.6-sol' } }),
      parentSessionId: 'same-review-owner',
      actionContext: REVIEW_ACTION,
      reviewFallbacks: [{
        adapter: fallback,
        registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'claude-frontier' } }),
      }],
    });

    assert.equal(fallbackCalls, 0);
    assert.equal(assertTestPresent(result.review).status, 'blocked');
    assert.equal(assertTestPresent(result.review).blockedReason, 'model-enforcement-failed');
  } finally {
    await cleanupReviewRun(fixture);
  }
});

test('when every reviewer transport is unavailable the dispatcher returns one final capability blocker', async () => {
  const fixture = await prepareReviewRun('kernel-review-none', 'review-none-chain');
  try {
    const result = await dispatchKernelTurn({
      controlPlane: fixture.cp,
      runId: 'review-none-chain',
      adapter: createCodexAdapter(),
      registry: createModelRegistry({ surface: 'codex', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'codex-frontier' } }),
      actionContext: REVIEW_ACTION,
      reviewFallbacks: [{
        adapter: createClaudeAdapter(),
        registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'claude-frontier' } }),
      }],
    });

    assert.equal(result.reason, 'no-independent-review-capability');
    assert.equal(assertTestPresent(result.review).blockedReason, 'no-independent-review-capability');
    assert.equal(result.reviewReceipt, null);
    assert.equal(fixture.cp.listReviewReceipts('review-none-chain').length, 0);
    const reviewerAttempts = fixture.cp.stateStore.getStepAttempts('review-none-chain')
      .filter((attempt) => fixture.cp.stateStore.getModelRouteDecision(assertTestString(attempt.routeDecisionId), { runId: 'review-none-chain' })?.role === 'reviewer');
    assert.equal(reviewerAttempts.length, 1);
    assert.equal(reviewerAttempts[0].status, 'interrupted');
  } finally {
    await cleanupReviewRun(fixture);
  }
});

test('the final fallback-eligible reviewer failure interrupts its canonical attempt', async () => {
  const fixture = await prepareReviewRun('kernel-review-final-failure', 'review-final-failure-chain');
  try {
    const result = await dispatchKernelTurn({
      controlPlane: fixture.cp,
      runId: 'review-final-failure-chain',
      adapter: createClaudeAdapter({
        launch: async () => ({
          status: 'failed',
          resultStatus: 'failed',
          errorCode: 'transport-unavailable',
          failureCategory: 'provider/infrastructure',
          failureStage: 'pre-spawn',
        }),
      }),
      registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'claude-frontier' } }),
      actionContext: REVIEW_ACTION,
    });

    assert.equal(result.reason, 'no-independent-review-capability');
    assert.equal(assertTestPresent(result.review).blockedReason, 'no-independent-review-capability');
    const reviewerAttempts = fixture.cp.stateStore.getStepAttempts('review-final-failure-chain')
      .filter((attempt) => fixture.cp.stateStore.getModelRouteDecision(assertTestString(attempt.routeDecisionId), { runId: 'review-final-failure-chain' })?.role === 'reviewer');
    assert.equal(reviewerAttempts.length, 1);
    assert.equal(reviewerAttempts[0].status, 'interrupted');
  } finally {
    await cleanupReviewRun(fixture);
  }
});

test('one trusted proof execution is shared across identical hard obligations in a report', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-proof-coalescing-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-proof-coalescing-state-'));
  const marker = path.join(runtimeHome, 'proof-execution-count.log');
  const probe = path.join(runtimeHome, 'record-proof-execution.mjs');
  await mkdir(path.join(root, '.moon-relay'), { recursive: true });
  await writeFile(path.join(root, '.moon-relay', 'track.yaml'), 'track: kernel\n');
  await writeFile(probe, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(marker)}, 'x');\n`);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    scripts: { 'test:coalesce': `node ${JSON.stringify(probe)}` },
  }));
  await writeFile(path.join(root, 'app.mjs'), 'export const value = 0;\n');
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot: root });
  try {
    await cp.startRun({
      runId: 'proof-coalescing-chain',
      objective: 'share identical hard proof execution',
      taskContract: {
        allowedPaths: ['app.mjs'],
        acceptance: ['the shared proof is recorded for every obligation'],
        requiredObligations: ['proof-a', 'proof-b'],
        requiredVerifications: [
          { obligationId: 'proof-a', method: 'unit-test', commandRefs: ['test:coalesce'] },
          { obligationId: 'proof-b', method: 'unit-test', commandRefs: ['test:coalesce'] },
        ],
      },
    });

    const result = await cp.report('proof-coalescing-chain', {
      summary: 'shared proof completed',
      changedPaths: [],
      verifications: [
        { obligationId: 'proof-a', commandRef: 'test:coalesce' },
        { obligationId: 'proof-b', commandRef: 'test:coalesce' },
      ],
    });

    assert.equal(assertTestPresent(result).status, 'completed', JSON.stringify(result));
    assert.equal((await readFile(marker, 'utf8')).length, 1, 'the trusted command must execute once');
    const verifications = cp.stateStore.getVerifications('proof-coalescing-chain');
    assert.deepEqual(
      verifications.map((verification) => verification.obligationId).sort(),
      ['default', 'proof-a', 'proof-b'],
    );
    assert.equal(new Set(verifications.map((verification) => verification.evidenceDigest)).size, 1);
    assert.equal(assertTestArray(assertTestRecord(assertTestPresent(result)).executed).filter((execution) => assertTestRecord(execution).shared).length, 2);
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('persisted failed proof does not reuse failure and reruns on identical or changed Evidence Identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-failed-proof-delta-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-failed-proof-delta-state-'));
  const marker = path.join(runtimeHome, 'proof-execution-count.log');
  const probe = path.join(runtimeHome, 'record-failed-proof.mjs');
  await mkdir(path.join(root, '.moon-relay'), { recursive: true });
  await writeFile(path.join(root, '.moon-relay', 'track.yaml'), 'track: kernel\n');
  await writeFile(probe, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(marker)}, 'x');\nprocess.exit(1);\n`);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    scripts: { 'test:fail': `node ${JSON.stringify(probe)}` },
  }));
  await writeFile(path.join(root, 'app.mjs'), 'export const value = 0;\n');
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot: root });
  const identity = ({
    sourceInputDigest = 'sha256:source-a',
    fixtureDigest = 'sha256:fixture-a',
    verifierVersion = 'proof-v1',
    nodeVersion = 'node-a',
  } = {}) => buildEvidenceIdentity({
    commandRef: 'test:fail',
    sourceInputDigest,
    fixtureDigest,
    verifierVersion,
    environment: { platform: 'test', arch: 'test', nodeVersion },
    networkPolicy: 'inherited',
  });
  const executionCount = async () => {
    try {
      return (await readFile(marker, 'utf8')).length;
    } catch {
      return 0;
    }
  };
  try {
    await cp.startRun({
      runId: 'failed-proof-delta',
      objective: 'never reuse prior failed proof across retries',
      taskContract: {
        allowedPaths: ['app.mjs'],
        acceptance: ['failed proof executes fresh on retry and on meaningful evidence delta'],
        requiredVerifications: [{ obligationId: 'default', method: 'unit-test', commandRefs: ['test:fail'] }],
      },
    });
    await cp.transition('failed-proof-delta', 'EXECUTE');
    await cp.transition('failed-proof-delta', 'PROVE');

    const first = await cp.executeProof('failed-proof-delta', {
      obligationId: 'default',
      commandRef: 'test:fail',
      evidenceIdentity: identity(),
    });
    assert.equal(first.execution.recordedStatus, 'failed');
    assert.equal(first.execution.actualCommandExecution, true);
    assert.equal(await executionCount(), 1);

    const identical = await cp.executeProof('failed-proof-delta', {
      obligationId: 'default',
      commandRef: 'test:fail',
      evidenceIdentity: identity(),
    });
    assert.equal(identical.execution.recordedStatus, 'failed');
    assert.ok(!identical.execution.reused, 'prior failed verification must not be reused');
    assert.equal(identical.execution.actualCommandExecution, true);
    assert.equal(await executionCount(), 2, 'failed verification must execute fresh rather than reusing failure');

    for (const changedIdentity of [
      identity({ sourceInputDigest: 'sha256:source-b' }),
      identity({ fixtureDigest: 'sha256:fixture-b' }),
      identity({ verifierVersion: 'proof-v2' }),
      identity({ nodeVersion: 'node-b' }),
    ]) {
      const rerun = await cp.executeProof('failed-proof-delta', {
        obligationId: 'default',
        commandRef: 'test:fail',
        evidenceIdentity: changedIdentity,
      });
      assert.equal(rerun.execution.recordedStatus, 'failed');
      assert.equal(rerun.execution.actualCommandExecution, true);
    }
    assert.equal(await executionCount(), 6, 'each retry and meaningful evidence delta must execute fresh');
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('same-report proof coalescing shares an exact reused proof before executing again', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-proof-reuse-coalescing-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-proof-reuse-coalescing-state-'));
  const marker = path.join(runtimeHome, 'proof-execution-count.log');
  const probe = path.join(runtimeHome, 'record-proof-execution.mjs');
  await mkdir(path.join(root, '.moon-relay'), { recursive: true });
  await writeFile(path.join(root, '.moon-relay', 'track.yaml'), 'track: kernel\n');
  await writeFile(probe, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(marker)}, 'x');\n`);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    scripts: { 'test:coalesce': `node ${JSON.stringify(probe)}` },
  }));
  await writeFile(path.join(root, 'app.mjs'), 'export const value = 0;\n');
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot: root });
  const contract = (obligationIds: string[]) => ({
    allowedPaths: ['app.mjs'],
    acceptance: ['the shared proof is recorded for every obligation'],
    requiredObligations: obligationIds,
    requiredVerifications: obligationIds.map((obligationId: string) => ({
      obligationId,
      method: 'unit-test',
      commandRefs: ['test:coalesce'],
    })),
  });
  try {
    await cp.startRun({
      runId: 'proof-reuse-coalescing-seed',
      objective: 'seed exact proof reuse',
      taskContract: contract(['proof-a']),
    });
    const seedResult = await cp.report('proof-reuse-coalescing-seed', {
      summary: 'seed proof completed',
      changedPaths: [],
      verifications: [{ obligationId: 'proof-a', commandRef: 'test:coalesce' }],
    });
    assert.equal(assertTestPresent(seedResult).status, 'completed', JSON.stringify(seedResult));
    assert.equal((await readFile(marker, 'utf8')).length, 1);

    await cp.startRun({
      runId: 'proof-reuse-coalescing-chain',
      objective: 'share exact reused proof execution',
      taskContract: contract(['proof-a', 'proof-b']),
    });
    const result = await cp.report('proof-reuse-coalescing-chain', {
      summary: 'reused proof completed',
      changedPaths: [],
      verifications: [
        { obligationId: 'proof-a', commandRef: 'test:coalesce' },
        { obligationId: 'proof-b', commandRef: 'test:coalesce' },
      ],
    });

    assert.equal(assertTestPresent(result).status, 'completed', JSON.stringify(result));
    assert.equal((await readFile(marker, 'utf8')).length, 1, 'exactly reused proof must not execute again');
    assert.deepEqual(
      assertTestArray(assertTestRecord(assertTestPresent(result)).executed).filter((execution) => assertTestRecord(execution).shared).map((execution) => assertTestRecord(execution).obligationId),
      ['proof-a', 'proof-b'],
    );
    const verifications = cp.stateStore.getVerifications('proof-reuse-coalescing-chain');
    assert.equal(verifications.find((verification) => verification.obligationId === 'proof-a')?.reused, undefined);
    assert.ok(verifications.find((verification) => verification.obligationId === 'proof-b')?.reuseOfVerificationId);
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('report-level flaky rerun policy reaches proof execution and blocks divergent results', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-report-flaky-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-report-flaky-state-'));
  const counterRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-report-flaky-counter-'));
  const counter = path.join(counterRoot, 'n');
  try {
    await mkdir(path.join(root, '.moon-relay'), { recursive: true });
    await writeFile(path.join(root, '.moon-relay', 'track.yaml'), 'track: kernel\n');
    await writeFile(path.join(root, 'flaky.cjs'), [
      'const fs=require("fs");',
      `const p=${JSON.stringify(counter)};`,
      'let n=0; try{n=Number(fs.readFileSync(p,"utf8"))||0}catch{}',
      'fs.writeFileSync(p,String(n+1));',
      'process.exit(n===0?1:0);',
    ].join('\n'));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      scripts: { 'test:flaky': 'node flaky.cjs' },
    }));
    await writeFile(path.join(root, 'app.mjs'), 'export const value = 0;\n');
    const cp = await createKernelControlPlane({ runtimeHome, projectRoot: root });
    try {
      await cp.startRun({
        runId: 'report-flaky-chain',
        objective: 'preserve flaky proof policy',
        taskContract: {
          allowedPaths: ['app.mjs'],
          acceptance: ['flaky proof remains blocking'],
          requiredObligations: ['default'],
          requiredVerifications: [{ obligationId: 'default', method: 'unit-test', commandRefs: ['test:flaky'] }],
        },
      });

      const result = await cp.report('report-flaky-chain', {
        summary: 'run flaky proof through report',
        changedPaths: [],
        verifications: [{ commandRef: 'test:flaky', flakyRerun: true }],
      });

      assert.equal(assertTestPresent(result).status, 'evidence-failed', JSON.stringify(result));
      assert.equal((await readFile(counter, 'utf8')), '2', 'flaky policy must execute the command twice');
      const execution = assertTestArray(assertTestRecord(assertTestPresent(result)).executed).find((entry: unknown) => assertTestRecord(entry).obligationId === 'default');
      assert.equal(assertTestRecord(execution).flaky, true);
      assert.equal(assertTestRecord(execution).status, 'failed');
      assert.match(assertTestString(assertTestRecord(assertTestArray(assertTestRecord(assertTestPresent(result)).failures).find((failure) => assertTestRecord(failure).obligationId === 'default')).errorSummary), /flaky/);
    } finally {
      await cp.close();
    }
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
    await rm(counterRoot, { recursive: true, force: true });
  }
});

test('flaky report requests bypass prior reusable proof evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-report-flaky-reuse-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-report-flaky-reuse-state-'));
  const counterRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-report-flaky-reuse-counter-'));
  const counter = path.join(counterRoot, 'n');
  try {
    await mkdir(path.join(root, '.moon-relay'), { recursive: true });
    await writeFile(path.join(root, '.moon-relay', 'track.yaml'), 'track: kernel\n');
    await writeFile(path.join(root, 'flaky.cjs'), [
      'const fs=require("fs");',
      `const p=${JSON.stringify(counter)};`,
      'let n=0; try{n=Number(fs.readFileSync(p,"utf8"))||0}catch{}',
      'fs.writeFileSync(p,String(n+1));',
      'process.exit(n===1?1:0);',
    ].join('\n'));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      scripts: { 'test:flaky': 'node flaky.cjs' },
    }));
    await writeFile(path.join(root, 'app.mjs'), 'export const value = 0;\n');
    const cp = await createKernelControlPlane({ runtimeHome, projectRoot: root });
    const contract = {
      allowedPaths: ['app.mjs'],
      acceptance: ['flaky proof is never satisfied by reused evidence'],
      requiredObligations: ['default'],
      requiredVerifications: [{ obligationId: 'default', method: 'unit-test', commandRefs: ['test:flaky'] }],
    };
    try {
      await cp.startRun({ runId: 'report-flaky-reuse-seed', objective: 'seed reusable evidence', taskContract: contract });
      const seed = await cp.report('report-flaky-reuse-seed', {
        summary: 'seed a passing proof',
        changedPaths: [],
        verifications: [{ commandRef: 'test:flaky', acceptanceCoverage: ['AC-1'] }],
      });
      assert.equal(assertTestPresent(seed).status, 'completed', JSON.stringify(seed));
      assert.equal((await readFile(counter, 'utf8')), '1');

      await cp.startRun({ runId: 'report-flaky-reuse-chain', objective: 'force a fresh flaky proof', taskContract: contract });
      const result = await cp.report('report-flaky-reuse-chain', {
        summary: 'rerun the flaky proof',
        changedPaths: [],
        verifications: [{ commandRef: 'test:flaky', flakyRerun: true, acceptanceCoverage: ['AC-1'] }],
      });

      assert.equal(assertTestPresent(result).status, 'evidence-failed', JSON.stringify(result));
      assert.equal((await readFile(counter, 'utf8')), '3', 'flaky policy must bypass reusable evidence and execute twice');
      const execution = assertTestArray(assertTestRecord(assertTestPresent(result)).executed).find((entry: unknown) => assertTestRecord(entry).obligationId === 'default');
      assert.equal(assertTestRecord(execution).flaky, true);
      assert.equal(assertTestRecord(execution).status, 'failed');
    } finally {
      await cp.close();
    }
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
    await rm(counterRoot, { recursive: true, force: true });
  }
});

test('automatic review transport resolver discovers alternate host adapters without caller reviewFallbacks', async () => {
  const fixture = await prepareReviewRun('kernel-review-auto-resolve', 'review-auto-resolve-chain');
  try {
    let fallbackCalls = 0;
    const primary = createCodexAdapter({
      nativeLaunch: async ({ invocation }) => ({
        status: 'failed',
        resultStatus: 'failed',
        errorCode: 'transport-unavailable',
        failureCategory: 'provider/infrastructure',
        failureStage: 'pre-spawn',
        resolvedModel: assertTestRecord(invocation).model,
        observedModel: assertTestRecord(invocation).model,
        resolvedEffort: assertTestRecord(invocation).effort,
        observedEffort: assertTestRecord(invocation).effort,
      }),
      parentSessionObserver: async ({ parentSessionId }) => ({
        sessionId: parentSessionId,
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
      }),
    });

    const compatibilityInput17 = {
      controlPlane: fixture.cp,
      runId: 'review-auto-resolve-chain',
      adapter: primary,
      env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'claude-frontier' },
      parentSessionId: 'review-owner',
      actionContext: REVIEW_ACTION,
      overrides: {
        claudeLauncher: async ({ invocation }: Parameters<NonNullable<NonNullable<Parameters<typeof createClaudeAdapter>[0]>["launch"]>>[0]) => {
          fallbackCalls += 1;
          return {
            resolvedModel: assertTestRecord(invocation).model,
            observedModel: assertTestRecord(invocation).model,
            resolvedEffort: assertTestRecord(invocation).effort,
            observedEffort: assertTestRecord(invocation).effort,
            sessionId: 'auto-discovered-reviewer',
            outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://auto-discovered'] },
          };
        },
      },
      // Note: NO reviewFallbacks, NO hostAdapters, NO reviewTransports passed!
    };
    const result = await dispatchKernelTurn(compatibilityInput17);

    assert.equal(fallbackCalls, 1);
    assert.equal(assertTestPresent(assertTestPresent(result.review).review).verdict, 'pass');
    assert.equal(fixture.cp.listReviewReceipts('review-auto-resolve-chain').length, 1);
  } finally {
    await cleanupReviewRun(fixture);
  }
});

test('review transport resolver ignores un-attested capability-shaped candidates', () => {
  const untrusted = createClaudeAdapter({
    launch: async () => ({
      status: 'completed',
      resolvedModel: 'untrusted-model',
      observedModel: 'untrusted-model',
      resolvedEffort: 'xhigh',
      observedEffort: 'xhigh',
      sessionId: 'untrusted-reviewer',
      outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: [] },
    }),
  });
  const resolved = resolveReviewTransports({
    adapter: createCodexAdapter({ nativeAgentHost: {} }),
    reviewFallbacks: [{
      adapter: untrusted,
      registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'untrusted-model' } }),
    }],
  });
  assert.equal(resolved.some((candidate) => candidate.adapter === untrusted), false);
});

test('same-provider reviewer fallback is preferred over a cross-provider fallback', async () => {
  const fixture = await prepareReviewRun('kernel-review-provider-priority', 'review-provider-priority-chain');
  try {
    let sameProviderCalls = 0;
    let crossProviderCalls = 0;
    const parentSessionObserver = async ({ parentSessionId }: { parentSessionId?: unknown }) => ({
      sessionId: parentSessionId,
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
    });
    const primary = createCodexAdapter({
      nativeLaunch: async () => ({
        status: 'failed',
        resultStatus: 'failed',
        errorCode: 'transport-unavailable',
        failureCategory: 'provider/infrastructure',
        failureStage: 'pre-spawn',
      }),
      parentSessionObserver,
    });
    const sameProvider = createCodexAdapter({
      nativeLaunch: async ({ invocation }) => {
        sameProviderCalls += 1;
        return {
          sessionId: 'same-provider-reviewer',
          terminalEvents: [{ type: 'turn.completed', model: assertTestRecord(invocation).model, reasoning_effort: assertTestRecord(invocation).effort }],
          outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://same-provider'] },
        };
      },
      parentSessionObserver,
    });
    const crossProvider = createClaudeAdapter({
      launch: async ({ invocation }) => {
        crossProviderCalls += 1;
        return {
          resolvedModel: assertTestRecord(invocation).model,
          observedModel: assertTestRecord(invocation).model,
          resolvedEffort: assertTestRecord(invocation).effort,
          observedEffort: assertTestRecord(invocation).effort,
          sessionId: 'cross-provider-reviewer',
          outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://cross-provider'] },
        };
      },
    });

    const result = await dispatchKernelTurn({
      controlPlane: fixture.cp,
      runId: 'review-provider-priority-chain',
      adapter: primary,
      registry: createModelRegistry({ surface: 'codex', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'gpt-5.6-sol' } }),
      parentSessionId: 'review-owner',
      actionContext: REVIEW_ACTION,
      // Deliberately put the cross-provider candidate first. Resolver policy,
      // not caller ordering, must select the same-provider transport first.
      reviewFallbacks: [
        {
          adapter: crossProvider,
          registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'claude-frontier' } }),
        },
        {
          adapter: sameProvider,
          registry: createModelRegistry({ surface: 'codex', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'gpt-5.6-sol' } }),
        },
      ],
    });

    assert.equal(sameProviderCalls, 1);
    assert.equal(crossProviderCalls, 0);
    assert.equal(assertTestRecord(assertTestPresent(result.hostDirective).hostCapabilities).surface, 'codex');
    assert.equal(assertTestRecord(result.dispatch).actorSessionId, 'same-provider-reviewer');
    assert.equal(assertTestPresent(assertTestPresent(result.review).review).verdict, 'pass');
    assert.equal(fixture.cp.listReviewReceipts('review-provider-priority-chain').length, 1);
  } finally {
    await cleanupReviewRun(fixture);
  }
});

test('Case A DoD: a pure Codex environment completes independent review with a fresh native reviewer without Claude', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-review-codex-pure-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-review-codex-pure-state-'));
  await mkdir(path.join(root, '.moon-relay'), { recursive: true });
  await writeFile(path.join(root, '.moon-relay', 'track.yaml'), 'track: kernel\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'node -e "process.exit(0)"' } }));
  await writeFile(path.join(root, 'app.mjs'), 'export const value = 0;\n');
  const runId = 'pure-codex-review-chain';
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot: root });
  try {
    await cp.startRun({
      runId,
      objective: 'secure change in pure codex environment',
      taskContract: {
        surfaces: ['security_boundary'],
        acceptance: ['secure'],
        allowedPaths: ['app.mjs'],
      },
    });

    const ownerSessionId = 'codex-owner-session-a';
    const implementationSessionId = 'codex-implementation-session-a';
    const implementer = createCodexAdapter({
      nativeAgentHost: {
        spawn_agent: async ({ model, reasoning_effort: reasoningEffort }) => ({
          session_id: implementationSessionId,
          terminalEvents: [{ type: 'turn.completed', model, reasoning_effort: reasoningEffort }],
        }),
      },
      parentSessionObserver: async () => ({ sessionId: ownerSessionId, model: 'gpt-5.6-sol', effort: 'medium' }),
    });

    const implementation = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter: implementer,
      registry: createModelRegistry({ surface: 'codex', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'gpt-5.6-sol', MOON_RELAY_KERNEL_MODEL_VALUE: 'gpt-5.6-sol' } }),
      parentSessionId: ownerSessionId,
      actionContext: { executionMode: 'native-subagent', delegationRequested: true },
    });
    assert.equal(implementation.dispatched, true);
    assert.equal(assertTestRecord(implementation.dispatch).status, 'completed');
    assert.equal(assertTestRecord(implementation.dispatch).actorSessionId, implementationSessionId);

    await writeFile(path.join(root, 'app.mjs'), 'export const value = 1;\n');
    await cp.report(runId, {
      summary: 'implemented by codex owner',
      capsuleId: assertTestPresent(implementation.executionCapsule).capsuleId,
      stepId: assertTestPresent(implementation.executionCapsule).stepId,
      changedPaths: ['app.mjs'],
    });

    await cp.transition(runId, 'EXECUTE');
    await cp.transition(runId, 'PROVE');
    const reviewedRun = await cp.getRun(runId);

    const reviewPolicy = resolveCodexModelPolicy({ executionClass: 'review' });
    let spawnedReviewerRequest: unknown = null;
    const freshReviewerSessionId = 'codex-fresh-reviewer-session-b';
    const reviewer = createCodexAdapter({
      nativeAgentHost: {
        spawn_agent: async (payload) => {
          spawnedReviewerRequest = payload;
          return {
            session_id: freshReviewerSessionId,
            terminalEvents: [{ type: 'turn.completed', model: reviewPolicy.model, reasoning_effort: reviewPolicy.effort }],
            outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://codex-native'] },
          };
        },
      },
      parentSessionObserver: async ({ parentSessionId }) => ({
        sessionId: parentSessionId,
        model: reviewPolicy.model,
        effort: reviewPolicy.effort,
      }),
    });

    // Pure Codex environment: NO Claude launcher, NO reviewFallbacks, NO hostAdapters, NO reviewTransports
    const result = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter: reviewer,
      registry: createModelRegistry({ surface: 'codex', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: assertTestString(reviewPolicy.model) } }),
      parentSessionId: ownerSessionId,
      actionContext: {
        actionKind: 'review_engineering',
        obligationId: 'security-review',
        changedPaths: ['app.mjs'],
      },
      overrides: {}, // NO claudeLauncher
    });

    assert.equal(result.dispatched, true);
    assert.equal(assertTestRecord(assertTestPresent(result.hostDirective).hostCapabilities).surface, 'codex');
    assert.equal(assertTestRecord(result.dispatch).dispatchMechanism, 'native-subagent');
    assert.equal(assertTestRecord(result.dispatch).actorSessionId, freshReviewerSessionId);
    assert.notEqual(assertTestRecord(result.dispatch).actorSessionId, ownerSessionId);
    assert.equal(assertTestRecord(spawnedReviewerRequest).parent_session_id, ownerSessionId);
    assert.equal(assertTestRecord(spawnedReviewerRequest).task_name, 'kernel_reviewer');
    assert.equal(assertTestRecord(assertTestRecord(spawnedReviewerRequest).child_session).canCommit, false);
    assert.equal(assertTestRecord(assertTestRecord(spawnedReviewerRequest).child_session).freshSessionRequired, undefined);
    assert.equal(assertTestRecord(spawnedReviewerRequest).execution_capsule, undefined);
    assert.equal(assertTestRecord(spawnedReviewerRequest).execution_contract, undefined);
    assert.doesNotMatch(assertTestString(assertTestRecord(spawnedReviewerRequest).message), /"role"|"permissions"|"nonGoals"|executionCapsule|executionContract/);
    assert.equal(assertTestPresent(assertTestPresent(result.review).review).verdict, 'pass');
    assert.match(assertTestString(result.reviewReceiptId), /^review-receipt-[a-f0-9]{24}$/);
    assert.equal(assertTestPresent(assertTestPresent(result.reviewReceipt).reviewer).usageReceiptId, assertTestRecord(result.receipt).receiptId);
    assert.equal(assertTestPresent(assertTestPresent(result.reviewReceipt).subject).mutationRevision, assertTestPresent(reviewedRun).mutationRevision);
    assert.equal(cp.listReviewReceipts(runId).length, 1);
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('reviewer admission fails closed when observed model mismatches requested policy (requested Astra/high, observed Sol/xhigh)', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-review-mismatch-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-review-mismatch-state-'));
  await mkdir(path.join(root, '.moon-relay'), { recursive: true });
  await writeFile(path.join(root, '.moon-relay', 'track.yaml'), 'track: kernel\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'node -e "process.exit(0)"' } }));
  await writeFile(path.join(root, 'app.mjs'), 'export const value = 0;\n');
  const runId = 'mismatch-review-chain';
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot: root });
  try {
    await cp.startRun({
      runId,
      objective: 'secure change with model mismatch',
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

    // Observed model is gpt-5.6-sol / xhigh while requested policy is gpt-6-astra / high
    const reviewer = createCodexAdapter({
      nativeAgentHost: {
        spawn_agent: async () => ({
          session_id: 'mismatched-session',
          terminalEvents: [{ type: 'turn.completed', model: 'gpt-5.6-sol', reasoning_effort: 'xhigh' }],
          outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://mismatch'] },
        }),
      },
      parentSessionObserver: async ({ parentSessionId }) => ({
        sessionId: parentSessionId,
        model: 'gpt-6-astra',
        effort: 'high',
      }),
    });

    const result = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter: reviewer,
      registry: createModelRegistry({ surface: 'codex' }),
      parentSessionId: 'mismatch-owner-session',
      actionContext: {
        actionKind: 'review_engineering',
        obligationId: 'security-review',
        changedPaths: ['app.mjs'],
      },
    });

    // Mismatched model must fail admission: no review receipt minted
    assert.equal(result.reviewReceiptId || null, null);
    assert.equal(cp.listReviewReceipts(runId).length, 0);
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('S3 review crash recovery: post-receipt proof failure preserves reviewReceiptId and resumes with 0 extra reviewer runs', async () => {
  const fixture = await prepareReviewRun('kernel-review-crash-w1', 'review-crash-w1');
  try {
    let reviewerCalls = 0;
    const reviewer = createClaudeAdapter({
      launch: async ({ invocation }) => {
        reviewerCalls += 1;
        return {
          resolvedModel: assertTestRecord(invocation).model,
          observedModel: assertTestRecord(invocation).model,
          resolvedEffort: assertTestRecord(invocation).effort,
          observedEffort: assertTestRecord(invocation).effort,
          sessionId: 'crash-w1-reviewer',
          outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://crash-w1'] },
        };
      },
    });
    const registry = createModelRegistry({
      surface: 'claude',
      env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'crash-frontier', MOON_RELAY_KERNEL_MODEL_FRONTIER_EFFORT: 'high' },
    });

    // Inject a failure right after ReviewReceipt persistence, before Judgment Proof is recorded.
    const origRecordProof = fixture.cp.recordProof.bind(fixture.cp);
    fixture.cp.recordProof = async () => {
      throw Object.assign(new Error('injected proof write failure'), { code: 'injected_proof_failure' });
    };

    const interrupted = await dispatchKernelTurn({
      controlPlane: fixture.cp,
      runId: 'review-crash-w1',
      adapter: reviewer,
      registry,
      actionContext: REVIEW_ACTION,
    });
    assert.equal(reviewerCalls, 1);
    const savedReceiptId = assertTestString(interrupted.reviewReceiptId);
    assert.match(savedReceiptId, /^review-receipt-[a-f0-9]{24}$/);
    const interruptedReview = assertTestRecord(interrupted.review);
    assert.equal(interruptedReview.reviewReceiptAccepted, true);
    assert.equal(interruptedReview.proofSettled, false);
    assert.equal(interruptedReview.blockedReason, 'injected_proof_failure');
    assert.notEqual(interruptedReview.blockedReason, 'incomplete_review_chain');
    assert.equal(assertTestRecord(interrupted.blocker).reason, 'injected_proof_failure');
    assert.equal(fixture.cp.listReviewReceipts('review-crash-w1').length, 1);
    assert.equal(
      fixture.cp.stateStore.getVerifications('review-crash-w1').some((v) => v.obligationId === 'security-review'),
      false,
      'judgment proof must not exist yet after crash window 1',
    );
    assert.equal((await fixture.cp.getRun('review-crash-w1'))?.status, 'active');

    // Restore normal control plane in a fresh instance (simulating new process)
    fixture.cp.recordProof = origRecordProof;
    await fixture.cp.close();

    const freshCp = await createKernelControlPlane({ runtimeHome: fixture.runtimeHome, projectRoot: fixture.root });
    try {
      const resumedNext = assertTestRecord(await freshCp.next('review-crash-w1'));
      assert.equal(reviewerCalls, 1, 'resuming from saved receipt must run reviewer 0 additional times');
      assert.equal(assertTestRecord(resumedNext.action).type, 'done', JSON.stringify(resumedNext));
      assert.deepEqual(resumedNext.recoveredReviewReceiptIds, [savedReceiptId]);
      assert.equal(assertTestRecord(resumedNext.finalization).completionStatus, 'accepted');
      assert.equal(assertTestRecord(resumedNext.finalization).finalizationStatus, 'completed');
      assert.equal(freshCp.listReviewReceipts('review-crash-w1').length, 1);
      assert.equal(freshCp.listReviewReceipts('review-crash-w1')[0].receiptId, savedReceiptId);
      const judgmentProofs = freshCp.stateStore.getVerifications('review-crash-w1')
        .filter((v) => v.obligationId === 'security-review');
      assert.equal(judgmentProofs.length, 1);
      assert.equal(judgmentProofs[0].evidenceRef, `review://review-crash-w1/${savedReceiptId}`);
      assert.equal((await freshCp.getRun('review-crash-w1'))?.status, 'completed');
    } finally {
      await freshCp.close();
    }
  } finally {
    await rm(fixture.runtimeHome, { recursive: true, force: true });
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('S3 review crash recovery: cross-process exits after receipt write and after proof write both resume on same receiptId with 0 reviewer reruns', async () => {
  for (const crashPhase of ['after-receipt', 'after-proof'] as const) {
    const runId = `review-subproc-${crashPhase}`;
    const fixture = await prepareReviewRun(`kernel-review-${crashPhase}`, runId);
    const coordDir = await mkdtemp(path.join(os.tmpdir(), `kernel-review-coord-${crashPhase}-`));
    try {
      await fixture.cp.close();
      const cpUrl = pathToFileURL(path.resolve('scripts/host/kernel/control-plane-runtime.js')).href;
      const dispUrl = pathToFileURL(path.resolve('scripts/host/kernel/turn-dispatcher.js')).href;
      const claudeUrl = pathToFileURL(path.resolve('scripts/host/kernel/adapters/claude.js')).href;
      const regUrl = pathToFileURL(path.resolve('scripts/host/kernel/model-registry.js')).href;
      const scriptPath = path.join(coordDir, 'crash-child.mjs');
      await writeFile(scriptPath, `
import { createKernelControlPlane } from '${cpUrl}';
import { dispatchKernelTurn } from '${dispUrl}';
import { createClaudeAdapter } from '${claudeUrl}';
import { createModelRegistry } from '${regUrl}';

const [runtimeHome, projectRoot, runId, crashPhase] = process.argv.slice(2);
const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
if (crashPhase === 'after-receipt') {
  const orig = cp.stateStore.recordReviewReceipt.bind(cp.stateStore);
  cp.stateStore.recordReviewReceipt = (...args) => {
    const saved = orig(...args);
    process.stdout.write(JSON.stringify({ crashedAt: crashPhase, reviewReceiptId: saved.receiptId }) + '\\n');
    process.exit(0);
  };
} else {
  const orig = cp.recordProof.bind(cp);
  cp.recordProof = async (...args) => {
    const updated = await orig(...args);
    const receipt = cp.listReviewReceipts(runId).at(-1);
    process.stdout.write(JSON.stringify({ crashedAt: crashPhase, reviewReceiptId: receipt?.receiptId || null }) + '\\n');
    process.exit(0);
  };
}
const reviewer = createClaudeAdapter({
  launch: async ({ invocation }) => ({
    resolvedModel: invocation.model,
    observedModel: invocation.model,
    resolvedEffort: invocation.effort,
    observedEffort: invocation.effort,
    sessionId: 'subproc-reviewer-' + crashPhase,
    outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://' + crashPhase] },
  }),
});
await dispatchKernelTurn({
  controlPlane: cp,
  runId,
  adapter: reviewer,
  registry: createModelRegistry({
    surface: 'claude',
    env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'subproc-frontier', MOON_RELAY_KERNEL_MODEL_FRONTIER_EFFORT: 'high' },
  }),
  actionContext: {
    actionKind: 'review_engineering',
    obligationId: 'security-review',
    executionMode: 'native-subagent',
    delegationRequested: true,
    changedPaths: ['app.mjs'],
  },
});
process.exit(3);
`);
      const child = spawnSync(process.execPath, [scriptPath, fixture.runtimeHome, fixture.root, runId, crashPhase], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 30000,
      });
      assert.equal(child.status, 0, child.stderr || child.stdout);
      const crashedInfo = assertTestRecord(JSON.parse(assertTestString(child.stdout.trim().split(/\r?\n/).at(-1))));
      const receiptId = assertTestString(crashedInfo.reviewReceiptId);
      assert.match(receiptId, /^review-receipt-[a-f0-9]{24}$/);

      // Fresh process resumes via dispatchKernelTurn (must deduplicate & settle with 0 reviewer calls)
      const freshCp = await createKernelControlPlane({ runtimeHome: fixture.runtimeHome, projectRoot: fixture.root });
      try {
        const proofCountBefore = freshCp.stateStore.getVerificationHistory(runId).length;
        if (crashPhase === 'after-receipt') {
          assert.equal(freshCp.stateStore.getVerifications(runId).some((v) => v.obligationId === 'security-review'), false);
        } else {
          assert.equal(freshCp.stateStore.getVerifications(runId).some((v) => v.obligationId === 'security-review'), true);
        }
        assert.equal((await freshCp.getRun(runId))?.status, 'active');

        let rerunCalls = 0;
        const guardReviewer = createClaudeAdapter({
          launch: async () => {
            rerunCalls += 1;
            throw new Error('reviewer must not run again during recovery');
          },
        });
        const recovered = await dispatchKernelTurn({
          controlPlane: freshCp,
          runId,
          adapter: guardReviewer,
          registry: createModelRegistry({
            surface: 'claude',
            env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'subproc-frontier', MOON_RELAY_KERNEL_MODEL_FRONTIER_EFFORT: 'high' },
          }),
          actionContext: REVIEW_ACTION,
        });
        assert.equal(rerunCalls, 0, `${crashPhase}: reviewer must not execute again`);
        assert.equal(recovered.deduplicated, true);
        assert.equal(recovered.reviewReceiptId, receiptId);
        assert.equal(assertTestRecord(assertTestRecord(recovered.next).action).type, 'done');
        assert.equal(assertTestRecord(recovered.finalization).finalizationStatus, 'completed');
        assert.equal(freshCp.listReviewReceipts(runId).length, 1);
        assert.equal(
          freshCp.stateStore.getVerificationHistory(runId).length,
          crashPhase === 'after-receipt' ? proofCountBefore + 1 : proofCountBefore,
          `${crashPhase}: settle only missing proof`,
        );
        assert.equal((await freshCp.getRun(runId))?.status, 'completed');
      } finally {
        await freshCp.close();
      }
    } finally {
      await rm(coordDir, { recursive: true, force: true });
      await rm(fixture.runtimeHome, { recursive: true, force: true });
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('S3 review recovery fail-closed: workspace drift after receipt returns real blocker + receiptId; bare usage receipt is never accepted', async () => {
  // 1. Bare usage receipt without ReviewReceipt must never settle or satisfy security-review.
  const usageFixture = await prepareReviewRun('kernel-review-usage-only', 'review-usage-only');
  try {
    const failingReviewer = createClaudeAdapter({
      launch: async ({ invocation }) => ({
        resolvedModel: assertTestRecord(invocation).model,
        observedModel: assertTestRecord(invocation).model,
        resolvedEffort: assertTestRecord(invocation).effort,
        observedEffort: assertTestRecord(invocation).effort,
        sessionId: 'usage-only-reviewer',
        status: 'failed',
        outcome: null,
      }),
    });
    await dispatchKernelTurn({
      controlPlane: usageFixture.cp,
      runId: 'review-usage-only',
      adapter: failingReviewer,
      registry: createModelRegistry({
        surface: 'claude',
        env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'drift-frontier', MOON_RELAY_KERNEL_MODEL_FRONTIER_EFFORT: 'high' },
      }),
      actionContext: REVIEW_ACTION,
    });
    assert.ok(usageFixture.cp.stateStore.listModelUsageReceipts('review-usage-only').length >= 1);
    assert.equal(usageFixture.cp.listReviewReceipts('review-usage-only').length, 0);
    const nextAfterUsageOnly = assertTestRecord(await usageFixture.cp.next('review-usage-only'));
    assert.equal(assertTestRecord(nextAfterUsageOnly.action).type, 'review', 'bare usage receipt must not be treated as accepted review');
    assert.equal((await usageFixture.cp.getRun('review-usage-only'))?.status, 'active');
  } finally {
    await cleanupReviewRun(usageFixture);
  }

  // 2. Save a real ReviewReceipt, interrupt before recordProof, then mutate the workspace!
  const driftFixture = await prepareReviewRun('kernel-review-drift', 'review-drift');
  try {
    const origRecordProof = driftFixture.cp.recordProof.bind(driftFixture.cp);
    driftFixture.cp.recordProof = async () => {
      throw new Error('crash-before-proof');
    };
    const passingReviewer = createClaudeAdapter({
      launch: async ({ invocation }) => ({
        resolvedModel: assertTestRecord(invocation).model,
        observedModel: assertTestRecord(invocation).model,
        resolvedEffort: assertTestRecord(invocation).effort,
        observedEffort: assertTestRecord(invocation).effort,
        sessionId: 'drift-passing-reviewer',
        outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://drift'] },
      }),
    });
    const accepted = await dispatchKernelTurn({
      controlPlane: driftFixture.cp,
      runId: 'review-drift',
      adapter: passingReviewer,
      registry: createModelRegistry({
        surface: 'claude',
        env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'drift-frontier', MOON_RELAY_KERNEL_MODEL_FRONTIER_EFFORT: 'high' },
      }),
      actionContext: REVIEW_ACTION,
    });
    const receiptId = assertTestString(accepted.reviewReceiptId);
    driftFixture.cp.recordProof = origRecordProof;

    // Mutate workspace before recovery -> unrecoverable drift must fail closed with original receiptId + actual reason
    await writeFile(path.join(driftFixture.root, 'app.mjs'), 'export const value = 999;\n');
    const blockedOnDrift = assertTestRecord(await driftFixture.cp.next('review-drift'));
    assert.equal(blockedOnDrift.status, 'blocked');
    assert.equal(blockedOnDrift.blockedReason, 'review_workspace_identity_changed');
    assert.equal(blockedOnDrift.reviewReceiptId, receiptId);
    assert.notEqual(assertTestRecord(blockedOnDrift.action).type, 'done');
    assert.equal((await driftFixture.cp.getRun('review-drift'))?.status, 'active');
  } finally {
    await cleanupReviewRun(driftFixture);
  }
});

test('S3 settlement guards: lease conflict blocks settlement without promoting to done, and multi-obligation stays in review until last passes', async () => {
  const fixture = await prepareReviewRun('kernel-review-guards', 'review-guards');
  try {
    // Acquire live lease from a competing holder before review settles
    const competing = fixture.cp.stateStore.acquireLease('review-guards', { holder: 'competing-runner', ttlMs: 60000 });
    assert.equal(competing.acquired, true);

    const reviewer = createClaudeAdapter({
      launch: async ({ invocation }) => ({
        resolvedModel: assertTestRecord(invocation).model,
        observedModel: assertTestRecord(invocation).model,
        resolvedEffort: assertTestRecord(invocation).effort,
        observedEffort: assertTestRecord(invocation).effort,
        sessionId: 'lease-guard-reviewer',
        outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://lease-guard'] },
      }),
    });
    const result = await dispatchKernelTurn({
      controlPlane: fixture.cp,
      runId: 'review-guards',
      adapter: reviewer,
      registry: createModelRegistry({
        surface: 'claude',
        env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'guard-frontier', MOON_RELAY_KERNEL_MODEL_FRONTIER_EFFORT: 'high' },
      }),
      actionContext: REVIEW_ACTION,
    });
    const receiptId = assertTestString(result.reviewReceiptId);
    assert.equal(assertTestRecord(result.review).blockedReason, 'lease-conflict');
    assert.equal((await fixture.cp.getRun('review-guards'))?.status, 'active');

    // Authorized next while lease is still held must also fail closed with lease-conflict (never done)
    const blockedNext = assertTestRecord(await fixture.cp.next('review-guards'));
    assert.equal(blockedNext.status, 'lease-conflict');
    assert.notEqual(assertTestRecord(blockedNext.action).type, 'done');
    assert.equal((await fixture.cp.getRun('review-guards'))?.status, 'active');

    // Release competing lease -> authorized next now settles to done with 0 new receipts
    fixture.cp.stateStore.releaseLease('review-guards', { holder: 'competing-runner', fencingToken: competing.lease.fencingToken });
    const settled = assertTestRecord(await fixture.cp.next('review-guards'));
    assert.equal(assertTestRecord(settled.action).type, 'done');
    assert.equal(fixture.cp.listReviewReceipts('review-guards').length, 1);
    assert.equal(fixture.cp.listReviewReceipts('review-guards')[0].receiptId, receiptId);
    assert.equal((await fixture.cp.getRun('review-guards'))?.status, 'completed');
  } finally {
    await cleanupReviewRun(fixture);
  }
});

test('S3 multi-obligation review: Run stays in review after 1st judgment passes and settles to done only when last judgment passes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-review-multi-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-review-multi-state-'));
  const runId = 'review-multi-obligation';
  await mkdir(path.join(root, '.moon-relay'), { recursive: true });
  await writeFile(path.join(root, '.moon-relay', 'track.yaml'), 'track: kernel\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' } }));
  await writeFile(path.join(root, 'app.mjs'), 'export const value = 0;\n');
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot: root });
  try {
    await cp.startRun({
      runId,
      objective: 'multi-judgment change',
      taskContract: {
        surfaces: ['security_boundary'],
        acceptance: [
          { id: 'AC-1', acceptance: 'unit tests pass', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: 'default' } },
          { id: 'AC-2', acceptance: 'design review passes', evidencePlan: { class: 'judgment', method: 'review', obligationId: 'judgment-ac-2' } },
        ],
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
    const impl = await dispatchKernelTurn({
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
      capsuleId: assertTestPresent(impl.executionCapsule).capsuleId,
      stepId: assertTestPresent(impl.executionCapsule).stepId,
      changedPaths: ['app.mjs'],
      verifications: [{ obligationId: 'default', commandRef: 'test', acceptanceCoverage: ['AC-1'] }],
    });

    const reviewer = createClaudeAdapter({
      launch: async ({ invocation }) => ({
        resolvedModel: assertTestRecord(invocation).model,
        observedModel: assertTestRecord(invocation).model,
        resolvedEffort: assertTestRecord(invocation).effort,
        observedEffort: assertTestRecord(invocation).effort,
        sessionId: `${runId}-reviewer`,
        outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://multi'] },
      }),
    });
    const registry = createModelRegistry({
      surface: 'claude',
      env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'multi-frontier', MOON_RELAY_KERNEL_MODEL_FRONTIER_EFFORT: 'high' },
    });

    // 1st judgment passes: 2nd judgment still pending -> must NOT settle to done!
    const firstReview = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter: reviewer,
      registry,
      actionContext: { ...REVIEW_ACTION, obligationId: 'security-review' },
    });
    assert.ok(firstReview.reviewReceiptId);
    assert.equal(assertTestRecord(assertTestRecord(firstReview.next).action).type, 'review');
    assert.deepEqual(assertTestRecord(assertTestRecord(firstReview.next).action).outstandingObligations, ['judgment-ac-2']);
    assert.equal((await cp.getRun(runId))?.status, 'active');

    // 2nd (last) judgment passes -> Kernel settles directly to done!
    const secondReview = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter: reviewer,
      registry,
      actionContext: { ...REVIEW_ACTION, obligationId: 'judgment-ac-2' },
    });
    assert.ok(secondReview.reviewReceiptId);
    assert.equal(assertTestRecord(assertTestRecord(secondReview.next).action).type, 'done');
    assert.equal(assertTestRecord(secondReview.finalization).finalizationStatus, 'completed');
    assert.equal((await cp.getRun(runId))?.status, 'completed');
    assert.equal(cp.listReviewReceipts(runId).length, 2);
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('S3 P1 post-receipt boundary: prepareNext failure after recordProof preserves reviewReceiptId and resumes with 0 extra reviewer runs', async () => {
  const fixture = await prepareReviewRun('kernel-review-prepnext-fail', 'review-prepnext-fail');
  try {
    let reviewerCalls = 0;
    const reviewer = createClaudeAdapter({
      launch: async ({ invocation }) => {
        reviewerCalls += 1;
        return {
          resolvedModel: assertTestRecord(invocation).model,
          observedModel: assertTestRecord(invocation).model,
          resolvedEffort: assertTestRecord(invocation).effort,
          observedEffort: assertTestRecord(invocation).effort,
          sessionId: 'prepnext-fail-reviewer',
          outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://prepnext-fail'] },
        };
      },
    });
    const registry = createModelRegistry({
      surface: 'claude',
      env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'prepnext-frontier', MOON_RELAY_KERNEL_MODEL_FRONTIER_EFFORT: 'high' },
    });

    // Let persistReviewReceipt AND recordProof succeed; inject a failure inside prepareNext!
    const origPrepareNext = fixture.cp.prepareNext.bind(fixture.cp);
    const origRecordProof = fixture.cp.recordProof.bind(fixture.cp);
    let proofRecorded = false;
    fixture.cp.recordProof = async (...args) => {
      const result = await origRecordProof(...args);
      proofRecorded = true;
      return result;
    };
    fixture.cp.prepareNext = async (...args) => {
      if (proofRecorded) {
        throw Object.assign(new Error('injected prepareNext continuation failure'), { code: 'injected_prepare_next_failure' });
      }
      return origPrepareNext(...args);
    };

    const interrupted = await dispatchKernelTurn({
      controlPlane: fixture.cp,
      runId: 'review-prepnext-fail',
      adapter: reviewer,
      registry,
      actionContext: REVIEW_ACTION,
    });
    assert.equal(reviewerCalls, 1);
    assert.equal(proofRecorded, true);
    const dbReceipts = fixture.cp.listReviewReceipts('review-prepnext-fail');
    assert.equal(dbReceipts.length, 1);
    const savedReceiptId = dbReceipts[0]!.receiptId;
    assert.equal(interrupted.reviewReceiptId, savedReceiptId, 'accepted reviewReceiptId must not vanish when prepareNext fails');
    const reviewRecord = assertTestRecord(interrupted.review);
    assert.equal(reviewRecord.reviewReceiptAccepted, true);
    assert.equal(reviewRecord.proofSettled, true);
    assert.equal(reviewRecord.blockedReason, 'injected_prepare_next_failure');
    assert.notEqual(reviewRecord.blockedReason, 'incomplete_review_chain');
    assert.equal(assertTestRecord(interrupted.blocker).reason, 'injected_prepare_next_failure');

    fixture.cp.prepareNext = origPrepareNext;
    fixture.cp.recordProof = origRecordProof;
    await fixture.cp.close();

    // Resume in a fresh control plane instance: must converge to done with 0 extra reviewer calls and 1 Judgment Proof.
    const freshCp = await createKernelControlPlane({ runtimeHome: fixture.runtimeHome, projectRoot: fixture.root });
    try {
      const resumed = assertTestRecord(await freshCp.next('review-prepnext-fail'));
      assert.equal(reviewerCalls, 1);
      assert.equal(assertTestRecord(resumed.action).type, 'done', JSON.stringify(resumed));
      assert.equal(freshCp.listReviewReceipts('review-prepnext-fail').length, 1);
      assert.equal(freshCp.listReviewReceipts('review-prepnext-fail')[0]!.receiptId, savedReceiptId);
      const judgmentProofs = freshCp.stateStore.getVerificationHistory('review-prepnext-fail')
        .filter((v) => v.obligationId === 'security-review');
      assert.equal(judgmentProofs.length, 1, 'must preserve exactly one Judgment Proof');
      assert.equal(judgmentProofs[0]!.evidenceRef, `review://review-prepnext-fail/${savedReceiptId}`);
      assert.equal((await freshCp.getRun('review-prepnext-fail'))?.status, 'completed');
    } finally {
      await freshCp.close();
    }
  } finally {
    await rm(fixture.runtimeHome, { recursive: true, force: true });
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('S3 P1 capsule-pinned acceptance scope: late v1 pass cannot satisfy added or strengthened AC, while unrelated contract revision reuses receipt', async () => {
  const initReviewContractRepo = async (prefix: string, runId: string) => {
    const root = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
    const runtimeHome = await mkdtemp(path.join(os.tmpdir(), `${prefix}-state-`));
    await mkdir(path.join(root, '.moon-relay'), { recursive: true });
    await writeFile(path.join(root, '.moon-relay', 'track.yaml'), 'track: kernel\n');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' } }));
    await writeFile(path.join(root, 'app.mjs'), 'export const value = 0;\n');
    const cp = await createKernelControlPlane({ runtimeHome, projectRoot: root });
    await cp.startRun({
      runId,
      objective: 'Verify capsule-pinned acceptance coverage',
      taskContract: {
        surfaces: ['security_boundary'],
        acceptance: [
          { id: 'AC-1', acceptance: 'unit tests pass', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: 'default' } },
          { id: 'AC-2', acceptance: 'auth check passes basic review', evidencePlan: { class: 'judgment', method: 'review', obligationId: 'security-review' } },
        ],
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
    const impl = await dispatchKernelTurn({
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
      capsuleId: assertTestPresent(impl.executionCapsule).capsuleId,
      stepId: assertTestPresent(impl.executionCapsule).stepId,
      changedPaths: ['app.mjs'],
      verifications: [{ obligationId: 'default', commandRef: 'test', acceptanceCoverage: ['AC-1'] }],
    });
    return { root, runtimeHome, cp, impl };
  };

  // Direction A1: contract adds AC-3 bound to security-review while v1 review is in flight (no file edits).
  const addedFixture = await initReviewContractRepo('kernel-review-ac-added', 'review-ac-added');
  try {
    const reviewer = createClaudeAdapter({
      launch: async ({ invocation }) => {
        // Contract is revised to add AC-3 AFTER capsule was issued, BEFORE reviewer verdict returns!
        await addedFixture.cp.reviseContract('review-ac-added', normalizeTaskContract({
          objective: 'Verify capsule-pinned acceptance coverage',
          surfaces: ['security_boundary'],
          acceptance: [
            { id: 'AC-1', acceptance: 'unit tests pass', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: 'default' } },
            { id: 'AC-2', acceptance: 'auth check passes basic review', evidencePlan: { class: 'judgment', method: 'review', obligationId: 'security-review' } },
            { id: 'AC-3', acceptance: 'rate limiting boundary verified', evidencePlan: { class: 'judgment', method: 'review', obligationId: 'security-review' } },
          ],
          allowedPaths: ['app.mjs'],
        }));
        return {
          resolvedModel: assertTestRecord(invocation).model,
          observedModel: assertTestRecord(invocation).model,
          resolvedEffort: assertTestRecord(invocation).effort,
          observedEffort: assertTestRecord(invocation).effort,
          sessionId: 'ac-added-reviewer-v1',
          outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://ac-added-v1'] },
        };
      },
    });
    const res = await dispatchKernelTurn({
      controlPlane: addedFixture.cp,
      runId: 'review-ac-added',
      adapter: reviewer,
      registry: createModelRegistry({
        surface: 'claude',
        env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'scope-frontier', MOON_RELAY_KERNEL_MODEL_FRONTIER_EFFORT: 'high' },
      }),
      actionContext: REVIEW_ACTION,
    });
    const receipt = assertTestPresent(res.reviewReceipt);
    assert.deepEqual(receipt.acceptanceCoverage, ['AC-2'], 'v1 review must only cover AC-2 that was in its capsule, never unseen AC-3');
    assert.notEqual(assertTestRecord(assertTestRecord(res.next).action).type, 'done');
    assert.equal((await addedFixture.cp.getRun('review-ac-added'))?.status, 'active');
    assert.equal(addedFixture.cp.findReusableReviewReceipt('review-ac-added', { obligationId: 'security-review' }), null);
  } finally {
    await addedFixture.cp.close();
    await rm(addedFixture.runtimeHome, { recursive: true, force: true });
    await rm(addedFixture.root, { recursive: true, force: true });
  }

  // Direction A2: contract strengthens AC-2 statement wording while v1 review is in flight.
  const strengthenedFixture = await initReviewContractRepo('kernel-review-ac-strengthened', 'review-ac-strengthened');
  try {
    const reviewer = createClaudeAdapter({
      launch: async ({ invocation }) => {
        await strengthenedFixture.cp.reviseContract('review-ac-strengthened', normalizeTaskContract({
          objective: 'Verify capsule-pinned acceptance coverage',
          surfaces: ['security_boundary'],
          acceptance: [
            { id: 'AC-1', acceptance: 'unit tests pass', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: 'default' } },
            { id: 'AC-2', acceptance: 'auth check enforces strict mTLS and replay protection', evidencePlan: { class: 'judgment', method: 'review', obligationId: 'security-review' } },
          ],
          allowedPaths: ['app.mjs'],
        }));
        return {
          resolvedModel: assertTestRecord(invocation).model,
          observedModel: assertTestRecord(invocation).model,
          resolvedEffort: assertTestRecord(invocation).effort,
          observedEffort: assertTestRecord(invocation).effort,
          sessionId: 'ac-strengthened-reviewer-v1',
          outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://ac-strengthened-v1'] },
        };
      },
    });
    const res = await dispatchKernelTurn({
      controlPlane: strengthenedFixture.cp,
      runId: 'review-ac-strengthened',
      adapter: reviewer,
      registry: createModelRegistry({
        surface: 'claude',
        env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'scope-frontier', MOON_RELAY_KERNEL_MODEL_FRONTIER_EFFORT: 'high' },
      }),
      actionContext: REVIEW_ACTION,
    });
    const receipt = assertTestPresent(res.reviewReceipt);
    assert.deepEqual(receipt.acceptanceCoverage, [], 'v1 review must not cover AC-2 after its statement wording changed');
    assert.notEqual(assertTestRecord(assertTestRecord(res.next).action).type, 'done');
    assert.equal((await strengthenedFixture.cp.getRun('review-ac-strengthened'))?.status, 'active');
    assert.equal(strengthenedFixture.cp.findReusableReviewReceipt('review-ac-strengthened', { obligationId: 'security-review' }), null);
  } finally {
    await strengthenedFixture.cp.close();
    await rm(strengthenedFixture.runtimeHome, { recursive: true, force: true });
    await rm(strengthenedFixture.root, { recursive: true, force: true });
  }

  // Direction B: unrelated contract revision (constraints only) preserves capsule-pinned AC-2 coverage
  // both during an in-flight review AND for subsequent receipt reuse without re-running the reviewer.
  const unrelatedFixture = await initReviewContractRepo('kernel-review-ac-unrelated', 'review-ac-unrelated');
  try {
    let reviewerCalls = 0;
    const registry = createModelRegistry({
      surface: 'claude',
      env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'scope-frontier', MOON_RELAY_KERNEL_MODEL_FRONTIER_EFFORT: 'high' },
    });
    const reviewer = createClaudeAdapter({
      launch: async ({ invocation }) => {
        reviewerCalls += 1;
        // Revise an UNRELATED part of the contract (constraints only) while v1 review is in flight;
        // AC-2 id, statement, and security-review binding stay identical.
        await unrelatedFixture.cp.reviseContract('review-ac-unrelated', normalizeTaskContract({
          objective: 'Verify capsule-pinned acceptance coverage',
          surfaces: ['security_boundary'],
          constraints: ['keep diff minimal'],
          acceptance: [
            { id: 'AC-1', acceptance: 'unit tests pass', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: 'default' } },
            { id: 'AC-2', acceptance: 'auth check passes basic review', evidencePlan: { class: 'judgment', method: 'review', obligationId: 'security-review' } },
          ],
          allowedPaths: ['app.mjs'],
        }));
        return {
          resolvedModel: assertTestRecord(invocation).model,
          observedModel: assertTestRecord(invocation).model,
          resolvedEffort: assertTestRecord(invocation).effort,
          observedEffort: assertTestRecord(invocation).effort,
          sessionId: 'ac-unrelated-reviewer-v1',
          outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://ac-unrelated-v1'] },
        };
      },
    });
    const first = await dispatchKernelTurn({
      controlPlane: unrelatedFixture.cp,
      runId: 'review-ac-unrelated',
      adapter: reviewer,
      registry,
      actionContext: REVIEW_ACTION,
    });
    const receiptId = assertTestString(first.reviewReceiptId);
    assert.equal(reviewerCalls, 1);
    assert.deepEqual(assertTestPresent(first.reviewReceipt).acceptanceCoverage, ['AC-2'], 'unrelated contract revision must preserve AC-2 coverage');

    // Another unrelated contract revision (constraints only): existing receipt must stay reusable!
    await unrelatedFixture.cp.reviseContract('review-ac-unrelated', normalizeTaskContract({
      objective: 'Verify capsule-pinned acceptance coverage',
      surfaces: ['security_boundary'],
      constraints: ['keep diff minimal', 'document rationale'],
      acceptance: [
        { id: 'AC-1', acceptance: 'unit tests pass', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: 'default' } },
        { id: 'AC-2', acceptance: 'auth check passes basic review', evidencePlan: { class: 'judgment', method: 'review', obligationId: 'security-review' } },
      ],
      allowedPaths: ['app.mjs'],
    }));
    const reusable = unrelatedFixture.cp.findReusableReviewReceipt('review-ac-unrelated', { obligationId: 'security-review' });
    assert.equal(reusable?.receiptId, receiptId, 'unrelated contract revision must keep matching review receipt reusable');

    // Dispatching review turn again with a guard adapter must reuse the existing receipt with 0 extra reviewer calls.
    const guardReviewer = createClaudeAdapter({
      launch: async () => {
        reviewerCalls += 1;
        throw new Error('reviewer must not run again on unrelated contract revision');
      },
    });
    const reused = await dispatchKernelTurn({
      controlPlane: unrelatedFixture.cp,
      runId: 'review-ac-unrelated',
      adapter: guardReviewer,
      registry,
      actionContext: REVIEW_ACTION,
    });
    assert.equal(reviewerCalls, 1, 'reviewer must execute 0 extra times when AC scope is unchanged');
    assert.equal(reused.deduplicated, true);
    assert.equal(reused.reviewReceiptId, receiptId);
    assert.equal(assertTestRecord(reused.review).proofSettled, true);
  } finally {
    await unrelatedFixture.cp.close();
    await rm(unrelatedFixture.runtimeHome, { recursive: true, force: true });
    await rm(unrelatedFixture.root, { recursive: true, force: true });
  }
});

test('S3 P1 interrupted Git closeout resumes from existingCommitSha without second commit, and drifted closeout workspace fails closed', async () => {
  const initGitReviewRun = async (prefix: string, runId: string) => {
    const root = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
    const runtimeHome = await mkdtemp(path.join(os.tmpdir(), `${prefix}-state-`));
    spawnSync('git', ['init', '-b', 'main'], { cwd: root, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: root, encoding: 'utf8' });
    await mkdir(path.join(root, '.moon-relay'), { recursive: true });
    await writeFile(path.join(root, '.moon-relay', 'track.yaml'), 'track: kernel\n');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' } }));
    await writeFile(path.join(root, 'app.mjs'), 'export const value = 0;\n');
    spawnSync('git', ['add', '.'], { cwd: root, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: root, encoding: 'utf8' });
    const cp = await createKernelControlPlane({ runtimeHome, projectRoot: root });
    await cp.startRun({
      runId,
      objective: 'Test interrupted git closeout resume',
      taskContract: {
        surfaces: ['security_boundary'],
        acceptance: ['app updated'],
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
    const impl = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter: implementer,
      registry: createModelRegistry({
        surface: 'claude',
        env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'configured-frontier', MOON_RELAY_KERNEL_MODEL_VALUE: 'configured-value' },
      }),
      actionContext: { executionMode: 'native-subagent', delegationRequested: true },
    });
    await writeFile(path.join(root, 'app.mjs'), 'export const value = 7;\n');
    await cp.report(runId, {
      summary: 'updated app with approved commit',
      capsuleId: assertTestPresent(impl.executionCapsule).capsuleId,
      stepId: assertTestPresent(impl.executionCapsule).stepId,
      changedPaths: ['app.mjs'],
      gitCloseoutRequest: {
        requested: true,
        mode: 'commit',
        approvalReceipt: `${runId}-approval`,
        commitMessage: `feat: ${runId}`,
      },
    });
    return { root, runtimeHome, cp };
  };

  // 1. Crash right after commit creation (before finalization_receipt is written): resume must finish with SAME commit SHA & 0 extra commits.
  const crashFixture = await initGitReviewRun('kernel-git-crash', 'git-closeout-crash');
  try {
    const countBefore = Number(spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: crashFixture.root, encoding: 'utf8' }).stdout.trim());
    const origRecordFin = crashFixture.cp.stateStore.recordFinalizationReceipt.bind(crashFixture.cp.stateStore);
    let injectedCrash = false;
    crashFixture.cp.stateStore.recordFinalizationReceipt = (...args) => {
      if (!injectedCrash) {
        injectedCrash = true;
        throw Object.assign(new Error('crash after git commit before finalization receipt'), { code: 'injected_post_commit_crash' });
      }
      return origRecordFin(...args);
    };
    const reviewer = createClaudeAdapter({
      launch: async ({ invocation }) => ({
        resolvedModel: assertTestRecord(invocation).model,
        observedModel: assertTestRecord(invocation).model,
        resolvedEffort: assertTestRecord(invocation).effort,
        observedEffort: assertTestRecord(invocation).effort,
        sessionId: 'git-crash-reviewer',
        outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://git-crash'] },
      }),
    });
    const interrupted = await dispatchKernelTurn({
      controlPlane: crashFixture.cp,
      runId: 'git-closeout-crash',
      adapter: reviewer,
      registry: createModelRegistry({
        surface: 'claude',
        env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'crash-frontier', MOON_RELAY_KERNEL_MODEL_FRONTIER_EFFORT: 'high' },
      }),
      actionContext: REVIEW_ACTION,
    });
    assert.equal(injectedCrash, true);
    assert.ok(interrupted.reviewReceiptId);
    const headAfterCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: crashFixture.root, encoding: 'utf8' }).stdout.trim();
    const countAfterCommit = Number(spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: crashFixture.root, encoding: 'utf8' }).stdout.trim());
    assert.equal(countAfterCommit, countBefore + 1, 'local commit must have succeeded before crash');
    assert.equal(crashFixture.cp.stateStore.getFinalizationReceipt('git-closeout-crash'), null);

    crashFixture.cp.stateStore.recordFinalizationReceipt = origRecordFin;
    await crashFixture.cp.close();

    // Fresh process resumes via next() -> finishes finalization with SAME commit SHA and no duplicate commit!
    const freshCp = await createKernelControlPlane({ runtimeHome: crashFixture.runtimeHome, projectRoot: crashFixture.root });
    try {
      const resumed = assertTestRecord(await freshCp.next('git-closeout-crash'));
      assert.equal(assertTestRecord(resumed.action).type, 'done', JSON.stringify(resumed));
      const fin = assertTestRecord(resumed.finalization);
      assert.equal(fin.finalizationStatus, 'completed');
      assert.equal(fin.gitCloseoutStatus, 'completed');
      assert.equal(assertTestRecord(fin.gitCloseoutReceipt).commitSha, headAfterCommit);
      assert.equal(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: crashFixture.root, encoding: 'utf8' }).stdout.trim(), headAfterCommit);
      assert.equal(Number(spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: crashFixture.root, encoding: 'utf8' }).stdout.trim()), countBefore + 1);
    } finally {
      await freshCp.close();
    }
  } finally {
    await rm(crashFixture.runtimeHome, { recursive: true, force: true });
    await rm(crashFixture.root, { recursive: true, force: true });
  }

  // 2. Workspace drifts after review before closeout runs -> must fail closed, never skip closeout and return done!
  const driftFixture = await initGitReviewRun('kernel-git-drift', 'git-closeout-drift');
  try {
    const headBefore = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: driftFixture.root, encoding: 'utf8' }).stdout.trim();
    const competing = driftFixture.cp.stateStore.acquireLease('git-closeout-drift', { holder: 'pause-before-closeout', ttlMs: 60000 });
    assert.equal(competing.acquired, true);
    const reviewer = createClaudeAdapter({
      launch: async ({ invocation }) => ({
        resolvedModel: assertTestRecord(invocation).model,
        observedModel: assertTestRecord(invocation).model,
        resolvedEffort: assertTestRecord(invocation).effort,
        observedEffort: assertTestRecord(invocation).effort,
        sessionId: 'git-drift-reviewer',
        outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://git-drift'] },
      }),
    });
    await dispatchKernelTurn({
      controlPlane: driftFixture.cp,
      runId: 'git-closeout-drift',
      adapter: reviewer,
      registry: createModelRegistry({
        surface: 'claude',
        env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'drift-frontier', MOON_RELAY_KERNEL_MODEL_FRONTIER_EFFORT: 'high' },
      }),
      actionContext: REVIEW_ACTION,
    });
    driftFixture.cp.stateStore.releaseLease('git-closeout-drift', { holder: 'pause-before-closeout', fencingToken: competing.lease.fencingToken });

    // Tamper with workspace after review passed, before authorized resume settles closeout!
    await writeFile(path.join(driftFixture.root, 'app.mjs'), 'export const value = 999;\n');
    const blocked = assertTestRecord(await driftFixture.cp.next('git-closeout-drift'));
    assert.equal(blocked.status, 'blocked', JSON.stringify(blocked));
    assert.equal(blocked.blockedReason, 'git_closeout_workspace_mismatch');
    assert.notEqual(assertTestRecord(blocked.action).type, 'done');
    assert.equal((await driftFixture.cp.getRun('git-closeout-drift'))?.status, 'active');
    assert.equal(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: driftFixture.root, encoding: 'utf8' }).stdout.trim(), headBefore);
  } finally {
    await driftFixture.cp.close();
    await rm(driftFixture.runtimeHome, { recursive: true, force: true });
    await rm(driftFixture.root, { recursive: true, force: true });
  }
});

type TestControlPlane = Awaited<ReturnType<typeof import('../src/host/kernel/control-plane-runtime.js').createKernelControlPlane>>;
type TestStateStore = Awaited<ReturnType<typeof import('../src/kernel/state-store.js').openKernelStateStore>>;
