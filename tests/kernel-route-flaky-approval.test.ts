import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { openKernelStateStore } from '../src/kernel/state-store.js';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { executeApprovedProof, executeWithFlakyRerun, CommandApprovalRequiredError, UntrustedCommandError } from '../src/host/kernel/proof/proof-executor.js';
import { assertWaiverAllowed, isProtectedObligation } from '../src/kernel/proof/protected-obligations.js';
import { resolveProofEscalation } from '../src/kernel/proof-route.js';
import { evaluateTrustCompletion } from '../src/kernel/proof/trust-authority.js';

const validDigest = 'sha256:' + 'a'.repeat(64);

test('route escalation only promotes tiers and refuses demotion', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-escalate-'));
  const store = await openKernelStateStore({ runtimeHome });
  try {
    store.createRun({ runId: 'r-esc', objective: 'x', sourceIdentity: 'src-esc', proofTier: 'T1', evidenceTier: 'E1', requiredObligations: ['unit-test'] });
    const current = store.getRun('r-esc');
    assert.ok(current);
    const policy = resolveProofEscalation(current, { proofTier: 'T3', evidenceTier: 'E2', addObligations: ['security-review'] });
    const up = store.setRunProofPolicy('r-esc', policy);
    assert.equal(up.proofTier, 'T3');
    assert.equal(up.evidenceTier, 'E2');
    assert.ok(up.requiredObligations.includes('security-review'));
    assert.ok(up.requiredObligations.includes('unit-test'));
    assert.throws(() => resolveProofEscalation(up, { proofTier: 'T1' }), /ROUTE_DEMOTION_FORBIDDEN/);
    assert.throws(() => resolveProofEscalation(up, { evidenceTier: 'E0' }), /ROUTE_DEMOTION_FORBIDDEN/);
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('only policy-declared protected obligations reject waivers', async () => {
  assert.equal(isProtectedObligation('auth-regression'), false);
  assert.equal(isProtectedObligation('payment-checkout'), false);
  assert.equal(isProtectedObligation('data-migration-smoke'), true);
  assert.equal(isProtectedObligation('security-review'), true);
  assert.equal(isProtectedObligation('render-button'), false);

  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-protected-'));
  const store = await openKernelStateStore({ runtimeHome });
  try {
    store.createRun({ runId: 'r-prot', objective: 'x', sourceIdentity: 'src-prot', requiredObligations: ['data-migration-smoke'] });
    store.transition('r-prot', 'EXECUTE');
    store.transition('r-prot', 'PROVE');
    assert.throws(
      () => assertWaiverAllowed('data-migration-smoke'),
      /PROTECTED_OBLIGATION_WAIVER_FORBIDDEN/,
    );
    assert.doesNotThrow(() => assertWaiverAllowed('render-check'));
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('a run that passed on a waiver is completed but marked degraded', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-degraded-'));
  const store = await openKernelStateStore({ runtimeHome });
  try {
    store.createRun({ runId: 'r-deg', objective: 'x', sourceIdentity: 'src-deg', requiredObligations: ['render-check'] });
    store.transition('r-deg', 'EXECUTE');
    store.transition('r-deg', 'PROVE');
    store.addWaiver('r-deg', { obligationId: 'render-check', approvedBy: 'reviewer', reason: 'flaky UI', approvalReceipt: 'r://ok' });
    store.transition('r-deg', 'CLOSE');
    const degradedRun = store.getRun('r-deg');
    assert.ok(degradedRun);
    const evalRes = evaluateTrustCompletion({ run: degradedRun, verifications: store.getVerifications('r-deg'), obligations: store.getRunObligations('r-deg'), waivers: store.getWaivers('r-deg'), reviewReceipts: store.listReviewReceipts('r-deg'), releaseEvidence: store.getLatestEvidencePack('r-deg'), mutationProvenance: store.getMutationProvenance('r-deg') });
    assert.equal(evalRes.decision, 'accepted');
    assert.equal(evalRes.completionQuality, 'degraded');
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('discovered command execution requires explicit approval', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-approve-'));
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' } }));
  try {
    assert.throws(
      () => executeApprovedProof({ projectRoot, command: 'node', args: ['-e', 'process.exit(0)'] }),
      CommandApprovalRequiredError,
    );
    // Disallowed executable is refused even with approval.
    assert.throws(
      () => executeApprovedProof({ projectRoot, command: 'rm', args: ['-rf', '.'], approval: { approvedBy: 'u', approvalReceipt: 'r://1' } }),
      UntrustedCommandError,
    );
    // Approved allowlisted command runs and yields honest facts.
    const ok = executeApprovedProof({ projectRoot, command: 'node', args: ['-e', 'process.exit(0)'], approval: { approvedBy: 'u', approvalReceipt: 'r://1' } });
    assert.equal(ok.status, 'passed');
    assert.equal(ok.trust, 'approved-discovered');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('flaky rerun re-executes once and flags divergent pass/fail', () => {
  let call = 0;
  const flakyRunner = () => {
    call += 1;
    return { status: call === 1 ? 'failed' : 'passed', exitCode: call === 1 ? 1 : 0 };
  };
  const result = executeWithFlakyRerun(flakyRunner);
  assert.equal(result.reruns, 1);
  assert.equal(result.flaky, true);
  assert.equal(result.status, 'passed');

  let stableCall = 0;
  const stableRunner = () => { stableCall += 1; return { status: 'failed', exitCode: 1 }; };
  const stable = executeWithFlakyRerun(stableRunner);
  assert.equal(stable.flaky, false);
  assert.equal(stable.reruns, 1);
});

test('control plane escalateRoute promotes a live run', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-escalate-cp-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-escalate-cp-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' } }));
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    await cp.startRun({ runId: 'r-esc-cp', objective: 'x', taskContract: { behaviorChanging: true } });
    const escalated = await cp.escalateRoute('r-esc-cp', { proofTier: 'T3', evidenceTier: 'E2', addObligations: ['security-review'] });
    assert.equal(escalated.proofTier, 'T3');
    assert.ok(escalated.requiredObligations.includes('security-review'));
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});
