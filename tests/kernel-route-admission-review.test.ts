// K3 for reviews: an independent review is the one turn whose routing cannot be
// approximate. Admission refuses to dispatch it on anything but a frontier,
// read-only, independently-contexted session — through the real dispatcher.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { dispatchKernelTurn } from '../src/host/kernel/turn-dispatcher.js';
import { createModelRegistry } from '../src/host/kernel/model-registry.js';
import { createClaudeAdapter } from '../src/host/kernel/adapters/claude.js';
import { createCodexAdapter } from '../src/host/kernel/adapters/codex.js';
import { REJECTION_CODES } from '../src/host/kernel/route-admission.js';

const CONFIGURED = { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'configured-frontier', MOON_RELAY_KERNEL_MODEL_VALUE: 'configured-value' };

type TestControlPlane = Awaited<ReturnType<typeof createKernelControlPlane>>;
const withT3Run = async <T>(fn: (cp: TestControlPlane, runId: string, fixture: { runtimeHome: string; projectRoot: string }) => T | Promise<T>) => {
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
    const adapter = createClaudeAdapter({ launch: async ({ invocation }) => { assert.ok(invocation && typeof invocation === 'object' && 'model' in invocation); return { resolvedModel: invocation.model, sessionId: 'reviewer-session' }; } });
    const result = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter,
      registry: createModelRegistry({ surface: 'claude', env: CONFIGURED }),
      actionContext: reviewContext,
    });

    assert.equal(result.dispatched, true);
    assert.ok(result.admission);
    assert.equal(result.admission.decision, 'admitted');
    assert.ok(result.admission.requested && typeof result.admission.requested === 'object');
    assert.ok(result && typeof result === 'object' && 'admission' in result);
    assert.ok(result.admission && typeof result.admission === 'object' && 'requested' in result.admission);
    assert.ok(result.admission.requested && typeof result.admission.requested === 'object' && 'modelClass' in result.admission.requested);
    assert.equal(result.admission.requested.modelClass, 'frontier_reasoning');
    assert.ok(result.admission.requested && typeof result.admission.requested === 'object' && 'permissions' in result.admission.requested);
    assert.equal(result.admission.requested.permissions, 'read_only');
    assert.ok(result.admission.resolved && typeof result.admission.resolved === 'object');
    assert.ok(result.admission && typeof result.admission === 'object' && 'resolved' in result.admission);
    assert.ok(result.admission.resolved && typeof result.admission.resolved === 'object' && 'model' in result.admission.resolved);
    assert.equal(result.admission.resolved.model, 'configured-frontier');
    assert.ok(result.executionCapsule);
    assert.equal(result.executionCapsule.role, 'reviewer');

    // K3-10: the receipt carries both the admission and the capsule, so the
    // lineage is resolvable after a restart.
    assert.ok(result && typeof result === 'object' && 'receipt' in result);
    assert.ok(result.receipt && typeof result.receipt === 'object');
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'admissionId' in result.receipt);
    assert.equal(result.receipt.admissionId, result.admission.admissionId);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'admissionDigest' in result.receipt);
    assert.equal(result.receipt.admissionDigest, result.admission.digest);
    assert.ok(result.receipt && typeof result.receipt === 'object' && 'capsuleId' in result.receipt);
    assert.equal(result.receipt.capsuleId, result.executionCapsule.capsuleId);
    assert.ok(typeof result.admission.admissionId === 'string');
    const recordedAdmission = cp.getRouteAdmission(runId, result.admission.admissionId);
    assert.ok(recordedAdmission);
    assert.equal(recordedAdmission.decision, 'admitted');
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
    const refusal = admissions.at(-1);
    assert.ok(refusal);
    assert.equal(refusal.decision, 'blocked');
    assert.equal(refusal.rejectionCode, REJECTION_CODES.REVIEW_NOT_ADVISORY);
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
    assert.ok(result.reason);
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
