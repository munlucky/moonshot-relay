import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';
import { hashSessionId } from '../scripts/kernel/run/model-route-contract.mjs';
import { dispatchKernelTurn } from '../scripts/host/kernel/turn-dispatcher.mjs';
import { createCodexAdapter } from '../scripts/host/kernel/adapters/codex.mjs';
import { createClaudeAdapter } from '../scripts/host/kernel/adapters/claude.mjs';
import { createModelRegistry } from '../scripts/host/kernel/model-registry.mjs';
import { resolveReviewTransports } from '../scripts/host/kernel/review-transport-resolver.mjs';
import { resolveCodexModelPolicy } from '../scripts/host/kernel/codex-model-policy.mjs';

const REVIEW_ACTION = {
  actionKind: 'review_engineering',
  obligationId: 'security-review',
  executionMode: 'native-subagent',
  delegationRequested: true,
  changedPaths: ['app.mjs'],
};

const prepareReviewRun = async (prefix, runId) => {
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
        resolvedModel: invocation.model,
        observedModel: invocation.model,
        resolvedEffort: invocation.effort,
        observedEffort: invocation.effort,
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
      capsuleId: implementation.executionCapsule.capsuleId,
      stepId: implementation.executionCapsule.stepId,
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

const cleanupReviewRun = async ({ cp, root, runtimeHome }) => {
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
    assert.equal(capsule.implementationReceipt.usageReceiptId, undefined);
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
        resolvedModel: invocation.model,
        observedModel: invocation.model,
        resolvedEffort: invocation.effort,
        observedEffort: invocation.effort,
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
      capsuleId: implementation.executionCapsule.capsuleId,
      stepId: implementation.executionCapsule.stepId,
      changedPaths: ['app.mjs'],
    });
    await cp.transition('native-review-chain', 'EXECUTE');
    await cp.transition('native-review-chain', 'PROVE');
    const reviewedRun = await cp.getRun('native-review-chain');
    const reviewPolicy = resolveCodexModelPolicy({ executionClass: 'review' });
    let nativeRequest = null;
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
      registry: createModelRegistry({ surface: 'codex', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: reviewPolicy.model } }),
      parentSessionId: 'native-owner-session',
      actionContext: {
        actionKind: 'review_engineering',
        obligationId: 'security-review',
        executionMode: 'native-subagent',
        delegationRequested: true,
        changedPaths: ['app.mjs'],
      },
    });
    assert.equal(nativeRequest.task_name, 'kernel_reviewer');
    assert.equal(nativeRequest.child_session.canCommit, false);
    assert.equal(nativeRequest.execution_capsule, undefined, 'the provider request must not receive the Host capsule');
    assert.equal(nativeRequest.execution_contract, undefined, 'the provider request must not receive the Host contract');
    assert.doesNotMatch(nativeRequest.message, /"role"|"permissions"|"nonGoals"|executionCapsule|executionContract/);
    assert.equal(result.review.review.verdict, 'pass');
    assert.match(result.reviewReceiptId, /^review-receipt-[a-f0-9]{24}$/);
    assert.equal(result.reviewReceipt.reviewer.usageReceiptId, result.receipt.receiptId);
    assert.equal(result.reviewReceipt.subject.mutationRevision, reviewedRun.mutationRevision);
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
      attemptId: firstAttempt.attemptId,
      summary: 'first attempt',
      verifications: [{ obligationId: 'default', commandRef: 'test:fail' }],
    };
    const first = await cp.report('report-idempotency', firstPayload);
    const duplicate = await cp.report('report-idempotency', firstPayload);
    assert.equal(first.status, 'evidence-failed');
    assert.equal(duplicate.status, 'evidence-failed');
    assert.equal(duplicate.idempotentReplay, true);
    assert.equal(duplicate.attemptNumber, first.attemptNumber);

    const secondAttempt = cp.beginAttempt('report-idempotency', { stepId: firstAttempt.stepId, retryReason: 'evidence-failed' });
    const retry = await cp.report('report-idempotency', {
      ...firstPayload,
      attemptId: secondAttempt.attemptId,
      summary: 'second attempt',
    });
    assert.equal(retry.status, 'evidence-failed');
    assert.equal(retry.attemptNumber, first.attemptNumber + 1);
    const status = await cp.status('report-idempotency');
    assert.equal(status.measurement.retryCount.value, 1);
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
          resolvedModel: invocation.model,
          observedModel: invocation.model,
          resolvedEffort: invocation.effort,
          observedEffort: invocation.effort,
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
    assert.equal(result.review.review.verdict, 'pass');
    assert.equal(result.hostDirective.hostCapabilities.surface, 'claude');
    assert.equal(fixture.cp.listReviewReceipts('review-fallback-chain').length, 1);
    const reviewerAttempts = fixture.cp.stateStore.getStepAttempts('review-fallback-chain')
      .filter((attempt) => fixture.cp.stateStore.getModelRouteDecision(attempt.routeDecisionId, { runId: 'review-fallback-chain' })?.role === 'reviewer');
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
    let fallbackInvocation = null;
    const originalEnv = { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'main-review-model' };
    const primary = createClaudeAdapter({
      launch: async () => {
        primaryCalls += 1;
        const error = new Error('CLI version mismatch');
        error.code = 'cli-version-mismatch';
        error.details = { failureCategory: 'provider/infrastructure', failureStage: 'pre-spawn' };
        throw error;
      },
    });
    const fallback = createClaudeAdapter({
      launch: async (payload) => {
        fallbackCalls += 1;
        fallbackInvocation = payload;
        const { invocation } = payload;
        return {
          resolvedModel: invocation.model,
          observedModel: invocation.model,
          resolvedEffort: invocation.effort,
          observedEffort: invocation.effort,
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
      toolPolicy: { reviewer: 'read-only' },
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
    assert.equal(result.review.review.verdict, 'pass');
    assert.equal(fixture.cp.listReviewReceipts('review-preflight-chain').length, 1);
    assert.equal(fallbackInvocation.parentSessionId, 'review-owner');
    assert.equal(fallbackInvocation.environment, originalEnv);
    assert.equal(fallbackInvocation.invocation.model, 'main-review-model');
    assert.equal(fallbackInvocation.invocation.subagent, 'kernel-reviewer');
    const reviewerAttempts = fixture.cp.stateStore.getStepAttempts('review-preflight-chain')
      .filter((attempt) => fixture.cp.stateStore.getModelRouteDecision(attempt.routeDecisionId, { runId: 'review-preflight-chain' })?.role === 'reviewer');
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
          resolvedModel: invocation.model,
          observedModel: invocation.model,
          resolvedEffort: invocation.effort,
          observedEffort: invocation.effort,
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

    assert.equal(result.review.status, 'blocked');
    assert.equal(result.review.blockedReason, 'incomplete_review_chain');
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
    const transportFailure = (calls) => async () => {
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
          resolvedModel: invocation.model,
          observedModel: invocation.model,
          resolvedEffort: invocation.effort,
          observedEffort: invocation.effort,
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
    assert.equal(result.review.review.verdict, 'pass');
    assert.equal(fixture.cp.listReviewReceipts('review-multi-hop-chain').length, 1);
    const reviewerAttempts = fixture.cp.stateStore.getStepAttempts('review-multi-hop-chain')
      .filter((attempt) => fixture.cp.stateStore.getModelRouteDecision(attempt.routeDecisionId, { runId: 'review-multi-hop-chain' })?.role === 'reviewer');
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
        resolvedModel: invocation.model,
        observedModel: invocation.model,
        resolvedEffort: invocation.effort,
        observedEffort: invocation.effort,
      }),
    });
    const fallback = createClaudeAdapter({
      launch: async ({ invocation }) => {
        fallbackCalls += 1;
        assert.equal(invocation.model, 'main-review-model');
        return {
          resolvedModel: invocation.model,
          observedModel: invocation.model,
          resolvedEffort: invocation.effort,
          observedEffort: invocation.effort,
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
    assert.equal(result.review.review.verdict, 'pass');
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
        resolvedModel: invocation.model,
        observedModel: invocation.model,
        resolvedEffort: invocation.effort,
        observedEffort: invocation.effort,
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
    assert.equal(result.review.review.verdict, 'fail');
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
        resolvedModel: invocation.model,
        observedModel: invocation.model,
        resolvedEffort: invocation.effort,
        observedEffort: invocation.effort,
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
    assert.equal(result.review.status, 'blocked');
    assert.equal(result.review.blockedReason, 'incomplete_review_chain');
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
        error.code = 'transport-unavailable';
        error.details = {
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
    assert.equal(result.dispatch.outcome.verdict, 'fail');
    assert.equal(result.review.status, 'blocked');
    assert.equal(result.review.blockedReason, 'transport-unavailable');
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
        error.code = 'transport-unavailable';
        error.details = {
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
    assert.equal(result.dispatch.outcome.verdict, 'blocked');
    assert.equal(result.review.status, 'blocked');
    assert.equal(result.review.blockedReason, 'transport-unavailable');
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
        error.code = 'transport-unavailable';
        error.details = { failureCategory: 'provider/infrastructure', failureStage: 'pre-spawn' };
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
    assert.equal(result.review.blockedReason, 'review-subject-stale');
    const reviewerAttempts = fixture.cp.stateStore.getStepAttempts('review-stale-fallback-chain')
      .filter((attempt) => fixture.cp.stateStore.getModelRouteDecision(attempt.routeDecisionId, { runId: 'review-stale-fallback-chain' })?.role === 'reviewer');
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
        resolvedModel: invocation.model,
        observedModel: invocation.model,
        resolvedEffort: invocation.effort,
        observedEffort: invocation.effort,
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
    assert.equal(result.review.status, 'blocked');
    assert.equal(result.review.blockedReason, 'transport-unavailable');
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
        resolvedModel: invocation.model,
        observedModel: invocation.model,
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
    assert.equal(result.review.status, 'blocked');
    assert.equal(result.review.blockedReason, 'transport-unavailable');
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
        error.code = 'transport-unavailable';
        error.details = {
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
    assert.equal(result.review.status, 'blocked');
    assert.equal(result.review.blockedReason, 'transport-unavailable');
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
        resolvedModel: invocation.model,
        observedModel: invocation.model,
        resolvedEffort: invocation.effort,
        observedEffort: invocation.effort,
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
          resolvedModel: invocation.model,
          observedModel: invocation.model,
          resolvedEffort: invocation.effort,
          observedEffort: invocation.effort,
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
    assert.equal(result.review.review.verdict, 'pass');
    assert.equal(result.receipt.resolvedModel, 'claude-frontier');
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
    assert.equal(result.review.status, 'blocked');
    assert.equal(result.review.blockedReason, 'transport-unavailable');
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
        error.code = 'transport-unavailable';
        error.details = {
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
    assert.equal(result.review.status, 'blocked');
    assert.equal(result.review.blockedReason, 'transport-unavailable');
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
          resolvedModel: invocation.model,
          observedModel: invocation.model,
          resolvedEffort: invocation.effort,
          observedEffort: invocation.effort,
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
    assert.equal(result.review.review.verdict, 'pass');
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
          resolvedModel: invocation.model,
          observedModel: invocation.model,
          resolvedEffort: invocation.effort,
          observedEffort: invocation.effort,
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
    assert.equal(result.review.review.verdict, 'pass');
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
    assert.equal(result.review.status, 'blocked');
    assert.equal(result.review.blockedReason, 'model-enforcement-failed');
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
    assert.equal(result.review.blockedReason, 'no-independent-review-capability');
    assert.equal(result.reviewReceipt, null);
    assert.equal(fixture.cp.listReviewReceipts('review-none-chain').length, 0);
    const reviewerAttempts = fixture.cp.stateStore.getStepAttempts('review-none-chain')
      .filter((attempt) => fixture.cp.stateStore.getModelRouteDecision(attempt.routeDecisionId, { runId: 'review-none-chain' })?.role === 'reviewer');
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
    assert.equal(result.review.blockedReason, 'no-independent-review-capability');
    const reviewerAttempts = fixture.cp.stateStore.getStepAttempts('review-final-failure-chain')
      .filter((attempt) => fixture.cp.stateStore.getModelRouteDecision(attempt.routeDecisionId, { runId: 'review-final-failure-chain' })?.role === 'reviewer');
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
      verifications: [
        { obligationId: 'proof-a', commandRef: 'test:coalesce' },
        { obligationId: 'proof-b', commandRef: 'test:coalesce' },
      ],
    });

    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal((await readFile(marker, 'utf8')).length, 1, 'the trusted command must execute once');
    const verifications = cp.stateStore.getVerifications('proof-coalescing-chain');
    assert.deepEqual(
      verifications.map((verification) => verification.obligationId).sort(),
      ['default', 'proof-a', 'proof-b'],
    );
    assert.equal(new Set(verifications.map((verification) => verification.evidenceDigest)).size, 1);
    assert.equal(result.executed.filter((execution) => execution.shared).length, 2);
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
  const contract = (obligationIds) => ({
    allowedPaths: ['app.mjs'],
    acceptance: ['the shared proof is recorded for every obligation'],
    requiredObligations: obligationIds,
    requiredVerifications: obligationIds.map((obligationId) => ({
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
      verifications: [{ obligationId: 'proof-a', commandRef: 'test:coalesce' }],
    });
    assert.equal(seedResult.status, 'completed', JSON.stringify(seedResult));
    assert.equal((await readFile(marker, 'utf8')).length, 1);

    await cp.startRun({
      runId: 'proof-reuse-coalescing-chain',
      objective: 'share exact reused proof execution',
      taskContract: contract(['proof-a', 'proof-b']),
    });
    const result = await cp.report('proof-reuse-coalescing-chain', {
      summary: 'reused proof completed',
      verifications: [
        { obligationId: 'proof-a', commandRef: 'test:coalesce' },
        { obligationId: 'proof-b', commandRef: 'test:coalesce' },
      ],
    });

    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal((await readFile(marker, 'utf8')).length, 1, 'exactly reused proof must not execute again');
    assert.deepEqual(
      result.executed.filter((execution) => execution.shared).map((execution) => execution.obligationId),
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
        verifications: [{ commandRef: 'test:flaky', flakyRerun: true }],
      });

      assert.equal(result.status, 'evidence-failed', JSON.stringify(result));
      assert.equal((await readFile(counter, 'utf8')), '2', 'flaky policy must execute the command twice');
      const execution = result.executed.find((entry) => entry.obligationId === 'default');
      assert.equal(execution.flaky, true);
      assert.equal(execution.status, 'failed');
      assert.match(result.failures.find((failure) => failure.obligationId === 'default').errorSummary, /flaky/);
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
        verifications: [{ commandRef: 'test:flaky', acceptanceCoverage: ['AC-1'] }],
      });
      assert.equal(seed.status, 'completed', JSON.stringify(seed));
      assert.equal((await readFile(counter, 'utf8')), '1');

      await cp.startRun({ runId: 'report-flaky-reuse-chain', objective: 'force a fresh flaky proof', taskContract: contract });
      const result = await cp.report('report-flaky-reuse-chain', {
        summary: 'rerun the flaky proof',
        verifications: [{ commandRef: 'test:flaky', flakyRerun: true, acceptanceCoverage: ['AC-1'] }],
      });

      assert.equal(result.status, 'evidence-failed', JSON.stringify(result));
      assert.equal((await readFile(counter, 'utf8')), '3', 'flaky policy must bypass reusable evidence and execute twice');
      const execution = result.executed.find((entry) => entry.obligationId === 'default');
      assert.equal(execution.flaky, true);
      assert.equal(execution.status, 'failed');
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
        resolvedModel: invocation.model,
        observedModel: invocation.model,
        resolvedEffort: invocation.effort,
        observedEffort: invocation.effort,
      }),
      parentSessionObserver: async ({ parentSessionId }) => ({
        sessionId: parentSessionId,
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
      }),
    });

    const result = await dispatchKernelTurn({
      controlPlane: fixture.cp,
      runId: 'review-auto-resolve-chain',
      adapter: primary,
      env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'claude-frontier' },
      parentSessionId: 'review-owner',
      actionContext: REVIEW_ACTION,
      overrides: {
        claudeLauncher: async ({ invocation }) => {
          fallbackCalls += 1;
          return {
            resolvedModel: invocation.model,
            observedModel: invocation.model,
            resolvedEffort: invocation.effort,
            observedEffort: invocation.effort,
            sessionId: 'auto-discovered-reviewer',
            outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://auto-discovered'] },
          };
        },
      },
      // Note: NO reviewFallbacks, NO hostAdapters, NO reviewTransports passed!
    });

    assert.equal(fallbackCalls, 1);
    assert.equal(result.review.review.verdict, 'pass');
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
    const parentSessionObserver = async ({ parentSessionId }) => ({
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
          terminalEvents: [{ type: 'turn.completed', model: invocation.model, reasoning_effort: invocation.effort }],
          outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://same-provider'] },
        };
      },
      parentSessionObserver,
    });
    const crossProvider = createClaudeAdapter({
      launch: async ({ invocation }) => {
        crossProviderCalls += 1;
        return {
          resolvedModel: invocation.model,
          observedModel: invocation.model,
          resolvedEffort: invocation.effort,
          observedEffort: invocation.effort,
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
    assert.equal(result.hostDirective.hostCapabilities.surface, 'codex');
    assert.equal(result.dispatch.actorSessionId, 'same-provider-reviewer');
    assert.equal(result.review.review.verdict, 'pass');
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
    assert.equal(implementation.dispatch.status, 'completed');
    assert.equal(implementation.dispatch.actorSessionId, implementationSessionId);

    await writeFile(path.join(root, 'app.mjs'), 'export const value = 1;\n');
    await cp.report(runId, {
      summary: 'implemented by codex owner',
      capsuleId: implementation.executionCapsule.capsuleId,
      stepId: implementation.executionCapsule.stepId,
      changedPaths: ['app.mjs'],
    });

    await cp.transition(runId, 'EXECUTE');
    await cp.transition(runId, 'PROVE');
    const reviewedRun = await cp.getRun(runId);

    const reviewPolicy = resolveCodexModelPolicy({ executionClass: 'review' });
    let spawnedReviewerRequest = null;
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
      registry: createModelRegistry({ surface: 'codex', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: reviewPolicy.model } }),
      parentSessionId: ownerSessionId,
      actionContext: {
        actionKind: 'review_engineering',
        obligationId: 'security-review',
        changedPaths: ['app.mjs'],
      },
      overrides: {}, // NO claudeLauncher
    });

    assert.equal(result.dispatched, true);
    assert.equal(result.hostDirective.hostCapabilities.surface, 'codex');
    assert.equal(result.dispatch.dispatchMechanism, 'native-subagent');
    assert.equal(result.dispatch.actorSessionId, freshReviewerSessionId);
    assert.notEqual(result.dispatch.actorSessionId, ownerSessionId);
    assert.equal(spawnedReviewerRequest.parent_session_id, ownerSessionId);
    assert.equal(spawnedReviewerRequest.task_name, 'kernel_reviewer');
    assert.equal(spawnedReviewerRequest.child_session.canCommit, false);
    assert.equal(spawnedReviewerRequest.child_session.freshSessionRequired, undefined);
    assert.equal(spawnedReviewerRequest.execution_capsule, undefined);
    assert.equal(spawnedReviewerRequest.execution_contract, undefined);
    assert.doesNotMatch(spawnedReviewerRequest.message, /"role"|"permissions"|"nonGoals"|executionCapsule|executionContract/);
    assert.equal(result.review.review.verdict, 'pass');
    assert.match(result.reviewReceiptId, /^review-receipt-[a-f0-9]{24}$/);
    assert.equal(result.reviewReceipt.reviewer.usageReceiptId, result.receipt.receiptId);
    assert.equal(result.reviewReceipt.subject.mutationRevision, reviewedRun.mutationRevision);
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
        resolvedModel: invocation.model,
        observedModel: invocation.model,
        resolvedEffort: invocation.effort,
        observedEffort: invocation.effort,
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
      capsuleId: implementation.executionCapsule.capsuleId,
      stepId: implementation.executionCapsule.stepId,
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
