import { prepareTestHostTurn, decideTestModelRoute } from './helpers/kernel-host-test-api.js';
// K1 §6.8: reviewers do not receive the implementer's capsule. They receive a
// read-only capsule describing the subject and the evidence, and nothing about
// how the implementation was reasoned about.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { capsuleStaleness, normalizeReviewCapsule } from '../src/kernel/run/execution-capsule.js';
import { hashSessionId } from '../src/contracts/model-execution.js';
import { dispatchKernelTurn } from '../src/host/kernel/turn-dispatcher.js';
import { createModelRegistry } from '../src/host/kernel/model-registry.js';
import { createClaudeAdapter } from '../src/host/kernel/adapters/claude.js';
import { MODEL_VISIBLE_PROMPT_FIELDS } from '../src/host/kernel/model-capsule-view.js';

const IMPLEMENTER = hashSessionId('review-capsule-implementer');

const setup = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-revcap-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-revcap-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'revcap-fixture', version: '0.0.1', scripts: { 'test:ok': 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' },
  }, null, 2));
  await mkdir(path.join(projectRoot, 'src', 'auth'), { recursive: true });
  await writeFile(path.join(projectRoot, 'src', 'auth', 'service.mjs'), 'export const v = 0;\n');
  spawnSync('git', ['add', '--all'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-m', 'fixture', '--quiet'], { cwd: projectRoot, encoding: 'utf8' });
  return { runtimeHome, projectRoot };
};

const cleanup = async ({ runtimeHome, projectRoot }: { runtimeHome: string; projectRoot: string }) => {
  await rm(runtimeHome, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
};

test('K1-8: the reviewer capsule is read-only and carries subject plus evidence only', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({
      runId: 'r-revcap',
      objective: 'auth boundary',
      taskContract: {
        surfaces: ['security_boundary'],
        acceptance: [{ acceptance: 'works', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'unit-test' } }],
        allowedPaths: ['src/auth/**'],
        constraints: ['keep the response shape'],
      },
    });
    await writeFile(path.join(fixture.projectRoot, 'src', 'auth', 'service.mjs'), 'export const v = 1;\n');

    const implementerCapsule = await cp.buildCapsule('r-revcap');
    const decision = await decideTestModelRoute(cp, 'r-revcap', { actionKind: 'implement', obligationId: 'unit-test' });
    await cp.recordModelUsage('r-revcap', {
      decisionId: decision.decisionId,
      runId: 'r-revcap',
      hostSurface: 'claude',
      actorSessionId: IMPLEMENTER,
      resolvedModel: 'configured-model',
      enforcementStatus: 'enforced',
      resultStatus: 'completed',
      capsuleId: implementerCapsule.capsuleId,
      capsuleDigest: implementerCapsule.provenance.capsuleDigest,
    });
    await cp.report('r-revcap', {
      summary: 'implemented',
      changedPaths: ['src/auth/service.mjs'],
      verifications: [
        { obligationId: 'unit-test', commandRef: 'test:ok', acceptanceCoverage: ['works'] },
        { obligationId: 'static-analysis', commandRef: 'lint' },
      ],
    });
    await cp.recordProof('r-revcap', {
      obligationId: 'security-review',
      status: 'failed',
      evidenceRef: 'review://r-revcap/review-receipt-deadbeef',
      command: 'structured-review',
      exitCode: 1,
      evidenceDigest: `sha256:${'d'.repeat(64)}`,
      evidenceClass: 'judgment',
    });
    await cp.recordProof('r-revcap', {
      obligationId: 'judgment-ac-1',
      status: 'failed',
      evidenceRef: 'review://r-revcap/review-receipt-sibling',
      command: 'structured-review',
      exitCode: 1,
      evidenceDigest: `sha256:${'e'.repeat(64)}`,
      evidenceClass: 'judgment',
    });

    const reviewCapsule = await cp.buildReviewerCapsule('r-revcap', {
      stage: 'engineering',
      obligationId: 'security-review',
      changedPaths: ['src/auth/service.mjs'],
    });

    assert.equal(reviewCapsule.role, 'reviewer');
    assert.equal(reviewCapsule.permissions.filesystem, 'read_only');
    assert.equal(reviewCapsule.permissions.canCommit, false);
    assert.notEqual(reviewCapsule.capsuleId, implementerCapsule.capsuleId);

    // Subject and evidence: what changed, against which state, and what ran.
    assert.deepEqual(reviewCapsule.subject.changedPaths, ['src/auth/service.mjs']);
    // The diff digest identifies the exact file states reviewed, without the
    // capsule carrying the diff — and it moves when the files move.
    assert.ok(typeof reviewCapsule.subject.diffDigest === 'string');
    assert.match(reviewCapsule.subject.diffDigest, /^sha256:[a-f0-9]{64}$/);
    await writeFile(path.join(fixture.projectRoot, 'src', 'auth', 'service.mjs'), 'export const v = 2;\n');
    const afterEdit = await cp.buildReviewerCapsule('r-revcap', { stage: 'engineering', obligationId: 'security-review', changedPaths: ['src/auth/service.mjs'] });
    assert.notEqual(afterEdit.subject.diffDigest, reviewCapsule.subject.diffDigest);
    const observedRun5 = await cp.getRun('r-revcap');
    assert.ok(observedRun5);
    assert.equal(reviewCapsule.subject.mutationRevision, observedRun5.mutationRevision);
    const evidence = Object.fromEntries(reviewCapsule.verificationEvidence.map((entry) => [entry.obligationId, entry]));
    assert.equal(evidence['unit-test'].status, 'passed');
    assert.equal(evidence['unit-test'].exitCode, 0);
    assert.equal(evidence['security-review'], undefined, 'a retry does not receive its own previous verdict as evidence');
    assert.equal(evidence['judgment-ac-1'], undefined, 'independent reviews do not inherit sibling judgment verdicts');
    assert.equal(reviewCapsule.reviewScope.stage, 'engineering');
    assert.equal(reviewCapsule.reviewScope.obligationId, 'security-review');

    // The implementation is identified by its receipt, not reproduced.
    assert.equal(reviewCapsule.implementationReceipt.actorSessionId, IMPLEMENTER);
    assert.equal(reviewCapsule.implementationReceipt.capsuleDigest, implementerCapsule.provenance.capsuleDigest);

    // What the reviewer must NOT receive.
    assert.equal(Reflect.get(reviewCapsule, 'repositoryContext'), undefined, 'no implementer repository context');
    assert.equal(Reflect.get(reviewCapsule, 'workUnit'), undefined, 'no implementer work unit or allowed paths');
    assert.equal(Reflect.get(reviewCapsule, 'verification'), undefined, 'no implementer obligation worksheet');
    const serialized = JSON.stringify(reviewCapsule);
    assert.ok(!serialized.includes('keep the response shape'), 'implementer constraints are not review input');
    assert.ok(!serialized.includes('workspace_write'));
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K1: a review capsule is a closed record with a read-only permission floor', () => {
  const base = {
    runId: 'r-1',
    subject: { changedPaths: ['a.mjs'], workspaceIdentity: `sha256:${'a'.repeat(64)}`, mutationRevision: 1 },
    reviewScope: { stage: 'contract' },
  };
  const capsule = normalizeReviewCapsule(base);
  assert.equal(capsule.permissions.filesystem, 'read_only');
  assert.match(capsule.capsuleId, /^capsule-[a-f0-9]{24}$/);
  assert.equal(normalizeReviewCapsule({ ...base, createdAt: '2026-01-01T00:00:00.000Z' }).capsuleId, capsule.capsuleId, 'identity excludes creation time');

  assert.throws(() => normalizeReviewCapsule({ ...base, reviewScope: { stage: 'implementation' } }), /reviewScope.stage/);
  assert.throws(() => normalizeReviewCapsule({ ...base, subject: { ...base.subject, workspaceIdentity: 'HEAD' } }), /workspaceIdentity/);
});

test('K1: reviewer capsule freshness is checked against its subject mutation revision', () => {
  const workspaceIdentity = `sha256:${'a'.repeat(64)}`;
  const capsule = normalizeReviewCapsule({
    runId: 'r-freshness',
    stepId: 'step-1',
    planRevision: 2,
    subject: { changedPaths: ['a.mjs'], workspaceIdentity, mutationRevision: 3 },
    reviewScope: { stage: 'engineering', obligationId: 'security-review' },
  });
  const run = { runId: 'r-freshness', planRevision: 2, mutationRevision: 3, currentWorkspaceIdentity: workspaceIdentity };
  assert.deepEqual(capsuleStaleness({ capsule, run }), { stale: false, reasons: [] });
  assert.deepEqual(capsuleStaleness({ capsule, run: { ...run, mutationRevision: 4 } }), { stale: true, reasons: ['capsule-stale-mutation-revision'] });
});

test('K1: the capsule reaches the worker launcher, not just the dispatcher', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({ runId: 'r-launch', objective: 'auth boundary', taskContract: { surfaces: ['security_boundary'], acceptance: ['works'], allowedPaths: ['src/auth/**'] } });
    const seenProviders: Record<string, unknown>[] = [];
    const adapter = createClaudeAdapter({
      launch: async (providerInput) => {
        seenProviders.push(providerInput);
        const { invocation } = providerInput;
        assert.ok(invocation && typeof invocation === 'object' && 'model' in invocation);
        return { resolvedModel: invocation.model, sessionId: 'worker' };
      },
    });

    const implementTurn = await dispatchKernelTurn({
      controlPlane: cp,
      runId: 'r-launch',
      adapter,
      registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'configured-frontier', MOON_RELAY_KERNEL_MODEL_VALUE: 'configured-value' } }),
      actionContext: { executionMode: 'native-subagent', delegationRequested: true },
    });
    // The provider launcher receives only the six-field projection. The full
    // capsule and execution contract stay on the Host/transport boundary.
    assert.ok(implementTurn && typeof implementTurn === 'object' && 'executionCapsule' in implementTurn);
    assert.ok(implementTurn.executionCapsule !== null && implementTurn.executionCapsule !== undefined);
    assert.ok(implementTurn.executionCapsule.capsuleId);

    const reviewTurn = await dispatchKernelTurn({
      controlPlane: cp,
      runId: 'r-launch',
      adapter,
      registry: createModelRegistry({ surface: 'claude', env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'configured-frontier', MOON_RELAY_KERNEL_MODEL_VALUE: 'configured-value' } }),
      actionContext: {
        actionKind: 'review_engineering',
        obligationId: 'security-review',
        executionMode: 'native-subagent',
        delegationRequested: true,
      },
    });
    assert.ok(reviewTurn && typeof reviewTurn === 'object' && 'executionCapsule' in reviewTurn);
    assert.ok(reviewTurn.executionCapsule !== null && reviewTurn.executionCapsule !== undefined);
    assert.ok(reviewTurn.executionCapsule.capsuleId);
    assert.equal(seenProviders.length, 2);
    for (const providerInput of seenProviders) {
      for (const forbidden of ['executionContract', 'executionCapsule', 'role', 'permissions', 'nonGoals']) {
        assert.ok(providerInput && typeof providerInput === 'object');
        assert.equal(Object.hasOwn(providerInput, forbidden), false, `provider input leaked ${forbidden}`);
        assert.ok(providerInput && typeof providerInput === 'object' && 'invocation' in providerInput);
        assert.ok(providerInput.invocation && typeof providerInput.invocation === 'object');
        assert.equal(Object.hasOwn(providerInput.invocation, forbidden), false, `provider invocation leaked ${forbidden}`);
      }
      assert.ok(providerInput && typeof providerInput === 'object' && 'modelVisiblePrompt' in providerInput);
      assert.ok(providerInput.modelVisiblePrompt && typeof providerInput.modelVisiblePrompt === 'object');
      assert.deepEqual(Object.keys(providerInput.modelVisiblePrompt), [...MODEL_VISIBLE_PROMPT_FIELDS]);
      assert.ok(providerInput && typeof providerInput === 'object' && 'prompt' in providerInput);
      assert.ok(providerInput && typeof providerInput === 'object' && 'modelVisiblePrompt' in providerInput);
      assert.deepEqual(providerInput.prompt, providerInput.modelVisiblePrompt);
      assert.ok(providerInput && typeof providerInput === 'object' && 'message' in providerInput);
      assert.ok(typeof providerInput.message === 'string');
      assert.doesNotMatch(providerInput.message, /executionContract|executionCapsule|"role"|"permissions"|"nonGoals"/);
    }
    assert.ok(seenProviders[0] && typeof seenProviders[0] === 'object' && 'modelVisiblePrompt' in seenProviders[0]);
    const visiblePrompt = seenProviders[0].modelVisiblePrompt;
    assert.ok(visiblePrompt && typeof visiblePrompt === 'object' && 'currentWork' in visiblePrompt);
    assert.ok(visiblePrompt.currentWork && typeof visiblePrompt.currentWork === 'object' && 'allowedPaths' in visiblePrompt.currentWork);
    assert.deepEqual(visiblePrompt.currentWork.allowedPaths, ['src/auth/**']);
    assert.ok(seenProviders[1] && typeof seenProviders[1] === 'object' && 'message' in seenProviders[1]);
    assert.ok(typeof seenProviders[1].message === 'string');
    assert.match(seenProviders[1].message, /independent Kernel review/);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K1: the Host receives a reviewer capsule for a review turn and an implementer capsule otherwise', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({ runId: 'r-hostcap', objective: 'auth boundary', taskContract: { surfaces: ['security_boundary'], acceptance: ['works'] } });
    const capabilities = { surface: 'claude', supportsSubagentModel: true, supportsIndependentContext: true, supportsResolvedModelIdentity: true };

    const implementTurn = await prepareTestHostTurn(cp, 'r-hostcap', { hostCapabilities: capabilities, actionContext: { actionKind: 'implement' } });
    assert.ok(implementTurn && typeof implementTurn === 'object' && 'executionCapsule' in implementTurn);
    assert.ok(implementTurn.executionCapsule && typeof implementTurn.executionCapsule === 'object' && 'role' in implementTurn.executionCapsule);
    assert.equal(implementTurn.executionCapsule.role, 'implementer');
    assert.ok(implementTurn && typeof implementTurn === 'object' && 'modelInput' in implementTurn);
    assert.ok(implementTurn && typeof implementTurn === 'object' && 'executionCapsule' in implementTurn);
    assert.ok(implementTurn.modelInput && typeof implementTurn.modelInput === 'object' && 'action' in implementTurn.modelInput);
    assert.ok(implementTurn.executionCapsule && typeof implementTurn.executionCapsule === 'object' && 'capsuleId' in implementTurn.executionCapsule);
    assert.ok(implementTurn.executionCapsule !== null && implementTurn.executionCapsule !== undefined);
    assert.ok(implementTurn.modelInput.action && typeof implementTurn.modelInput.action === 'object');
    assert.ok(implementTurn.modelInput.action && typeof implementTurn.modelInput.action === 'object' && 'capsuleId' in implementTurn.modelInput.action);
    assert.equal(implementTurn.modelInput.action.capsuleId, implementTurn.executionCapsule.capsuleId);

    const reviewTurn = await prepareTestHostTurn(cp, 'r-hostcap', { hostCapabilities: capabilities, actionContext: { actionKind: 'review_engineering', obligationId: 'security-review' } });
    assert.ok(reviewTurn && typeof reviewTurn === 'object' && 'executionCapsule' in reviewTurn);
    assert.ok(reviewTurn.executionCapsule && typeof reviewTurn.executionCapsule === 'object' && 'role' in reviewTurn.executionCapsule);
    assert.equal(reviewTurn.executionCapsule.role, 'reviewer');
    assert.ok(reviewTurn && typeof reviewTurn === 'object' && 'executionCapsule' in reviewTurn);
    assert.ok(reviewTurn.executionCapsule && typeof reviewTurn.executionCapsule === 'object' && 'permissions' in reviewTurn.executionCapsule);
    assert.ok(reviewTurn.executionCapsule.permissions && typeof reviewTurn.executionCapsule.permissions === 'object');
    assert.ok(reviewTurn.executionCapsule.permissions && typeof reviewTurn.executionCapsule.permissions === 'object' && 'filesystem' in reviewTurn.executionCapsule.permissions);
    assert.equal(reviewTurn.executionCapsule.permissions.filesystem, 'read_only');
    assert.ok(reviewTurn && typeof reviewTurn === 'object' && 'hostDirective' in reviewTurn);
    assert.ok(reviewTurn && typeof reviewTurn === 'object' && 'executionCapsule' in reviewTurn);
    assert.ok(reviewTurn.hostDirective && typeof reviewTurn.hostDirective === 'object' && 'executionCapsule' in reviewTurn.hostDirective);
    assert.ok(reviewTurn.executionCapsule && typeof reviewTurn.executionCapsule === 'object' && 'capsuleId' in reviewTurn.executionCapsule);
    assert.ok(reviewTurn.executionCapsule !== null && reviewTurn.executionCapsule !== undefined);
    assert.ok(reviewTurn.hostDirective.executionCapsule && typeof reviewTurn.hostDirective.executionCapsule === 'object');
    assert.ok(reviewTurn.hostDirective.executionCapsule && typeof reviewTurn.hostDirective.executionCapsule === 'object' && 'capsuleId' in reviewTurn.hostDirective.executionCapsule);
    assert.equal(reviewTurn.hostDirective.executionCapsule.capsuleId, reviewTurn.executionCapsule.capsuleId);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

type KernelControlPlane = Awaited<ReturnType<typeof createKernelControlPlane>>;
