import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_OPTIONAL_CAPABILITIES,
  OPTIONAL_CAPABILITY_IDS,
  resolveOptionalCapabilities,
} from '../scripts/kernel/run/optional-capabilities.mjs';
import { buildWorkAuthorityView } from '../scripts/kernel/run/work-authority.mjs';
import { buildTrustAuthorityView, validateTrustAuthority } from '../scripts/kernel/proof/trust-authority.mjs';
import { buildKnowledgeAuthorityView, validateKnowledgeAuthority } from '../scripts/kernel/knowledge/knowledge-authority.mjs';
import { buildCoordinatorSurface, COORDINATOR_COMMANDS } from '../scripts/kernel/bridge/coordinator-surface.mjs';
import { buildModelVisiblePromptView, MODEL_VISIBLE_PROMPT_FIELDS } from '../scripts/host/kernel/model-capsule-view.mjs';
import {
  buildKernelDurableStateView,
  validateKernelDurableState,
  DERIVED_OR_HOST_OWNED_STATE,
} from '../scripts/kernel/persistence/durable-state.mjs';

const root = path.resolve('.');
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

// B0 freezes the behavior that the decomplexification waves are not allowed
// to remove. The implementation remains in the existing focused tests; this
// matrix makes the preservation boundary executable and discoverable.
const scenarios = Object.freeze([
  { id: 'simple-bugfix', files: ['tests/kernel-codex-model-policy.test.mjs'], title: /ordinary implementation and debugging/ },
  { id: 'normal-implementation', files: ['tests/kernel-codex-model-policy.test.mjs'], title: /ordinary implementation and debugging/ },
  { id: 'complex-implementation', files: ['tests/kernel-codex-model-policy.test.mjs'], title: /complex implementation and large refactors/ },
  { id: 'planning', files: ['tests/kernel-codex-model-policy.test.mjs'], title: /planning actions/ },
  { id: 'resume', files: ['tests/kernel-resume-lease.test.mjs'], title: /deterministic resume/ },
  { id: 'verification-failure', files: ['tests/kernel-completion-gate-recovery.test.mjs'], title: /uncovered acceptance/ },
  { id: 'high-risk-review', files: ['tests/kernel-independent-review-session.test.mjs'], title: /T3 review/ },
  { id: 'knowledge-retrieval-and-commit', files: ['tests/kernel-knowledge-lifecycle-e2e.test.mjs'], title: /Full Kernel Project Knowledge Lifecycle/ },
  { id: 'knowledge-supersession', files: ['tests/kernel-knowledge-supersession.test.mjs'], title: /supersed/ },
  { id: 'parallel-session', files: ['tests/kernel-parallel-runtime.test.mjs', 'tests/kernel-cross-surface-e2e.test.mjs'], title: /Host dispatcher|concurrent|independent concurrent/ },
  { id: 'git-closeout', files: ['tests/kernel-git-closeout-e2e.test.mjs'], title: /Git Closeout/ },
]);

const testScripts = Object.values(packageJson.scripts || {}).filter((command) => /node(?:\.exe)?\s+--test/.test(command));

test('B0 characterization matrix covers every required preservation scenario', () => {
  assert.equal(scenarios.length, 11);
  for (const scenario of scenarios) {
    assert.ok(scenario.files.length > 0, `${scenario.id} needs a focused test file`);
    for (const relativeFile of scenario.files) {
      const absoluteFile = path.join(root, relativeFile);
      assert.ok(relativeFile.startsWith('tests/'), `${scenario.id} must stay in tests/: ${relativeFile}`);
      assert.ok(path.isAbsolute(absoluteFile) && readFileSync(absoluteFile, 'utf8').length > 0, `${scenario.id} test is missing: ${relativeFile}`);
      assert.ok(testScripts.some((command) => command.includes(relativeFile)), `${relativeFile} is not connected to a package test command`);
      const body = readFileSync(absoluteFile, 'utf8');
      assert.match(body, scenario.title, `${scenario.id} has no matching characterization test in ${relativeFile}`);
    }
  }
});

test('B0 focused characterization suite passes as a fresh child process', () => {
  const files = [...new Set(scenarios.flatMap((scenario) => scenario.files))];
  const result = spawnSync(process.execPath, ['--test', ...files], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  assert.equal(result.error, undefined, output.slice(-12_000));
  assert.equal(result.status, 0, output.slice(-12_000));
});

test('B1 execution-class contract passes as a fresh child process', () => {
  const result = spawnSync(process.execPath, ['--test', 'tests/kernel-model-policy.test.mjs', 'tests/kernel-model-route-contract.test.mjs'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  assert.equal(result.error, undefined, output.slice(-12_000));
  assert.equal(result.status, 0, output.slice(-12_000));
});

test('B0 keeps the characterization artifact outside runtime state and records the current baseline', () => {
  const artifact = path.join(root, 'docs', 'decomplexification', 'B0-CHARACTERIZATION.md');
  const body = readFileSync(artifact, 'utf8');
  assert.match(body, /Wave B0/);
  assert.match(body, /0d12bbd75d989f814632ee8414e25ab5bb100566/);
  assert.match(body, /runtime state.*not modified/i);
  assert.match(body, /simple-bugfix/);
  assert.match(body, /knowledge-supersession/);
});

test('B5 keeps optional capabilities disabled for ordinary work and activates only by condition', () => {
  assert.deepEqual(Object.keys(DEFAULT_OPTIONAL_CAPABILITIES), [...OPTIONAL_CAPABILITY_IDS]);
  const ordinary = resolveOptionalCapabilities({
    actionKind: 'implement',
    attempts: [{ status: 'started' }],
    taskContract: { taskClass: 'feature', flags: {} },
  });
  assert.deepEqual(ordinary.active, DEFAULT_OPTIONAL_CAPABILITIES);

  const review = resolveOptionalCapabilities({ actionKind: 'review_engineering' });
  assert.equal(review.active['independent-review'], true);
  assert.equal(review.active['stagnation-escalation'], false);

  const stuck = resolveOptionalCapabilities({
    actionKind: 'implement',
    attempts: [{ status: 'failed' }, { status: 'failed' }, { status: 'failed' }],
  });
  assert.equal(stuck.active['stagnation-escalation'], true);
});

test('B5 keeps optional implementation modules out of the default static import graph', () => {
  const controlPlane = readFileSync(path.join(root, 'scripts/kernel/control-plane.mjs'), 'utf8');
  const closeout = readFileSync(path.join(root, 'scripts/kernel/git/closeout.mjs'), 'utf8');
  const unificationAudit = readFileSync(path.join(root, 'scripts/kernel/unification-audit.mjs'), 'utf8');
  assert.doesNotMatch(controlPlane, /from ['"]\.\/run\/stagnation\.mjs['"]/u);
  assert.doesNotMatch(controlPlane, /from ['"]\.\/proof\/review-pipeline\.mjs['"]/u);
  assert.doesNotMatch(closeout, /from ['"]\.\/remote-parity\.mjs['"]/u);
  assert.doesNotMatch(unificationAudit, /from ['"]\.\/optimization-cycle\.mjs['"]/u);
  assert.match(controlPlane, /await import\('\.\/proof\/review-pipeline\.mjs'\)/u);
  assert.match(closeout, /await import\('\.\/remote-parity\.mjs'\)/u);
});

test('B6 derives Task, Run, Work Unit, progress, execution class, and resume from one provider-free authority view', () => {
  const view = buildWorkAuthorityView({
    run: {
      runId: 'b6-run',
      projectId: 'b6-project',
      objective: 'consolidate work authority',
      status: 'active',
      state: 'EXECUTE',
      planRevision: 2,
      mutationRevision: 4,
      contractRevision: 3,
      taskContract: { taskClass: 'feature' },
      acceptanceCriteria: ['AC-1'],
    },
    steps: [
      { stepId: 'step-1', sequence: 1, planRevision: 2, objective: 'done', state: 'passed', acceptanceIds: ['AC-1'], obligationIds: ['proof'], allowedPaths: ['src/**'], forbiddenPaths: [] },
      { stepId: 'step-2', sequence: 2, planRevision: 2, objective: 'current', state: 'ready', acceptanceIds: [], obligationIds: [], allowedPaths: ['tests/**'], forbiddenPaths: [] },
    ],
    routeDecision: { executionClass: 'complex_implementation' },
  });
  assert.equal(view.task.runId, 'b6-run');
  assert.equal(view.currentWorkUnit.stepId, 'step-2');
  assert.deepEqual(view.progress.completedWorkUnitIds, ['step-1']);
  assert.deepEqual(view.progress.remainingWorkUnitIds, ['step-2']);
  assert.equal(view.executionClass, 'complex_implementation');
  assert.equal(view.resume.stepId, 'step-2');
  assert.equal(Object.hasOwn(view, 'provider'), false);
  assert.equal(Object.hasOwn(view, 'optimizationState'), false);
});

test('B7 derives Requirements, Evidence, and Decision with a fresh-evidence guard', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const base = {
    run: {
      runId: 'b7-run',
      objective: 'consolidate trust authority',
      proofTier: 'T3',
      mutationRevision: 2,
      contractRevision: 1,
      sourceIdentity: 'source-1',
      currentWorkspaceIdentity: 'workspace-2',
      status: 'active',
      finalizationStatus: 'pending',
      requiredObligations: ['unit-test', 'security-review'],
    },
    obligations: [
      { obligationId: 'unit-test', status: 'required', evidenceClass: 'hard', acceptanceIds: ['AC-1'], allowedCommandRefs: ['test'] },
      { obligationId: 'security-review', status: 'required', evidenceClass: 'judgment', protected: true, acceptanceIds: ['AC-7'], allowedCommandRefs: [] },
    ],
    completion: {
      decision: 'accepted',
      gates: {
        isClosed: true,
        staticPassed: true,
        dynamicPassed: true,
        evidencePlansComplete: true,
        acceptanceCovered: true,
        releaseEvidencePresent: true,
        hardEvidenceSatisfied: true,
        lifecycleOutcomesSatisfied: true,
      },
    },
    completionDecision: { decision: 'accepted', evidenceDigest: digest },
  };
  const stale = buildTrustAuthorityView({
    ...base,
    verifications: [{
      obligationId: 'unit-test',
      status: 'passed',
      evidenceClass: 'hard',
      evidenceDigest: digest,
      evidenceRef: 'kernel://test',
      command: 'npm test',
      commandRef: 'test',
      exitCode: 0,
      sourceIdentity: 'source-1',
      verifiedMutationRevision: 1,
      executor: 'kernel-runtime',
      contractRevision: 1,
      acceptanceCoverage: ['AC-1'],
    }],
  });
  assert.equal(stale.evidence.hard[0].freshness.status, 'stale');
  assert.equal(stale.requirements.find((entry) => entry.obligationId === 'unit-test').satisfied, false);
  assert.equal(stale.requirements.find((entry) => entry.obligationId === 'security-review').reviewRequired, true);
  assert.equal(stale.decision.accepted, false, 'persisted acceptance cannot override stale or missing evidence');
  assert.match(stale.decision.reasons.join(','), /mutation-revision-stale/);
  assert.match(stale.decision.reasons.join(','), /requirement-unsatisfied:security-review/);

  const fresh = buildTrustAuthorityView({
    ...base,
    verifications: [{
      obligationId: 'unit-test',
      status: 'passed',
      evidenceClass: 'hard',
      evidenceDigest: digest,
      evidenceRef: 'kernel://test',
      command: 'npm test',
      commandRef: 'test',
      exitCode: 0,
      sourceIdentity: 'source-1',
      verifiedMutationRevision: 2,
      executor: 'kernel-runtime',
      contractRevision: 1,
      acceptanceCoverage: ['AC-1'],
    }],
  });
  assert.equal(fresh.evidence.hard[0].freshness.status, 'fresh');
  assert.equal(fresh.requirements.find((entry) => entry.obligationId === 'unit-test').satisfied, true);
  assert.equal(fresh.requirements.find((entry) => entry.obligationId === 'security-review').satisfied, false);
  assert.equal(Object.hasOwn(fresh, 'provider'), false);
  assert.doesNotMatch(JSON.stringify(fresh), /resolvedModel|modelClass|sessionId|usageReceiptId/u);
});

test('B7 rejects provider and session state from the Trust Authority graph', () => {
  const view = buildTrustAuthorityView({
    run: { runId: 'b7-provider-free', mutationRevision: 0, sourceIdentity: 'source-1' },
    obligations: [],
    completion: { decision: 'blocked', gates: {} },
  });
  assert.throws(() => validateTrustAuthority({
    ...view,
    evidence: { ...view.evidence, hard: [{ provider: 'codex' }] },
  }), /trust_authority_forbidden_field: \$\.evidence\.hard\[0\]\.provider/);
});

test('B8 derives the full Knowledge lifecycle from SQLite-shaped authority inputs', () => {
  const view = buildKnowledgeAuthorityView({
    projectId: 'b8-project',
    run: {
      runId: 'b8-run',
      projectId: 'b8-project',
      state: 'EXECUTE',
      knowledgeRevisionStart: '3',
      knowledgeStatus: 'committed',
    },
    knowledgeRevision: 4,
    context: {
      stage: 'EXECUTE',
      status: 'ready-populated',
      knowledgeRevision: '4',
      digest: `sha256:${'b'.repeat(64)}`,
      quality: {
        usableRecordCount: 3,
        selectedCounts: { facts: 2, architecture: 1 },
        omittedCounts: { total: 1 },
      },
      selectionMeta: { contractRevision: 1 },
    },
    candidates: [
      { candidateId: 'candidate-1', proposedType: 'semantic_fact', status: 'verified' },
      { candidateId: 'candidate-2', proposedType: 'semantic_fact', status: 'rejected' },
    ],
    reviewReceipt: {
      status: 'passed',
      candidateCount: 2,
      verifiedCount: 1,
      rejectedCount: 1,
      reviewDigest: `sha256:${'c'.repeat(64)}`,
    },
    commitReceipt: {
      status: 'committed',
      revisionBefore: '3',
      revisionAfter: '4',
      receiptJson: { committedCount: 1, supersededCount: 1 },
    },
    records: [
      { id: 'record-1', type: 'semantic_fact', status: 'committed' },
      { id: 'record-0', type: 'semantic_fact', status: 'superseded' },
    ],
    imports: [{ importId: 'import-1', status: 'committed' }],
  });
  assert.equal(view.authority.source, 'sqlite');
  assert.equal(view.authority.durable, true);
  assert.equal(view.authority.lifecycleStatus, 'committed');
  assert.equal(view.lifecycle.retrieve.status, 'retrieved');
  assert.equal(view.lifecycle.select.status, 'selected');
  assert.equal(view.lifecycle.use.status, 'available');
  assert.equal(view.lifecycle.capture.status, 'captured');
  assert.equal(view.lifecycle.normalize.status, 'normalized');
  assert.equal(view.lifecycle.verify.status, 'passed');
  assert.equal(view.lifecycle.commit.status, 'committed');
  assert.equal(view.lifecycle.supersede.status, 'applied');
  assert.equal(view.projection.authoritative, false);
  assert.equal(view.projection.committedCount, 1);
  assert.equal(view.projection.supersededCount, 1);
  assert.doesNotMatch(JSON.stringify(view), /candidateJson|recordJson|provider|model|sessionId/u);
});

test('B8 keeps empty knowledge and projection state derived without inventing lifecycle facts', () => {
  const view = buildKnowledgeAuthorityView({
    projectId: 'b8-empty',
    run: { runId: 'b8-empty-run', projectId: 'b8-empty', state: 'FRAME', knowledgeRevisionStart: '1' },
  });
  assert.equal(view.authority.lifecycleStatus, 'empty');
  assert.equal(view.lifecycle.retrieve.status, 'missing');
  assert.equal(view.lifecycle.capture.status, 'empty');
  assert.equal(view.lifecycle.normalize.status, 'not-required');
  assert.equal(view.lifecycle.verify.status, 'no_candidates');
  assert.equal(view.lifecycle.commit.status, 'pending');
  assert.equal(view.projection.authoritative, false);
});

test('B8 rejects raw provider or candidate state from the Knowledge Authority graph', () => {
  const view = buildKnowledgeAuthorityView({
    projectId: 'b8-guard',
    run: { runId: 'b8-guard-run', projectId: 'b8-guard' },
  });
  assert.throws(() => validateKnowledgeAuthority({
    ...view,
    lifecycle: { ...view.lifecycle, capture: { ...view.lifecycle.capture, candidateJson: {} } },
  }), /knowledge_authority_forbidden_field: \$\.lifecycle\.capture\.candidateJson/);
});

test('B9 keeps the Control Plane coordinator surface to next/report', async () => {
  const calls = [];
  const surface = buildCoordinatorSurface({
    next: async () => { calls.push('next'); return { status: 'ready' }; },
    report: async () => { calls.push('report'); return { status: 'accepted' }; },
  });
  assert.deepEqual(surface.commands, [...COORDINATOR_COMMANDS]);
  assert.deepEqual(Object.keys(surface).sort(), ['commands', 'next', 'report', 'schemaVersion']);
  await surface.next('run-b9');
  await surface.report('run-b9', {});
  assert.deepEqual(calls, ['next', 'report']);
});

test('B9 keeps route policy in Host orchestration and keeps prompt vocabulary work-facing', () => {
  const controlPlane = readFileSync(path.join(root, 'scripts/kernel/control-plane.mjs'), 'utf8');
  const hostTurn = readFileSync(path.join(root, 'scripts/host/kernel/host-turn.mjs'), 'utf8');
  const hostRouting = readFileSync(path.join(root, 'scripts/host/kernel/host-routing.mjs'), 'utf8');
  assert.doesNotMatch(controlPlane, /createHostRoutingBridge|host-routing\.mjs/u);
  assert.doesNotMatch(controlPlane, /from ['"]\.\/run\/model-routing\.mjs['"]/u);
  assert.doesNotMatch(controlPlane, /\b(resolveModelRoute|recommendModelRouting)\s*\(/u);
  assert.match(hostTurn, /createHostRoutingBridge/u);
  assert.match(hostRouting, /from ['"]\.\.\/\.\.\/kernel\/run\/model-routing\.mjs['"]/u);

  const view = buildModelVisiblePromptView({
    modelInput: {
      objective: 'B9 prompt boundary',
      acceptance: ['AC-9'],
      constraints: ['preserve next/report'],
      knowledge: 'Only relevant facts',
      action: {
        type: 'implement',
        guidance: 'Make the bounded change',
        step: { objective: 'Coordinator seam', allowedPaths: ['scripts/kernel/**'] },
        obligations: [{ obligationId: 'test', evidenceClass: 'hard' }],
      },
      routeDecisionId: 'must-not-leak',
      provider: 'must-not-leak',
    },
  });
  assert.deepEqual(Object.keys(view), [...MODEL_VISIBLE_PROMPT_FIELDS]);
  assert.equal(view.currentWork.objective, 'Coordinator seam');
  assert.doesNotMatch(JSON.stringify(view), /provider|routeDecision|lease|cache|CAS|gitState|modelClass/iu);
});

test('B10 keeps one minimal SQLite durable authority and classifies internal state as derived or Host-owned', () => {
  const view = buildKernelDurableStateView({
    run: {
      runId: 'b10-run',
      projectId: 'b10-project',
      workspaceId: 'b10-workspace',
      worktreeId: 'b10-worktree',
      objective: 'reduce durable state',
      status: 'active',
      state: 'EXECUTE',
      planRevision: 2,
      mutationRevision: 4,
      contractRevision: 1,
      acceptanceCriteria: ['AC-4'],
      taskContract: { taskClass: 'feature', constraints: ['keep evidence'], nonGoals: ['provider routing'] },
      knowledgeRevisionStart: '3',
      knowledgeRevisionClose: null,
      knowledgeStatus: 'active',
      finalizationStatus: 'pending',
    },
    workAuthority: {
      cursor: { planRevision: 2, currentStepId: 'step-2' },
      currentWorkUnit: { stepId: 'step-2', objective: 'current' },
      progress: { completedWorkUnitIds: ['step-1'], remainingWorkUnitIds: ['step-2'] },
      resume: { stepId: 'step-2' },
      executionClass: 'complex_implementation',
    },
    obligations: [{ obligationId: 'unit-test', evidenceClass: 'hard', acceptanceIds: ['AC-4'] }],
    verifications: [{ obligationId: 'unit-test', status: 'passed', evidenceDigest: 'sha256:proof', verifiedMutationRevision: 4 }],
    completion: { decision: 'pending', overall: 'active' },
  });
  assert.equal(view.authority.source, 'sqlite');
  assert.equal(view.execution.executionClass, 'complex_implementation');
  assert.equal(view.evidence.verifications[0].evidenceDigest, 'sha256:proof');
  assert.deepEqual(view.knowledge, { revisionStart: '3', revisionClose: null, status: 'active' });
  assert.ok(DERIVED_OR_HOST_OWNED_STATE.includes('prompt-cache-state'));
  assert.doesNotMatch(JSON.stringify(view), /"(?:provider|model|prompt|cache|gitState|reviewer|stagnation|optimization)[^"]*"\s*:/iu);
  assert.equal(validateKernelDurableState(view), view);
});

test('B11 removes proven dead Kernel compatibility sources after authority migration', () => {
  for (const relative of ['scripts/kernel/cache-replay.mjs', 'scripts/kernel/run/stagnation.mjs']) {
    assert.equal(existsSync(path.join(root, relative)), false, `${relative} must be removed`);
  }
  assert.equal(existsSync(path.join(root, 'scripts/host/kernel/cache-replay.mjs')), true);
  assert.equal(existsSync(path.join(root, 'scripts/kernel/run/optional-capabilities.mjs')), true);
  assert.match(readFileSync(path.join(root, 'tests/kernel-cache-replay.test.mjs'), 'utf8'), /scripts\/host\/kernel\/cache-replay\.mjs/u);
  assert.match(readFileSync(path.join(root, 'tests/kernel-stagnation-routing.test.mjs'), 'utf8'), /optional-capabilities\.mjs/u);
});

test('B12 exposes only work-facing prompt fields and preserves the deterministic Codex route boundary', () => {
  const view = buildModelVisiblePromptView({
    modelInput: {
      objective: 'B12 prompt boundary',
      acceptance: [],
      constraints: [],
      knowledge: '',
      action: {
        type: 'implement',
        guidance: 'Complete the bounded work unit',
        step: {
          objective: 'Current bounded work',
          allowedPaths: ['tests/**'],
          forbiddenPaths: ['.moon-relay/**'],
          expectedOutputs: ['fresh evidence'],
        },
        obligations: [{ obligationId: 'unit-test', evidenceClass: 'hard', allowedCommandRefs: ['test'] }],
      },
      provider: 'must-not-leak',
      model: 'must-not-leak',
      modelClass: 'must-not-leak',
      routeScore: 99,
      cache: { key: 'must-not-leak' },
      lease: { token: 'must-not-leak' },
      cas: { digest: 'must-not-leak' },
      gitState: 'must-not-leak',
      stagnationAlgorithm: 'must-not-leak',
    },
    capsule: {
      objective: 'capsule objective',
      acceptance: ['AC-1'],
      constraints: ['stay bounded'],
      repositoryContext: { knowledgeRecords: ['verified fact'] },
      verification: { obligations: [{ obligationId: 'capsule-evidence' }] },
    },
  });
  assert.deepEqual(Object.keys(view), [...MODEL_VISIBLE_PROMPT_FIELDS]);
  assert.deepEqual(view.acceptance, ['AC-1']);
  assert.deepEqual(view.constraints, ['stay bounded']);
  assert.deepEqual(view.relevantProjectKnowledge, ['verified fact']);
  assert.equal(view.currentWork.objective, 'Current bounded work');
  assert.deepEqual(view.requiredEvidence, [{ obligationId: 'unit-test', evidenceClass: 'hard', allowedCommandRefs: ['test'] }]);
  assert.doesNotMatch(JSON.stringify(view), /provider|modelClass|routeScore|cache|lease|cas|gitState|stagnationAlgorithm/iu);
});
