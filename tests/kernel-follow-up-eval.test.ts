import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  aggregateFollowUpDryRun,
  assessBlindIsolation,
  auditHiddenExposure,
  buildF1ActorPackage,
  digestFollowUpValue,
  evaluateAttemptStop,
  freezeFollowUpStage,
  revealFollowUp,
  type FollowUpAttempt,
  type FollowUpBinding,
  type FollowUpProtocol,
  type FollowUpStrategy,
} from '../src/host-tooling/kernel-eval/follow-up-eval.js';

const protocol: FollowUpProtocol = JSON.parse(
  await readFile(
    new URL('./fixtures/kernel-follow-up-eval/protocol.json', import.meta.url),
    'utf8',
  ),
);

const binding: FollowUpBinding = {
  taskId: 'follow-up-case-001',
  sourceRevision: 'source-revision-001',
  f1SnapshotRevision: protocol.f1Snapshot.revision,
};

const isolation = {
  mode: 'enforced' as const,
  mechanism: 'external-filesystem-allowlist',
  actorWorkspaceRoot: '/isolated/actor/case-001',
  evaluatorHiddenRoot: '/isolated/evaluator/case-001',
  actorVisibleRoots: ['/isolated/actor/case-001'],
};

test('C27 protocol fixes identical F1 strategy conditions, cost units, and fail-closed stop rules', () => {
  assert.equal(protocol.schemaVersion, 1);
  assert.equal(protocol.protocolRevision, 'kernel-follow-up-eval.v1');
  assert.deepEqual(protocol.strategies, ['verify-only', 'always', 'adaptive']);
  assert.deepEqual(protocol.stageOrder, ['F1', 'F2', 'F3']);
  assert.deepEqual(
    protocol.executionConditions.requireEqual,
    ['surface', 'model', 'profile', 'effort', 'tools'],
  );
  assert.equal(protocol.isolation.requiredMode, 'enforced');
  assert.equal(protocol.isolation.sameWorkspaceHiddenFilesAllowed, false);
  assert.equal(protocol.attemptBudget.maxAttemptsPerStage, 2);
  assert.equal(protocol.attemptBudget.includeFailedAndIncomplete, true);
  assert.equal(protocol.costContract.aggregateScoreAllowed, false);
  assert.ok(protocol.costContract.units.includes('wallTimeMs'));
  assert.ok(protocol.costContract.units.includes('actualInputTokens'));
  assert.ok(protocol.costContract.units.includes('changedFiles'));
  assert.ok(protocol.costContract.units.includes('changedLines'));
  assert.ok(protocol.costContract.units.includes('reworkCount'));
  assert.ok(protocol.costContract.units.includes('verificationTimeMs'));
  assert.ok(protocol.costContract.units.includes('humanInterventionCount'));
  assert.ok(protocol.costContract.units.includes('failureCount'));
  assert.ok(protocol.costContract.units.includes('incompleteCount'));
  assert.match(protocol.costContract.unavailableUsageRule, /not estimated/i);
  assert.equal(protocol.stopConditions.criticalAuthorityViolation, 'halt');
  assert.equal(protocol.stopConditions.scopeViolation, 'halt');
  assert.equal(protocol.stopConditions.taskBindingMismatch, 'halt');
  assert.equal(protocol.stopConditions.sourceRevisionMismatch, 'halt');
  assert.equal(protocol.stopConditions.isolationFailure, 'not_ready');
});

test('C27 blind readiness rejects same-workspace hiding and non-enforced filesystem boundaries', () => {
  assert.equal(assessBlindIsolation({ evidence: isolation }).status, 'ready');

  const sameWorkspace = assessBlindIsolation({
    evidence: {
      ...isolation,
      evaluatorHiddenRoot: '/isolated/actor/case-001/.hidden/follow-ups',
    },
  });
  assert.equal(sameWorkspace.status, 'not_ready');
  assert.ok(sameWorkspace.reasons.includes('hidden-root-visible-to-actor'));
  assert.ok(sameWorkspace.reasons.includes('same-workspace-hidden-files'));

  const advisory = assessBlindIsolation({
    evidence: {
      ...isolation,
      mode: 'advisory',
    },
  });
  assert.equal(advisory.status, 'not_ready');
  assert.ok(advisory.reasons.includes('filesystem-isolation-not-enforced'));

  const broadVisibleRoot = assessBlindIsolation({
    evidence: {
      ...isolation,
      actorVisibleRoots: ['/isolated'],
    },
  });
  assert.equal(broadVisibleRoot.status, 'not_ready');
  assert.ok(broadVisibleRoot.reasons.includes('hidden-root-visible-to-actor'));
});

test('C27 all strategies receive the same F1 snapshot without hidden content, digest, or evaluator path', () => {
  const hiddenF2 = {
    marker: 'HIDDEN-F2-DO-NOT-EXPOSE',
    request: 'Add a follow-up edge case after F1 is frozen.',
  };
  const hiddenF3 = {
    marker: 'HIDDEN-F3-DO-NOT-EXPOSE',
    request: 'Change a second behavior only after F2 is frozen.',
  };
  const hiddenNeedles = [
    hiddenF2.marker,
    hiddenF3.marker,
    digestFollowUpValue(hiddenF2),
    digestFollowUpValue(hiddenF3),
    isolation.evaluatorHiddenRoot,
  ];

  const packages = protocol.strategies.map((strategy) => (
    buildF1ActorPackage({
      protocol,
      strategy,
      binding,
      isolationEvidence: isolation,
    })
  ));

  assert.ok(packages.every((entry) => entry.status === 'ready'));
  const actorPackages = packages.map((entry) => {
    assert.ok(entry.actorPackage);
    return entry.actorPackage;
  });
  const snapshotDigests = new Set(
    actorPackages.map((entry) => entry.f1SnapshotDigest),
  );
  assert.equal(snapshotDigests.size, 1);
  assert.ok(actorPackages.every((entry) => (
    entry.binding.taskId === binding.taskId
    && entry.binding.sourceRevision === binding.sourceRevision
    && entry.binding.f1SnapshotRevision === binding.f1SnapshotRevision
  )));

  for (const actorPackage of actorPackages) {
    const audit = auditHiddenExposure({
      hiddenNeedles,
      surfaces: {
        actorPackage,
        prompt: {
          objective: actorPackage.f1Snapshot.task.objective,
          acceptance: actorPackage.f1Snapshot.task.acceptance,
        },
        knowledge: [],
        fileSearch: Object.keys(actorPackage.f1Snapshot.workspaceSeed),
        logs: ['F1 actor package prepared', actorPackage.f1SnapshotDigest],
      },
    });
    assert.equal(audit.status, 'passed');
    assert.deepEqual(audit.findings, []);
  }

  const leaked = auditHiddenExposure({
    hiddenNeedles,
    surfaces: {
      actorPackage: actorPackages[0],
      prompt: {},
      knowledge: [],
      fileSearch: [],
      logs: [hiddenF2.marker],
    },
  });
  assert.equal(leaked.status, 'failed');
  assert.deepEqual(
    leaked.findings,
    [{ surface: 'logs', needle: hiddenF2.marker }],
  );
});

test('C27 follow-ups reveal in F1 then F2 freeze order and bind task plus source revision', () => {
  const f1Freeze = freezeFollowUpStage({
    binding,
    stage: 'F1',
    snapshotRevision: protocol.f1Snapshot.revision,
    snapshot: protocol.f1Snapshot,
  });

  const f2Hidden = { marker: 'hidden-f2', request: 'follow-up-two' };
  const f2 = revealFollowUp({
    stage: 'F2',
    hiddenInput: f2Hidden,
    binding,
    priorFreeze: f1Freeze,
  });
  assert.equal(f2.status, 'revealed');
  assert.deepEqual(f2.reveal?.input, f2Hidden);

  const f2Freeze = freezeFollowUpStage({
    binding,
    stage: 'F2',
    snapshotRevision: 'follow-up-f2.v1',
    snapshot: {
      prior: f1Freeze.snapshotDigest,
      revealed: f2Hidden,
      result: 'f2-result',
    },
  });
  const f3 = revealFollowUp({
    stage: 'F3',
    hiddenInput: { marker: 'hidden-f3', request: 'follow-up-three' },
    binding,
    priorFreeze: f2Freeze,
  });
  assert.equal(f3.status, 'revealed');

  const earlyF3 = revealFollowUp({
    stage: 'F3',
    hiddenInput: { marker: 'too-early' },
    binding,
    priorFreeze: f1Freeze,
  });
  assert.equal(earlyF3.status, 'blocked');
  assert.ok(earlyF3.reasons.includes('reveal-order-invalid'));

  const wrongTask = revealFollowUp({
    stage: 'F2',
    hiddenInput: f2Hidden,
    binding: { ...binding, taskId: 'different-task' },
    priorFreeze: f1Freeze,
  });
  assert.equal(wrongTask.status, 'blocked');
  assert.ok(wrongTask.reasons.includes('task-binding-mismatch'));

  const wrongRevision = revealFollowUp({
    stage: 'F2',
    hiddenInput: f2Hidden,
    binding: { ...binding, sourceRevision: 'different-revision' },
    priorFreeze: f1Freeze,
  });
  assert.equal(wrongRevision.status, 'blocked');
  assert.ok(wrongRevision.reasons.includes('source-revision-mismatch'));
});

const attempt = (
  overrides: Partial<FollowUpAttempt> = {},
): FollowUpAttempt => ({
  caseId: 'FOLLOW-UP-001',
  strategy: 'verify-only',
  stage: 'F1',
  taskId: binding.taskId,
  sourceRevision: binding.sourceRevision,
  attempt: 1,
  status: 'completed',
  correctness: true,
  acceptanceSatisfied: true,
  scopeViolationCount: 0,
  criticalAuthorityViolationCount: 0,
  wallTimeMs: 100,
  inputTokens: 10,
  outputTokens: 5,
  reasoningTokens: 4,
  cachedTokens: 2,
  changedFiles: 1,
  changedLines: 3,
  reworkCount: 0,
  verificationTimeMs: 20,
  humanInterventionCount: 0,
  ...overrides,
});

test('C27 stop rules halt on authority, scope, identity, revision, or attempt budget violations', () => {
  assert.equal(evaluateAttemptStop({
    protocol,
    attempt: attempt(),
    expectedBinding: binding,
  }).decision, 'continue');

  const cases: Array<[Partial<FollowUpAttempt>, string]> = [
    [{ criticalAuthorityViolationCount: 1 }, 'critical-authority-violation'],
    [{ scopeViolationCount: 1 }, 'scope-violation'],
    [{ taskId: 'wrong-task' }, 'task-binding-mismatch'],
    [{ sourceRevision: 'wrong-revision' }, 'source-revision-mismatch'],
    [{ attempt: 3 }, 'attempt-budget-exceeded'],
  ];
  for (const [overrides, reason] of cases) {
    const stopped = evaluateAttemptStop({
      protocol,
      attempt: attempt(overrides),
      expectedBinding: binding,
    });
    assert.equal(stopped.decision, 'halt');
    assert.ok(stopped.reasons.includes(reason));
  }
});

test('C27 dry-run aggregation keeps failures and incomplete attempts and never invents a combined cost score', () => {
  const attempts: FollowUpAttempt[] = [
    attempt({ strategy: 'verify-only', stage: 'F1' }),
    attempt({
      strategy: 'verify-only',
      stage: 'F2',
      status: 'failed',
      correctness: false,
      acceptanceSatisfied: false,
      wallTimeMs: 70,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cachedTokens: null,
      reworkCount: 1,
      humanInterventionCount: 1,
    }),
    attempt({
      strategy: 'verify-only',
      stage: 'F3',
      status: 'incomplete',
      correctness: null,
      acceptanceSatisfied: null,
      wallTimeMs: 50,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cachedTokens: null,
    }),
    ...(['always', 'adaptive'] as FollowUpStrategy[]).flatMap((strategy) => [
      attempt({ strategy, stage: 'F1' }),
      attempt({ strategy, stage: 'F2' }),
      attempt({ strategy, stage: 'F3' }),
    ]),
  ];

  const report = aggregateFollowUpDryRun({ protocol, attempts });
  assert.equal(report.aggregateScore, null);
  assert.equal(report.aggregateScoreAllowed, false);
  assert.equal(report.attemptCount, 9);
  assert.equal(report.results.length, 3);

  const verifyOnly = report.results.find(
    (entry) => entry.strategy === 'verify-only',
  );
  assert.ok(verifyOnly);
  assert.equal(verifyOnly.attemptCount, 3);
  assert.equal(verifyOnly.failedCount, 1);
  assert.equal(verifyOnly.incompleteCount, 1);
  assert.equal(verifyOnly.allAttemptsIncluded, true);
  assert.equal(verifyOnly.correctnessPass, false);
  assert.equal(verifyOnly.costs.wallTimeMs, 220);
  assert.equal(verifyOnly.costs.failureCount, 1);
  assert.equal(verifyOnly.costs.incompleteCount, 1);
  assert.equal(verifyOnly.costs.inputTokens.status, 'unavailable');
  assert.equal(verifyOnly.costs.inputTokens.value, null);

  for (const strategy of ['always', 'adaptive'] as FollowUpStrategy[]) {
    const result = report.results.find((entry) => entry.strategy === strategy);
    assert.ok(result);
    assert.equal(result.correctnessPass, true);
    assert.equal(result.failedCount, 0);
    assert.equal(result.incompleteCount, 0);
    assert.equal(result.costs.inputTokens.status, 'available');
  }
});
