import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFeedbackRootCause,
  type FeedbackCauseEvidence,
  type FeedbackRootCause,
  type FeedbackSignal,
} from '../src/kernel/knowledge/candidate-extract.js';
import {
  normalizeCandidate,
} from '../src/kernel/knowledge-ingestion/normalize.js';

const cases: Array<{
  signal: FeedbackSignal;
  expected: FeedbackRootCause;
}> = [
  { signal: 'missing_knowledge', expected: 'knowledge_gap' },
  { signal: 'missing_procedure', expected: 'procedure_gap' },
  { signal: 'missing_verification', expected: 'verification_gap' },
  { signal: 'stale_knowledge', expected: 'stale_knowledge' },
  { signal: 'known_failure_match', expected: 'known_failure' },
  { signal: 'insufficient_evidence', expected: 'ambiguity' },
  { signal: 'isolated_occurrence', expected: 'one_off' },
];

test('C19: seven feedback causes require structured source evidence', () => {
  for (const { signal, expected } of cases) {
    const result = classifyFeedbackRootCause({
      feedbackId: `feedback-${signal}`,
      sourceIdentity: 'review://session-1',
      sourceRevision: 17,
      evidence: [{
        signal,
        origin: 'analysis_inference',
        evidenceRefs: [`receipt://${signal}`],
      }],
    });

    assert.equal(result.primary, expected);
    assert.equal(
      result.status,
      expected === 'ambiguity' ? 'ambiguous' : 'classified',
    );
    assert.deepEqual(result.secondary, []);
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].cause, expected);
  }
});

test('C19: evidence-free cause claims fail closed to ambiguity', () => {
  const result = classifyFeedbackRootCause({
    feedbackId: 'feedback-no-evidence',
    sourceIdentity: 'user://message-1',
    sourceRevision: 'rev-1',
    evidence: [{
      signal: 'missing_procedure',
      origin: 'user_instruction',
      evidenceRefs: [],
    }],
  });

  assert.equal(result.status, 'ambiguous');
  assert.equal(result.primary, 'ambiguity');
  assert.deepEqual(result.secondary, []);
  assert.deepEqual(result.evidence, []);
});

test('C19: conflicting causes remain ambiguous unless exactly one primary is explicit', () => {
  const conflicting: FeedbackCauseEvidence[] = [
    {
      signal: 'missing_knowledge',
      origin: 'user_instruction',
      evidenceRefs: ['user://message-2'],
    },
    {
      signal: 'missing_verification',
      origin: 'analysis_inference',
      evidenceRefs: ['proof://missing-regression'],
    },
  ];
  const ambiguous = classifyFeedbackRootCause({
    feedbackId: 'feedback-conflict',
    sourceIdentity: 'review://session-2',
    sourceRevision: 3,
    evidence: conflicting,
  });

  assert.equal(ambiguous.primary, 'ambiguity');
  assert.deepEqual(
    new Set(ambiguous.secondary),
    new Set(['knowledge_gap', 'verification_gap']),
  );

  const resolved = classifyFeedbackRootCause({
    feedbackId: 'feedback-primary',
    sourceIdentity: 'review://session-2',
    sourceRevision: 4,
    evidence: [
      { ...conflicting[0], role: 'secondary' },
      { ...conflicting[1], role: 'primary' },
    ],
  });

  assert.equal(resolved.primary, 'verification_gap');
  assert.deepEqual(resolved.secondary, ['knowledge_gap']);
});

test('C19: user instruction and analysis inference provenance stay separate', () => {
  const result = classifyFeedbackRootCause({
    feedbackId: 'feedback-provenance',
    sourceIdentity: 'review://session-3',
    sourceRevision: 1,
    evidence: [
      {
        signal: 'stale_knowledge',
        origin: 'user_instruction',
        role: 'primary',
        evidenceRefs: ['user://message-3', 'source://old-doc'],
      },
      {
        signal: 'known_failure_match',
        origin: 'analysis_inference',
        role: 'secondary',
        evidenceRefs: ['failure://auth-timeout'],
      },
    ],
  });

  assert.equal(result.primary, 'stale_knowledge');
  assert.deepEqual(result.secondary, ['known_failure']);
  assert.deepEqual(
    result.provenance.userInstructionRefs,
    ['user://message-3', 'source://old-doc'],
  );
  assert.deepEqual(
    result.provenance.analysisInferenceRefs,
    ['failure://auth-timeout'],
  );
});

test('C19: identical feedback source revision is stable and normalization preserves only metadata authority', () => {
  const input = {
    feedbackId: 'feedback-repeat',
    sourceIdentity: 'review://session-repeat',
    sourceRevision: 'sha256:revision-1',
    evidence: [{
      signal: 'missing_procedure' as const,
      origin: 'user_instruction' as const,
      role: 'primary' as const,
      evidenceRefs: ['user://repeat'],
    }],
  };
  const first = classifyFeedbackRootCause(input);
  const second = classifyFeedbackRootCause(input);
  assert.deepEqual(first, second);
  assert.equal(first.feedbackIdentity, second.feedbackIdentity);

  const candidate = normalizeCandidate({
    proposedType: 'semantic_fact',
    statement: 'The current workflow lacks a reusable release procedure.',
    scope: ['src/release/**'],
    status: 'staged',
    feedbackClassification: first,
  }, {
    projectId: 'project-a',
    sourceType: 'feedback',
    sourceIdentity: input.sourceIdentity,
    sourceDigest: input.sourceRevision,
  });

  assert.deepEqual(candidate.feedbackClassification, first);
  assert.equal(candidate.proposedType, 'semantic_fact');
  assert.equal(candidate.status, 'staged');
  assert.equal(candidate.trustTier, 'derived');
});
