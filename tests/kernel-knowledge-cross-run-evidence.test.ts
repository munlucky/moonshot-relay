import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCrossRunEvidenceGroups,
  buildStructuredRunSignals,
  extractStructuredKnowledgeCandidates,
} from '../src/kernel/knowledge/capture.js';

test('C23: same-run retries do not count as cross-run repetition', () => {
  const groups = buildCrossRunEvidenceGroups({
    projectId: 'project-a',
    currentRunId: 'run-a',
    signals: {
      runId: 'run-a',
      failures: [
        {
          correctionId: 'correction-auth',
          statement: 'Auth refresh fails after expiry.',
          scope: ['src/auth/refresh.ts'],
          evidenceRefs: ['failure://run-a/1'],
          count: 7,
        },
        {
          correctionId: 'correction-auth',
          statement: 'Auth refresh fails after expiry.',
          scope: ['src/auth/refresh.ts'],
          evidenceRefs: ['failure://run-a/2'],
        },
      ],
    },
  });

  assert.deepEqual(groups, []);
});

test('C23: independent runs reproduce supporting failure evidence without duplicate run counts', () => {
  const groups = buildCrossRunEvidenceGroups({
    projectId: 'project-a',
    currentRunId: 'run-b',
    priorRunSignals: [{
      runId: 'run-a',
      failures: [
        {
          correctionId: 'correction-auth',
          statement: 'Auth refresh fails after expiry.',
          scope: ['src/auth/refresh.ts'],
          evidenceRefs: ['failure://run-a/1'],
        },
        {
          correctionId: 'correction-auth',
          statement: 'Auth refresh fails after expiry.',
          scope: ['src/auth/refresh.ts'],
          evidenceRefs: ['failure://run-a/retry'],
        },
      ],
    }],
    signals: {
      runId: 'run-b',
      failures: [{
        correctionId: 'correction-auth',
        statement: 'Auth refresh fails after expiry.',
        scope: ['src/auth/refresh.ts'],
        evidenceRefs: ['failure://run-b/1'],
      }],
    },
  });

  assert.equal(groups.length, 1);
  const group = groups[0];
  assert.ok(group);
  assert.equal(group.runCount, 2);
  assert.equal(group.status, 'repeated_failure');
  assert.deepEqual(group.failureRunIds, ['run-a', 'run-b']);
  assert.deepEqual(group.successRunIds, []);
  assert.deepEqual(
    group.supportingRuns.map((entry) => entry.runId),
    ['run-a', 'run-b'],
  );
  assert.deepEqual(group.evidenceRefs, [
    'failure://run-a/1',
    'failure://run-a/retry',
    'failure://run-b/1',
  ]);
});

test('C23: linked successful resolution stays in the same correction group', () => {
  const groups = buildCrossRunEvidenceGroups({
    projectId: 'project-a',
    currentRunId: 'run-b',
    priorRunSignals: [{
      runId: 'run-a',
      failures: [{
        correctionId: 'correction-auth',
        statement: 'Auth refresh fails after expiry.',
        scope: ['src/auth/refresh.ts'],
        evidenceRefs: ['failure://run-a/auth'],
      }],
    }],
    signals: {
      runId: 'run-b',
      regressionVerifications: [{
        correctionId: 'correction-auth',
        status: 'passed',
        exitCode: 0,
        statement: 'Auth refresh regression now passes.',
        scope: ['src/auth/refresh.ts'],
        evidenceRefs: ['receipt://run-b/auth-regression'],
      }],
    },
  });

  assert.equal(groups.length, 1);
  const group = groups[0];
  assert.ok(group);
  assert.equal(group.status, 'repeated_with_resolution');
  assert.deepEqual(group.failureRunIds, ['run-a']);
  assert.deepEqual(group.successRunIds, ['run-b']);
  assert.deepEqual(group.evidenceRefs, [
    'failure://run-a/auth',
    'receipt://run-b/auth-regression',
  ]);
});

test('C23: stale and contradictory evidence remains visible instead of being promoted away', () => {
  const groups = buildCrossRunEvidenceGroups({
    projectId: 'project-a',
    currentRunId: 'run-b',
    priorRunSignals: [{
      runId: 'run-a',
      failures: [{
        correctionId: 'correction-auth',
        statement: 'Auth refresh fails after expiry.',
        scope: ['src/auth/refresh.ts'],
        evidenceRefs: ['failure://run-a/auth'],
        freshnessStatus: 'stale',
      }],
    }],
    signals: {
      runId: 'run-b',
      failures: [{
        correctionId: 'correction-auth',
        statement: 'Auth refresh fails after expiry.',
        scope: ['src/auth/refresh.ts'],
        evidenceRefs: ['failure://run-b/auth'],
        contradiction: true,
      }],
    },
  });

  assert.equal(groups.length, 1);
  const group = groups[0];
  assert.ok(group);
  assert.deepEqual(group.staleEvidenceRefs, ['failure://run-a/auth']);
  assert.deepEqual(
    group.contradictionEvidenceRefs,
    ['failure://run-b/auth'],
  );
  assert.equal(group.authority, 'episodic_only');
});

test('C23: explicit foreign-project signals and different scopes cannot join the group', () => {
  const groups = buildCrossRunEvidenceGroups({
    projectId: 'project-a',
    currentRunId: 'run-c',
    priorRunSignals: [
      {
        runId: 'run-foreign',
        projectId: 'project-b',
        failures: [{
          correctionId: 'correction-auth',
          scope: ['src/auth/refresh.ts'],
          evidenceRefs: ['failure://foreign/auth'],
        }],
      },
      {
        runId: 'run-a',
        failures: [{
          correctionId: 'correction-auth',
          scope: ['src/auth/refresh.ts'],
          evidenceRefs: ['failure://run-a/auth'],
        }],
      },
    ],
    signals: {
      runId: 'run-c',
      failures: [{
        correctionId: 'correction-auth',
        scope: ['src/billing/charge.ts'],
        evidenceRefs: ['failure://run-c/billing'],
      }],
    },
  });

  assert.deepEqual(groups, []);
});

test('C23: repeated evidence becomes an episodic derived candidate only', () => {
  const candidates = extractStructuredKnowledgeCandidates({
    run: { runId: 'run-b', projectId: 'project-a' },
    priorRunSignals: [{
      runId: 'run-a',
      failures: [{
        correctionId: 'correction-auth',
        statement: 'Auth refresh fails after expiry.',
        scope: ['src/auth/refresh.ts'],
        evidenceRefs: ['failure://run-a/auth'],
      }],
    }],
    signals: {
      runId: 'run-b',
      failures: [{
        correctionId: 'correction-auth',
        statement: 'Auth refresh fails after expiry.',
        scope: ['src/auth/refresh.ts'],
        evidenceRefs: ['failure://run-b/auth'],
      }],
    },
  });

  assert.equal(candidates.length, 1);
  const candidate = candidates[0];
  assert.ok(candidate);
  assert.equal(candidate.proposedType, 'episodic_observation');
  assert.equal(candidate.status, 'observed');
  assert.equal(candidate.trustTier, 'derived');
  assert.equal(candidate.signalKind, 'cross-run-evidence');
  const group = candidate.crossRunEvidenceGroup as {
    runCount?: number;
    authority?: string;
  };
  assert.equal(group.runCount, 2);
  assert.equal(group.authority, 'episodic_only');
  assert.equal(candidate.improvementPair, undefined);
});

test('C23: structured run signals preserve run identity for persisted deduplication', () => {
  const signals = buildStructuredRunSignals({
    runId: 'run-c23',
    failures: [{
      statement: 'Failure',
      evidenceRefs: ['failure://run-c23/1'],
    }],
  });

  assert.equal(signals.runId, 'run-c23');
});

test('W3: repeated generic blockers remain episodic and never become a durable failure pattern', () => {
  const candidates = extractStructuredKnowledgeCandidates({
    run: { runId: 'run-b', projectId: 'project-a' },
    priorRunSignals: [{
      runId: 'run-a',
      blockers: [{
        fingerprint: 'generic-blocker',
        reason: 'tool unavailable',
        statement: 'Tool unavailable.',
        evidenceRefs: ['blocker://run-a/tool'],
        scope: ['src/tooling/**'],
      }],
    }],
    signals: {
      runId: 'run-b',
      blockers: [{
        fingerprint: 'generic-blocker',
        reason: 'tool unavailable',
        statement: 'Tool unavailable.',
        evidenceRefs: ['blocker://run-b/tool'],
        scope: ['src/tooling/**'],
      }],
    },
  });

  const blockerCandidates = candidates.filter((candidate) => candidate.signalKind === 'blocker');
  assert.equal(blockerCandidates.length, 1);
  assert.equal(blockerCandidates[0].proposedType, 'episodic_observation');
  assert.equal(candidates.some((candidate) => candidate.proposedType === 'known_failure_pattern'), false);
});
