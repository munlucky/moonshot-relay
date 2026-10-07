// K3 for reviews: an independent review is the one turn whose routing cannot be
// approximate. Admission refuses to dispatch it on anything but a frontier,
// read-only, independently-contexted session — through the real dispatcher.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';
import { dispatchKernelTurn } from '../scripts/host/kernel/turn-dispatcher.mjs';
import { createModelRegistry } from '../scripts/host/kernel/model-registry.mjs';
import { createClaudeAdapter } from '../scripts/host/kernel/adapters/claude.mjs';
import { createCodexAdapter } from '../scripts/host/kernel/adapters/codex.mjs';
import { REJECTION_CODES } from '../scripts/host/kernel/route-admission.mjs';

const CONFIGURED = { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'configured-frontier', MOON_RELAY_KERNEL_MODEL_VALUE: 'configured-value' };

const withT3Run = async (fn) => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-adm-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-adm-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'x', scripts: { 'test:ok': 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' } }));
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    await cp.startRun({ runId: 'r-adm', objective: 'auth boundary', taskContract: { surfaces: ['security_boundary'], acceptance: ['works'] } });
    return await fn(cp, 'r-adm', { runtimeHome, projectRoot });
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
};

const reviewContext = {
  actionKind: 'review_engineering',
  obligationId: 'security-review',
  executionMode: 'native-subagent',
  delegationRequested: true,
};

test('review capability describes the concrete launcher and never claims cross-surface support', () => {
  const claudeWithoutLauncher = createClaudeAdapter();
  const claudeWithLauncher = createClaudeAdapter({ launch: async () => ({}) });
  const codexWithoutLauncher = createCodexAdapter({ nativeAgentHost: {} });
  const codexWithLauncher = createCodexAdapter({ nativeAgentHost: { spawn_agent: async () => ({}) } });

  assert.equal(claudeWithoutLauncher.capabilities.supportsIndependentContext, false);
  assert.equal(claudeWithLauncher.capabilities.supportsIndependentContext, true);
  assert.equal(codexWithoutLauncher.capabilities.supportsIndependentContext, false);
  assert.equal(codexWithLauncher.capabilities.supportsIndependentContext, true);
  assert.equal(claudeWithLauncher.capabilities.supportsCrossSurfaceReview, false);
  assert.equal(codexWithLauncher.capabilities.supportsCrossSurfaceReview, false);
});

test('K3: a configured frontier reviewer session is admitted and dispatched', async () => {
  await withT3Run(async (cp, runId) => {
    const adapter = createClaudeAdapter({ launch: async ({ invocation }) => ({ resolvedModel: invocation.model, sessionId: 'reviewer-session' }) });
    const result = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter,
      registry: createModelRegistry({ surface: 'claude', env: CONFIGURED }),
      actionContext: reviewContext,
    });

    assert.equal(result.dispatched, true);
    assert.equal(result.admission.decision, 'admitted');
    assert.equal(result.admission.requested.modelClass, 'frontier_reasoning');
    assert.equal(result.admission.requested.permissions, 'read_only');
    assert.equal(result.admission.resolved.model, 'configured-frontier');
    assert.equal(result.executionCapsule.role, 'reviewer');

    // K3-10: the receipt carries both the admission and the capsule, so the
    // lineage is resolvable after a restart.
    assert.equal(result.receipt.admissionId, result.admission.admissionId);
    assert.equal(result.receipt.admissionDigest, result.admission.digest);
    assert.equal(result.receipt.capsuleId, result.executionCapsule.capsuleId);
    assert.equal(cp.getRouteAdmission(runId, result.admission.admissionId).decision, 'admitted');
  });
});

test('K3-4: an unconfigured Host default cannot carry a T3 independent review', async () => {
  await withT3Run(async (cp, runId) => {
    let launched = false;
    const adapter = createClaudeAdapter({ launch: async () => { launched = true; return { resolvedModel: 'whatever', sessionId: 's' }; } });
    const result = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter,
      // No model configured anywhere: the installed Host default would run.
      registry: createModelRegistry({ surface: 'claude', env: {} }),
      actionContext: reviewContext,
    });

    assert.equal(result.dispatched, false);
    assert.equal(result.reason, REJECTION_CODES.REVIEW_NOT_ADVISORY);
    assert.equal(launched, false, 'a blocked admission must not start a worker');
    assert.equal(result.receipt, null);

    // The refusal is persisted: a blocked turn is evidence, not silence.
    const admissions = cp.listRouteAdmissions(runId);
    assert.equal(admissions.at(-1).decision, 'blocked');
    assert.equal(admissions.at(-1).rejectionCode, REJECTION_CODES.REVIEW_NOT_ADVISORY);
  });
});

test('K3: a Host with no independent context cannot dispatch the review at all', async () => {
  await withT3Run(async (cp, runId) => {
    const adapter = createClaudeAdapter({ launch: async () => ({ resolvedModel: 'configured-frontier', sessionId: 's' }) });
    // Strip the capability the independent review depends on.
    const degraded = {
      ...adapter,
      capabilities: {
        ...adapter.capabilities,
        supportsIndependentContext: false,
        supportsCrossSurfaceReview: false,
      },
    };
    const result = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter: degraded,
      registry: createModelRegistry({ surface: 'claude', env: CONFIGURED }),
      actionContext: reviewContext,
    });
    assert.equal(result.dispatched, false);
    // The enforcement strategy already reports `unsupported` for an independent
    // turn this Host cannot isolate; admission refuses it explicitly.
    assert.ok([
      REJECTION_CODES.REVIEW_NO_INDEPENDENT_CONTEXT,
      REJECTION_CODES.REVIEW_NOT_ADVISORY,
      'no-independent-review-capability',
    ].includes(result.reason), result.reason);
    assert.equal(result.receipt, null);
  });
});

test('K3-9: a Kernel-owned action produces no admission and no dispatch', async () => {
  await withT3Run(async (cp, runId) => {
    const adapter = createClaudeAdapter({ launch: async () => { throw new Error('must not be called'); } });
    const result = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter,
      registry: createModelRegistry({ surface: 'claude', env: CONFIGURED }),
      actionContext: { actionKind: 'prove' },
    });
    assert.equal(result.dispatched, false);
    assert.equal(result.reason, 'kernel-owned-action');
    assert.deepEqual(cp.listRouteAdmissions(runId), [], 'a Kernel-owned action never reaches admission');
  });
});
