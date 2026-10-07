// Step attempts remain the durable execution lineage after Wave lifecycle
// removal. These tests exercise the Host adapter boundary without inventing a
// parallel-group identity.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatchKernelStep } from '../scripts/host/kernel/parallel-dispatcher.mjs';

const workspace = {
  workspaceId: 'workspace-worker-a',
  workspaceRoot: 'C:/tmp/kernel-worker-a',
  baseWorkspaceIdentity: `sha256:${'a'.repeat(64)}`,
};

const capabilities = {
  supportsConcurrentSessions: true,
  supportsIsolatedWorkingDirectory: true,
  supportsPerSessionEnvironment: true,
};

test('a dispatched Step carries its existing attempt and capsule credentials', async () => {
  const calls = [];
  const prepareHost = async ({ runId, ...context }) => {
      calls.push({ kind: 'next', runId, context });
      return {
        runId,
        executionCapsule: {
          capsuleId: 'capsule-step-a',
          provenance: { capsuleDigest: `sha256:${'b'.repeat(64)}` },
          permissions: { canCommit: true, canDelegate: true },
        },
        hostDirective: {},
        modelInput: { action: { type: 'implement' } },
      };
  };
  const controlPlane = {
    bindStepAttempt: async (runId, stepId, binding) => {
      calls.push({ kind: 'bind', runId, stepId, binding });
      return {
        id: 7,
        attemptId: 'attempt-step-a',
        bindingId: 'binding-step-a',
        actorSessionId: 'parent:worker:step-a',
      };
    },
    updateStepAttempt: async (id, patch) => calls.push({ kind: 'update', id, patch }),
  };
  const step = { stepId: 'step-a', objective: 'edit a', workProfile: null };
  const outcome = await dispatchKernelStep({
    controlPlane,
    prepareHost,
    runId: 'run-step-a',
    step,
    workspace,
    adapter: { capabilities },
    hostCapabilities: capabilities,
    parentSessionId: 'parent',
    dispatchStep: async ({ hosted }) => ({
      status: 'passed',
      report: { summary: 'done', changedPaths: ['src/a.mjs'] },
      capsuleSeen: hosted.executionCapsule.capsuleId,
    }),
    deferReport: true,
  });

  assert.equal(outcome.status, 'passed');
  assert.equal(outcome.attempt.attemptId, 'attempt-step-a');
  assert.equal(outcome.workerReport.summary, 'done');
  assert.equal(calls.find((call) => call.kind === 'next').context.actionContext.stepId, 'step-a');
  assert.equal(calls.find((call) => call.kind === 'update').patch.capsuleId, 'capsule-step-a');
  assert.equal(Object.hasOwn(outcome, 'waveId'), false);
});

test('a provider failure is returned as a failed Step dispatch without synthetic lifecycle state', async () => {
  const prepareHost = async () => ({ executionCapsule: null, hostDirective: {}, modelInput: { action: { type: 'implement' } } });
  const controlPlane = {
    bindStepAttempt: async () => ({ id: 8, attemptId: 'attempt-step-b', bindingId: 'binding-step-b' }),
  };
  const outcome = await dispatchKernelStep({
    controlPlane,
    prepareHost,
    runId: 'run-step-b',
    step: { stepId: 'step-b', objective: 'edit b' },
    workspace,
    adapter: { capabilities },
    hostCapabilities: capabilities,
    dispatchStep: async () => { throw new Error('provider crashed'); },
    deferReport: true,
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.failureCode, 'worker-report-missing');
  assert.equal(outcome.result.errorSummary, 'provider crashed');
});
