import { prepareTestHostTurn } from './helpers/kernel-host-test-api.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';
import { evaluateReviewReceipt } from '../scripts/kernel/proof/review-receipt.mjs';
import { hashSessionId } from '../scripts/kernel/run/model-route-contract.mjs';
import { resolveCodexActorRoute } from '../scripts/host/kernel/codex-actor-router.mjs';
import { dispatchKernelTurn } from '../scripts/host/kernel/turn-dispatcher.mjs';

const setup = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-subagent-rev-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-subagent-rev-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await mkdir(path.join(projectRoot, '.moon-relay'), { recursive: true });
  await writeFile(path.join(projectRoot, '.moon-relay', 'track.yaml'), 'track: kernel\nproduct: moon-relay-kernel\n');
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'subagent-review-test',
    version: '0.0.1',
    scripts: { test: 'node -e "process.exit(0)"' },
  }));
  await writeFile(path.join(projectRoot, 'feature.mjs'), 'export const reviewed = true;\n');
  return { runtimeHome, projectRoot };
};

const cleanup = async ({ runtimeHome, projectRoot }) => {
  await rm(runtimeHome, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
};

test('Subagent Review: Action and Host Directive route to native-subagent when independent review is required', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane({
    ...fixture,
    env: {
      ...process.env,
      MOON_RELAY_KERNEL_SESSION_ID: 'codex:implementer-session-1',
      MOON_RELAY_KERNEL_PROVIDER: 'codex',
    },
  });

  try {
    const runId = 'r-subagent-review-1';
    await cp.startRun({
      runId,
      objective: 'implement feature with independent subagent review requirement',
      taskContract: {
        riskTier: 'T0',
        acceptance: [{
          acceptance: 'code passes qualitative judgment review',
          evidencePlan: { class: 'judgment', method: 'code-review', obligationId: 'review-judgment' },
        }],
        allowedPaths: ['feature.mjs'],
      },
    });

    await cp.transition(runId, 'EXECUTE');
    await cp.transition(runId, 'PROVE');

    // First record hard proof for unit test so only judgment obligation remains pending
    await cp.recordProof(runId, {
      obligationId: 'default',
      status: 'passed',
      evidenceRef: 'ev-test-pass',
      commandRef: 'test',
      command: 'node -e "process.exit(0)"',
      exitCode: 0,
      evidenceDigest: `sha256:${'a'.repeat(64)}`,
      acceptanceCoverage: [],
    });

    // Model-visible next() check
    const nextTurn = await cp.next(runId);
    assert.equal(nextTurn.action.type, 'review', 'Action should be review');
    assert.equal(nextTurn.action.mode, 'subagent', 'Action mode should be subagent');
    assert.equal(nextTurn.action.execution?.executionMode, 'native-subagent', 'Execution mode must be native-subagent');
    assert.equal(nextTurn.action.execution?.delegation?.target, 'subagent', 'Delegation target must be subagent');
    assert.match(nextTurn.action.guidance, /native subagent/i, 'Guidance should instruct subagent execution');

    // HostDirective check via hostNext()
    const hostTurn = await prepareTestHostTurn(cp, runId, {
      hostCapabilities: { surface: 'codex-desktop', nativeSubagent: true },
    });
    assert.equal(
      hostTurn.hostDirective.executionAssignment.executionMode,
      'native-subagent',
      'Host directive assignment executionMode must be native-subagent',
    );
    assert.equal(
      hostTurn.hostDirective.executionAssignment.delegation.requested,
      true,
      'Host directive delegation requested must be true',
    );

    // Record review receipt with independent subagent session
    const store = cp.stateStore;
    const run = store.getRun(runId);
    const implementerSession = 'codex:implementer-session-1';
    const subagentSession = 'codex:subagent-session-42';

    const reviewReceipt = {
      runId,
      obligationId: 'review-judgment',
      reviewStage: 'engineering',
      verdict: 'pass',
      rationale: 'Independent subagent verified code meets all engineering guidelines.',
      findings: [],
      findingClass: 'none',
      subject: {
        mutationRevision: run.mutationRevision,
        workspaceIdentity: run.currentWorkspaceIdentity,
        changedPathsDigest: `sha256:${'d'.repeat(64)}`,
        evidenceDigest: `sha256:${'e'.repeat(64)}`,
      },
      implementer: {
        actorSessionId: hashSessionId(implementerSession),
      },
      reviewer: {
        actorSessionId: hashSessionId(subagentSession),
        usageReceiptId: 'usage-rcpt-subagent-1',
        modelClass: 'frontier_reasoning',
        enforcementStatus: 'enforced',
      },
    };

    // Evaluate independent session check
    const evaluation = evaluateReviewReceipt({
      receipt: reviewReceipt,
      run,
      requireIndependentSession: true,
      currentEvidenceDigest: `sha256:${'e'.repeat(64)}`,
    });
    assert.equal(evaluation.usable, true, `Review receipt must be usable: ${evaluation.reasons.join(', ')}`);
    assert.notEqual(
      reviewReceipt.reviewer.actorSessionId,
      reviewReceipt.implementer.actorSessionId,
      'Reviewer session must be distinct from implementer session',
    );

    // Record review through production control plane method
    await cp.recordReview(runId, {
      stage: 'engineering',
      verdict: 'pass',
      findings: [],
    }, {
      implementerId: implementerSession,
      obligationId: 'review-judgment',
      acceptanceCoverage: ['code passes qualitative judgment review'],
    });

    const verifications = store.getVerifications(runId);
    assert.ok(verifications.length > 0);
    const judgmentVerification = verifications.find((v) => v.obligationId === 'review-judgment');
    assert.ok(judgmentVerification);
    assert.equal(judgmentVerification.status, 'passed');

    const preCloseAssessment = await cp.assessCompletion(runId);
    assert.equal(preCloseAssessment.readyExceptClose, true);

    await cp.transition(runId, 'CLOSE');
    const completion = await cp.assessCompletion(runId);
    assert.equal(completion.decision, 'accepted');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('Subagent Review: Independent reviewer fails closed as review-pending on unsupported host and never falls back to owner-direct', () => {
  const route = resolveCodexActorRoute({
    decision: { role: 'reviewer', independentContextRequired: true },
    capabilities: { supportsSubagentModel: false, supportsIndependentContext: false },
    hasNativeLauncher: false,
  });

  assert.equal(route.dispatchMechanism, 'review-pending');
  assert.notEqual(route.dispatchMechanism, 'owner-direct');
});

test('Subagent Review: dispatchKernelTurn invokes adapter launcher when adapter has subagent capability', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const runId = 'r-subagent-dispatch-real';
    await cp.startRun({
      runId,
      objective: 'verify native dispatch',
      taskContract: {
        riskTier: 'T0',
        acceptance: [{
          acceptance: 'code passes qualitative judgment review',
          evidencePlan: { class: 'judgment', method: 'code-review', obligationId: 'review-judgment' },
        }],
        allowedPaths: ['app.mjs'],
      },
    });

    await cp.transition(runId, 'EXECUTE');
    await cp.transition(runId, 'PROVE');

    await cp.recordProof(runId, {
      obligationId: 'default',
      status: 'passed',
      evidenceRef: 'ev-test-pass',
      commandRef: 'test',
      command: 'node -e "process.exit(0)"',
      exitCode: 0,
      evidenceDigest: `sha256:${'a'.repeat(64)}`,
      acceptanceCoverage: [],
    });

    let launcherCalled = false;
    let launchedMode = null;
    const testAdapter = {
      capabilities: {
        surface: 'codex',
        nativeSubagent: true,
        supportsSubagentModel: true,
        semantic: {
          freshContext: true,
          workspaceWrite: true,
          workspaceIsolation: true,
          parallelExecution: true,
          independentReview: true,
          modelSelection: false,
        },
      },
      ownerDirectDefault: true,
      nativeDelegationAvailable: true,
      dispatch: async (params) => {
        launcherCalled = true;
        launchedMode = params.actionContext?.executionMode;
        return {
          status: 'completed',
          dispatched: true,
          executionMode: launchedMode,
        };
      },
    };

    const inputActionContext = {};
    assert.equal(inputActionContext.executionMode, undefined, 'Input executionMode must be undefined');

    const dispatchResult = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter: testAdapter,
      actionContext: inputActionContext,
    });

    assert.equal(launcherCalled, true, 'Adapter launcher MUST be called when subagent capability is present');
    assert.equal(launchedMode, 'native-subagent', 'Launched mode must be native-subagent');
    assert.equal(dispatchResult.dispatched, true);
    assert.equal(dispatchResult.hostDirective?.executionAssignment?.executionMode, 'native-subagent');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});
