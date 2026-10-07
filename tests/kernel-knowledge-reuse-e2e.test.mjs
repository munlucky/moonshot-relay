import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';
import {
  buildEvidenceIdentity,
  buildEvidenceReuseReceipt,
  exactEvidenceIdentityMatch,
} from '../scripts/kernel/proof/evidence-reuse.mjs';

test('Cross-Run Knowledge Reuse E2E: verifies direct SQLite knowledge context retrieval, revision continuity after projection deletion, and project root isolation', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kernel-reuse-e2e-'));
  const kernelHome = path.join(tmpDir, '.moon-relay-kernel');
  const projectRoot = path.join(tmpDir, 'project-root');

  let controlPlane = await createKernelControlPlane({
    projectRoot,
    runtimeHome: kernelHome,
    holder: 'chat-one',
  });

  // --- 1. Run 1: Create, Record Proof, Record Typed Candidates & Finalize ---
  const run1 = await controlPlane.startRun({
    runId: 'run-e2e-1',
    objective: 'Implement authentication service',
  });
  assert.equal(run1.runId, 'run-e2e-1');
  assert.equal(run1.knowledgeRevisionStart, '1');

  // Transition run to EXECUTE -> PROVE state to allow proof recording
  await controlPlane.transition('run-e2e-1', 'EXECUTE');
  await controlPlane.transition('run-e2e-1', 'PROVE');

  const proofDigest1 = 'sha256:' + '1'.repeat(64);
  await controlPlane.recordProof('run-e2e-1', {
    obligationId: 'default',
    status: 'passed',
    evidenceRef: 'proof:test-e2e-1',
    evidenceDigest: proofDigest1,
    exitCode: 0,
    command: 'npm test',
  });

  // Transition run to CLOSE state to allow acceptance finalization
  await controlPlane.transition('run-e2e-1', 'CLOSE');

  // Record typed knowledge observations (architecture_decision, semantic_fact, domain_term, episodic_observation)
  const observations1 = [
    {
      id: 'arch-jwt-01',
      proposedType: 'architecture_decision',
      statement: 'Use JWT stateless session tokens for auth service',
      rationale: 'Scalable auth without session DB lookup',
      trustTier: 'verified',
    },
    {
      id: 'fact-port-4000',
      proposedType: 'semantic_fact',
      statement: 'Authentication service runs on port 4000',
      trustTier: 'verified',
    },
    {
      id: 'domain-auth-term',
      proposedType: 'domain_term',
      statement: 'Access Token: Short-lived bearer token used for API requests',
      trustTier: 'verified',
    },
    {
      id: 'episodic-token-expiry',
      proposedType: 'tacit_observation',
      statement: 'Token expiration handling required graceful retry logic',
      trustTier: 'verified',
    },
  ];

  await controlPlane.recordKnowledgeObservations('run-e2e-1', {
    observations: observations1,
    approvals: [
      { candidateId: 'arch-jwt-01', approved: true, approvedBy: 'user' },
      { candidateId: 'fact-port-4000', approved: true, approvedBy: 'user' },
      { candidateId: 'domain-auth-term', approved: true, approvedBy: 'user' },
      { candidateId: 'episodic-token-expiry', approved: true, approvedBy: 'user' },
    ],
  });

  const finalizationResult1 = await controlPlane.finalizeRun('run-e2e-1', {
    gitCloseoutRequest: { mode: 'none', approvalReceipt: { approved: true, approvedBy: 'user' } },
  });

  assert.equal(finalizationResult1.finalizationStatus, 'completed');
  assert.equal(finalizationResult1.knowledgeStatus, 'committed');

  // --- 2. Projection Deletion: Remove physical projection directory completely ---
  const projectId = run1.projectId;
  const projectionDir = path.join(kernelHome, 'state', 'projects', projectId, 'knowledge');
  await rm(projectionDir, { recursive: true, force: true });

  // The first greenfield run has now produced a real project seam. A
  // successor with committed project knowledge is brownfield, so its
  // proof-policy command must exist before the next Run starts.
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'knowledge-reuse-fixture',
    scripts: { test: 'node -e "process.exit(0)"' },
  }));

  // A new chat/session reopens the same durable project authority. Knowledge
  // reuse must not depend on the transcript, owner session, or projections.
  await controlPlane.close();
  controlPlane = await createKernelControlPlane({
    projectRoot,
    runtimeHome: kernelHome,
    holder: 'chat-two',
  });

  // --- 3. Run 2: Start new Run, verify SQLite revision authority & re-commit ---
  const run2 = await controlPlane.startRun({
    runId: 'run-e2e-2',
    objective: 'Build user dashboard requiring auth',
  });
  assert.equal(run2.runId, 'run-e2e-2');
  // Crucial check: start revision is 2 (read directly from SQLite authority, not reset by missing revision.json!)
  assert.equal(run2.knowledgeRevisionStart, '2');

  const run2FrameContext = await controlPlane.buildStageContext('run-e2e-2', { stage: 'FRAME' });
  assert.ok(run2FrameContext.knowledgeContext);
  assert.equal(run2FrameContext.knowledgeContext.status, 'ready-populated');

  const promptBlockText = run2FrameContext.knowledgeContext.promptBlock;
  assert.ok(promptBlockText.includes('Use JWT stateless session tokens for auth service'));
  assert.ok(promptBlockText.includes('Authentication service runs on port 4000'));
  assert.ok(promptBlockText.includes('Access Token: Short-lived bearer token used for API requests'));
  assert.ok(promptBlockText.includes('Token expiration handling required graceful retry logic'));

  // Transition run2 to EXECUTE -> PROVE -> CLOSE
  await controlPlane.transition('run-e2e-2', 'EXECUTE');
  await controlPlane.transition('run-e2e-2', 'PROVE');

  const proofDigest2 = 'sha256:' + '2'.repeat(64);
  await controlPlane.recordProof('run-e2e-2', {
    obligationId: 'default',
    status: 'passed',
    evidenceRef: 'proof:test-e2e-2',
    evidenceDigest: proofDigest2,
    exitCode: 0,
    command: 'npm test',
  });

  await controlPlane.transition('run-e2e-2', 'CLOSE');

  // Record new observations in Run 2 (including tacit_practice alias) and finalize
  await controlPlane.recordKnowledgeObservations('run-e2e-2', {
    observations: [
      {
        id: 'fact-mfa-support',
        proposedType: 'semantic_fact',
        statement: 'MFA TOTP authentication supported for admin accounts',
        trustTier: 'verified',
      },
      {
        id: 'tacit-auth-retry',
        proposedType: 'tacit_practice',
        statement: 'Retry transient authentication failures with bounded backoff',
        trustTier: 'verified',
      },
    ],
    approvals: [
      { candidateId: 'fact-mfa-support', approved: true, approvedBy: 'user' },
      { candidateId: 'tacit-auth-retry', approved: true, approvedBy: 'user' },
    ],
  });

  const finalizationResult2 = await controlPlane.finalizeRun('run-e2e-2', {
    gitCloseoutRequest: { mode: 'none', approvalReceipt: { approved: true, approvedBy: 'user' } },
  });

  assert.equal(finalizationResult2.finalizationStatus, 'completed');
  assert.equal(finalizationResult2.knowledgeStatus, 'committed');
  assert.equal(finalizationResult2.knowledgeCommitReceipt.revisionBefore, '2');
  assert.equal(finalizationResult2.knowledgeCommitReceipt.revisionAfter, '3');
  assert.equal(finalizationResult2.knowledgeCommitReceipt.status, 'committed');

  // --- 4. Project Root Isolation: Verify distinct projectRoot does not see this knowledge ---
  const projectRootOther = path.join(tmpDir, 'project-root-other');
  const controlPlaneOther = await createKernelControlPlane({
    projectRoot: projectRootOther,
    runtimeHome: kernelHome,
  });

  const runOther = await controlPlaneOther.startRun({
    runId: 'run-e2e-other',
    objective: 'Unrelated payment service work',
  });

  const otherContext = await controlPlaneOther.buildStageContext('run-e2e-other', { stage: 'FRAME' });
  const otherPromptBlock = otherContext.knowledgeContext.promptBlock;
  assert.equal(otherPromptBlock.includes('Use JWT stateless session tokens for auth service'), false);
  assert.equal(otherPromptBlock.includes('Authentication service runs on port 4000'), false);

  await controlPlaneOther.close();
  await controlPlane.close();
  await rm(tmpDir, { recursive: true, force: true });
});

test('cross-report proof reuse requires the complete exact freshness identity', () => {
  const identity = buildEvidenceIdentity({
    commandRef: 'test:kernel',
    verifierVersion: 'kernel-proof-v2',
    sourceInputDigest: 'sha256:source',
    artifactDigest: 'sha256:artifact',
    fixtureDigest: 'sha256:fixture',
    environment: { fingerprint: 'sha256:environment' },
    verificationScopeDigest: 'sha256:scope',
  });
  const same = { ...identity, values: { ...identity.values } };
  const changedScope = {
    ...identity,
    values: { ...identity.values, verificationScopeDigest: 'sha256:other-scope' },
  };
  assert.equal(exactEvidenceIdentityMatch(identity, same), true);
  assert.equal(exactEvidenceIdentityMatch(identity, changedScope), false);

  const receipt = buildEvidenceReuseReceipt({
    runId: 'run-current',
    obligationId: 'default',
    priorRunId: 'run-prior',
    priorVerificationId: 7,
    mutationRevision: 3,
    identity,
    evidenceDigest: 'sha256:evidence',
  });
  assert.equal(receipt.priorRunId, 'run-prior');
  assert.equal(receipt.priorVerificationId, 7);
  assert.equal(receipt.identity, identity.digest);
});
