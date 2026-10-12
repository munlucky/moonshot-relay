import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  buildFeedbackCorrectionPlan,
  classifyFeedbackRootCause,
} from '../src/kernel/knowledge/candidate-extract.js';
import {
  buildImprovementPair,
} from '../src/kernel/knowledge/improvement-pair.js';
import {
  normalizeCandidate,
} from '../src/kernel/knowledge-ingestion/normalize.js';
import { openKernelStateStore } from '../src/kernel/state-store.js';

const feedbackClassification = ({
  feedbackId = 'feedback-c21',
  sourceIdentity = 'feedback://source-c21',
  sourceRevision = 'revision-21',
}: {
  feedbackId?: string;
  sourceIdentity?: string;
  sourceRevision?: string;
} = {}) => classifyFeedbackRootCause({
  feedbackId,
  sourceIdentity,
  sourceRevision,
  evidence: [{
    signal: 'missing_knowledge',
    origin: 'user_instruction',
    role: 'primary',
    evidenceRefs: ['evidence://feedback-c21'],
  }],
});

const replayCandidate = ({
  projectId = 'project-c21',
  sourceRevision = 'revision-21',
  scope = ['src/auth/service.ts'],
}: {
  projectId?: string;
  sourceRevision?: string;
  scope?: string[];
} = {}) => ({
  candidateId: 'replay-c21',
  projectId,
  sourceRevision,
  scope,
  evidenceRefs: ['receipt://replay-candidate'],
  obligationIds: ['feedback-regression'],
});

test('C21: correction retry keeps one pair identity while partial pair becomes ready', () => {
  const classification = feedbackClassification();
  const base = {
    projectId: 'project-c21',
    statement: 'Auth retries must use bounded exponential backoff.',
    scope: ['src/auth/service.ts'],
    classification,
  };

  const partial = buildFeedbackCorrectionPlan(base);
  const partialCandidate = partial.candidates[0];
  assert.ok(partialCandidate);
  assert.equal(partialCandidate.improvementPair.status, 'incomplete');
  assert.equal(
    partialCandidate.improvementPair.recovery.state,
    'awaiting_replay',
  );
  assert.deepEqual(
    partialCandidate.improvementPair.recovery.missing,
    ['replay_candidate'],
  );

  const ready = buildFeedbackCorrectionPlan({
    ...base,
    replayCandidate: replayCandidate(),
  });
  const readyCandidate = ready.candidates[0];
  assert.ok(readyCandidate);

  assert.equal(readyCandidate.candidateId, partialCandidate.candidateId);
  assert.equal(
    readyCandidate.improvementPair.pairId,
    partialCandidate.improvementPair.pairId,
  );
  assert.equal(readyCandidate.improvementPair.status, 'ready');
  assert.equal(readyCandidate.improvementPair.recovery.state, 'complete');
  assert.deepEqual(readyCandidate.improvementPair.recovery.missing, []);
  assert.equal(
    readyCandidate.improvementPair.mutationCandidate?.candidateId,
    readyCandidate.candidateId,
  );
  assert.equal(
    readyCandidate.improvementPair.replayCandidate?.candidateId,
    'replay-c21',
  );
});

test('C21: pair records source evidence, mutation candidate, replay candidate, scope and revision together', () => {
  const classification = feedbackClassification();
  const plan = buildFeedbackCorrectionPlan({
    projectId: 'project-c21',
    statement: 'Auth retries must use bounded exponential backoff.',
    scope: ['src/auth/service.ts'],
    classification,
    replayCandidate: replayCandidate(),
  });
  const candidate = plan.candidates[0];
  assert.ok(candidate);

  const pair = candidate.improvementPair;
  assert.equal(pair.correctionId, candidate.candidateId);
  assert.equal(pair.projectId, 'project-c21');
  assert.equal(pair.sourceIdentity, 'feedback://source-c21');
  assert.equal(pair.sourceRevision, 'revision-21');
  assert.deepEqual(pair.scope, ['src/auth/service.ts']);
  assert.deepEqual(pair.sourceEvidenceRefs, ['evidence://feedback-c21']);
  assert.equal(pair.mutationCandidate?.candidateId, candidate.candidateId);
  assert.equal(pair.replayCandidate?.candidateId, 'replay-c21');
  assert.deepEqual(
    pair.replayCandidate?.obligationIds,
    ['feedback-regression'],
  );
});

test('C21: pair fails closed on project revision or scope mismatch', () => {
  const base = {
    correctionId: 'cand-correction',
    projectId: 'project-c21',
    sourceIdentity: 'feedback://source-c21',
    sourceRevision: 'revision-21',
    scope: ['src/auth/service.ts'],
    sourceEvidenceRefs: ['evidence://feedback-c21'],
    mutationCandidate: {
      candidateId: 'cand-correction',
      projectId: 'project-c21',
      sourceRevision: 'revision-21',
      scope: ['src/auth/service.ts'],
    },
  };

  for (const {
    replay,
    expectedConflict,
  } of [
    {
      replay: replayCandidate({ projectId: 'other-project' }),
      expectedConflict: 'replay_project_mismatch',
    },
    {
      replay: replayCandidate({ sourceRevision: 'revision-22' }),
      expectedConflict: 'replay_revision_mismatch',
    },
    {
      replay: replayCandidate({ scope: ['src/billing/service.ts'] }),
      expectedConflict: 'replay_scope_mismatch',
    },
  ]) {
    const pair = buildImprovementPair({
      ...base,
      replayCandidate: replay,
    });
    assert.equal(pair.status, 'invalid');
    assert.equal(pair.recovery.state, 'identity_mismatch');
    assert.ok(pair.recovery.conflicts.includes(expectedConflict));
  }
});

test('C21: normalized candidate preserves pair metadata without granting trust or promotion', () => {
  const classification = feedbackClassification();
  const candidate = buildFeedbackCorrectionPlan({
    projectId: 'project-c21',
    statement: 'Auth retries must use bounded exponential backoff.',
    scope: ['src/auth/service.ts'],
    classification,
    replayCandidate: replayCandidate(),
  }).candidates[0];
  assert.ok(candidate);

  const normalized = normalizeCandidate(candidate, {
    projectId: 'project-c21',
    sourceType: 'feedback',
    sourceIdentity: classification.sourceIdentity,
    sourceDigest: classification.sourceRevision,
  });

  assert.deepEqual(normalized.improvementPair, candidate.improvementPair);
  assert.equal(normalized.trustTier, 'derived');
  assert.equal(normalized.status, 'observed');
});

test('C21: SQLite candidate upsert atomically recovers partial pair without duplicate candidate rows', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-c21-pair-'));
  const store = await openKernelStateStore({ runtimeHome: tmp });
  const runId = 'run-c21-pair';
  const projectId = 'project-c21';

  try {
    store.createRun({
      runId,
      objective: 'Persist one Improvement Pair record',
      sourceIdentity: 'source-c21-run',
      projectId,
      knowledgeRevisionStart: '1',
    });

    const classification = feedbackClassification();
    const base = {
      projectId,
      statement: 'Auth retries must use bounded exponential backoff.',
      scope: ['src/auth/service.ts'],
      classification,
    };
    const partial = buildFeedbackCorrectionPlan(base).candidates[0];
    const ready = buildFeedbackCorrectionPlan({
      ...base,
      replayCandidate: replayCandidate(),
    }).candidates[0];
    assert.ok(partial);
    assert.ok(ready);
    assert.equal(partial.candidateId, ready.candidateId);
    assert.equal(
      partial.improvementPair.pairId,
      ready.improvementPair.pairId,
    );

    store.recordKnowledgeCandidate(partial.candidateId, runId, {
      projectId,
      proposedType: partial.proposedType,
      status: 'pending',
      candidateJson: partial,
    });
    let rows = store.getKnowledgeCandidates(runId);
    assert.equal(rows.length, 1);
    assert.equal(
      (rows[0]?.candidateJson as {
        improvementPair?: { status?: string };
      }).improvementPair?.status,
      'incomplete',
    );

    store.recordKnowledgeCandidate(ready.candidateId, runId, {
      projectId,
      proposedType: ready.proposedType,
      status: 'pending',
      candidateJson: ready,
    });
    rows = store.getKnowledgeCandidates(runId);
    assert.equal(rows.length, 1);

    const persisted = rows[0]?.candidateJson as {
      candidateId?: string;
      improvementPair?: {
        pairId?: string;
        status?: string;
        recovery?: { state?: string };
      };
    };
    assert.equal(persisted.candidateId, ready.candidateId);
    assert.equal(
      persisted.improvementPair?.pairId,
      ready.improvementPair.pairId,
    );
    assert.equal(persisted.improvementPair?.status, 'ready');
    assert.equal(persisted.improvementPair?.recovery?.state, 'complete');
  } finally {
    store.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
