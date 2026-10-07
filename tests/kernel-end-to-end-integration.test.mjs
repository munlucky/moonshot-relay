import { decideTestModelRoute } from './helpers/kernel-host-test-api.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { computeKernelSourceIdentity, createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';
import { routeSkill, resolveExplicitSkillInvocation } from '../scripts/skill-router.mjs';
import { installKernel, uninstallKernel } from '../scripts/kernel/installer.mjs';
import { hashSessionId } from '../scripts/kernel/run/model-route-contract.mjs';

const validDigest = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

test('End-to-End Kernel Product Execution Flow', async () => {
  const tmpHome = await mkdtemp(path.join(os.tmpdir(), 'krn-e2e-home-'));
  const tmpProject = await mkdtemp(path.join(os.tmpdir(), 'krn-e2e-proj-'));
  const taskContract = {
    riskTier: 'T3',
    acceptanceCriteria: [{
      acceptance: 'criteria-1',
      evidencePlan: { class: 'hard', method: 'static-analysis', obligationId: 'static-analysis' },
    }],
  };
  const sourceIdentity = computeKernelSourceIdentity({ projectRoot: tmpProject, objective: 'Complete E2E test', taskContract });

  // 1. Install Kernel track in project
  await installKernel({ targetRoot: tmpProject });
  await writeFile(path.join(tmpProject, 'package.json'), JSON.stringify({
    name: 'kernel-e2e-fixture',
    version: '0.0.1',
    scripts: {
      lint: 'node -e "process.exit(0)"',
      test: 'node -e "process.exit(0)"',
    },
  }, null, 2));

  // 2. Explicit skill resolution for $moon-relay-kernel
  const explicitRes = await resolveExplicitSkillInvocation('$moon-relay-kernel', { repoRoot: process.cwd(), projectRoot: tmpProject });
  assert.equal(explicitRes.status, 'pass');
  assert.equal(explicitRes.selected, 'moon-relay-kernel');

  // 3. Initialize Control Plane & start run
  const cp = await createKernelControlPlane({ runtimeHome: tmpHome, projectRoot: tmpProject });
  const run = await cp.startRun({
    runId: 'e2e-run-1',
    objective: 'Complete E2E test',
    sourceIdentity,
    taskContract,
  });

  assert.equal(run.proofTier, 'T3');
  assert.equal(run.evidenceTier, 'E2');
  assert.deepEqual(run.requiredObligations, ['static-analysis', 'unit-test', 'security-review']);

  // 4. Build context
  const contextReceipt = await cp.buildStageContext('e2e-run-1', { stage: 'EXECUTE' });
  assert.equal(contextReceipt.schemaVersion, 1);
  assert.match(contextReceipt.promptBlock, /## Stable Principles/);
  assert.ok(contextReceipt.receipt.included.some((entry) => entry.id === 'capability-decision-e2e-run-1'));
  assert.equal(contextReceipt.receipt.policyRevision, 'kernel-context-policy.v1');
  assert.match(contextReceipt.receipt.policyDigest, /^[a-f0-9]{64}$/);

  // 5. Workflow transitions: FRAME -> EXECUTE -> PROVE
  await cp.transition('e2e-run-1', 'EXECUTE');
  await cp.transition('e2e-run-1', 'PROVE');

  // 6. Record proofs for all 3 required obligations
  await cp.recordProof('e2e-run-1', {
    obligationId: 'static-analysis',
    status: 'passed',
    evidenceRef: 'evidence://static/1',
    command: 'npm run lint',
    exitCode: 0,
    evidenceDigest: validDigest,
    sourceIdentity,
    acceptanceCoverage: ['criteria-1'],
  });

  await cp.recordProof('e2e-run-1', {
    obligationId: 'unit-test',
    status: 'passed',
    evidenceRef: 'evidence://unit/1',
    command: 'npm test',
    exitCode: 0,
    evidenceDigest: validDigest,
    sourceIdentity,
  });

  const proveContext = await cp.buildStageContext('e2e-run-1', { stage: 'PROVE' });
  assert.match(proveContext.promptBlock, /## Evidence Digest/);
  assert.ok(proveContext.receipt.included.some((entry) => entry.id === 'verification-static-analysis'));
  assert.ok(proveContext.receipt.included.some((entry) => entry.sourceRef === 'evidence://unit/1'));

  // `security-review` is a judgment obligation: it is satisfied by a structured
  // independent verdict, never by an attested command that merely claims it.
  await assert.rejects(
    (async () => {
      await cp.recordProof('e2e-run-1', {
        obligationId: 'security-review',
        status: 'passed',
        evidenceRef: 'evidence://security/1',
        command: 'npm run audit',
        exitCode: 0,
        evidenceDigest: validDigest,
        sourceIdentity,
      });
      const blocked = await cp.assessCompletion('e2e-run-1');
      if (blocked.decision !== 'accepted') throw new Error('security-review not satisfiable by attested command');
    })(),
    /security-review not satisfiable by attested command/,
  );

  // K0: nor by a judgment the report authored itself. The verdict must come
  // from a routed, independent reviewer session and be recorded as a Review
  // Receipt that the completion gate can re-check.
  const implementDecision = await decideTestModelRoute(cp, 'e2e-run-1', { actionKind: 'implement', obligationId: 'unit-test' });
  await cp.recordModelUsage('e2e-run-1', {
    decisionId: implementDecision.decisionId,
    runId: 'e2e-run-1',
    hostSurface: 'claude',
    actorSessionId: hashSessionId('e2e-implementer'),
    resolvedModel: 'configured-model',
    enforcementStatus: 'enforced',
    resultStatus: 'completed',
  });
  const reviewDecision = await decideTestModelRoute(cp, 'e2e-run-1', { actionKind: 'review_engineering', obligationId: 'security-review' });
  const reviewUsage = await cp.recordModelUsage('e2e-run-1', {
    decisionId: reviewDecision.decisionId,
    runId: 'e2e-run-1',
    hostSurface: 'claude',
    actorSessionId: hashSessionId('e2e-reviewer'),
    resolvedModel: 'configured-model',
    enforcementStatus: 'enforced',
    resultStatus: 'completed',
  });
  const review = await cp.recordReview(
    'e2e-run-1',
    { stage: 'engineering', verdict: 'pass', reviewerId: 'reviewer-2' },
    { implementerId: 'implementer-1', reviewReceiptId: reviewUsage.receiptId, obligationId: 'security-review', rationale: 'no security boundary regression' },
  );
  assert.equal(review.reviewReceipt.reviewer.enforcementStatus, 'enforced');

  // 7. Finalize run
  const finRes = await cp.finalizeRun('e2e-run-1');
  assert.equal(finRes.completionStatus, 'accepted');
  assert.equal(finRes.finalizationStatus, 'completed');

  await cp.close();

  // 8. Uninstall Kernel & verify pristine cleanup
  const uninstallRes = await uninstallKernel({ targetRoot: tmpProject });
  assert.equal(uninstallRes.status, 'uninstalled');
});

test('Relay track project rejects Kernel-only explicit skill invocation with wrong_harness', async () => {
  const tmpRelay = await mkdtemp(path.join(os.tmpdir(), 'krn-e2e-relay-'));
  await mkdir(path.join(tmpRelay, '.moon-relay'), { recursive: true });
  await writeFile(path.join(tmpRelay, '.moon-relay', 'track.yaml'), 'schemaVersion: 1\ntrack: relay\nproduct: moonshot-relay\n');
  const res = await resolveExplicitSkillInvocation('$moon-relay-kernel', { repoRoot: process.cwd(), projectRoot: tmpRelay });
  assert.equal(res.status, 'fail');
  assert.equal(res.findings[0].code, 'wrong_harness');
});
