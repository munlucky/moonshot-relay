import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runModelRoutingEvaluation } from '../src/host-tooling/kernel-eval/model-routing-eval.js';

type EvaluationCorpus = Parameters<typeof runModelRoutingEvaluation>[0]['corpus'];
const corpus: Omit<EvaluationCorpus, 'cases'> & { schemaVersion: number; cases: (EvaluationCorpus['cases'][number] & { positiveControl?: boolean; expectEscalation?: boolean })[] } = JSON.parse(await readFile(new URL('./fixtures/kernel-model-routing/corpus.json', import.meta.url), 'utf8'));

test('routing corpus is fixed, revision-stamped, and covers the required task shapes', () => {
  assert.equal(corpus.schemaVersion, 1);
  assert.equal(corpus.taskSetRevision, 'kernel-model-routing.v1');
  assert.equal(corpus.cases.length, 10);
  assert.ok(corpus.cases.some((c) => c.positiveControl === true), 'must include a positive control');
  assert.ok(corpus.cases.filter((c) => c.riskTier === 'T3').length >= 2);
  assert.ok(corpus.cases.filter((c) => c.expectEscalation === true).length >= 2);
  for (const testCase of corpus.cases) {
    assert.match(testCase.id, /^MR-\d{3}$/);
    assert.ok(testCase.turns.length > 0, testCase.id);
    assert.ok(testCase.turns.some((turn) => turn.actionKind === 'prove'), `${testCase.id} must end in kernel-owned proof`);
  }
  // No provider model id may be pinned in the corpus.
  assert.doesNotMatch(JSON.stringify(corpus), /gpt-|claude-|gemini|anthropic|openai/i);
});

test('routing cuts the frontier ratio and the cost proxy against the all-frontier baseline', () => {
  const report = runModelRoutingEvaluation({ corpus, seed: 1 });
  assert.equal(report.baseline.frontierTurnRatio, 1);
  assert.ok(report.candidate.frontierTurnRatio <= 0.4, `frontier ratio ${report.candidate.frontierTurnRatio}`);
  assert.ok(report.costProxyRatio <= 0.7, `cost proxy ratio ${report.costProxyRatio}`);
  assert.equal(report.taskSetRevision, corpus.taskSetRevision);
  assert.equal(report.policyRevision, 'kernel-model-routing.v1');
  assert.equal(report.seed, 1);
});

test('every provider turn produces a receipt and no receipt overstates enforcement', () => {
  const report = runModelRoutingEvaluation({ corpus });
  assert.equal(report.candidate.receiptCoverage, 1);
  assert.equal(report.candidate.dishonestReceipts, 0);
  assert.equal(report.baseline.dishonestReceipts, 0);
  // The same corpus on a Host that cannot switch models must never claim it did.
  assert.equal(report.unsupportedHost.dishonestReceipts, 0);
  assert.equal(report.unsupportedHost.receiptCoverage, 1);
});

test('T3 independent review coverage is complete and escalation cases really escalate', () => {
  const report = runModelRoutingEvaluation({ corpus });
  assert.equal(report.candidate.missingIndependentReview, 0);
  assert.ok(report.candidate.independentReviewTurns >= 2);
  for (const testCase of corpus.cases.filter((c) => c.expectEscalation)) {
    const observed = report.candidate.perCase.find((entry) => entry.id === testCase.id);
    assert.ok(observed);
    assert.equal(observed.escalated, true, `${testCase.id} should escalate`);
  }
});

test('quality and completion-rate deltas are reported as unavailable, not estimated', () => {
  const report = runModelRoutingEvaluation({ corpus });
  assert.equal(report.qualityDelta.status, 'unavailable');
  assert.equal(report.completionRateDelta.status, 'unavailable');
  assert.ok(report.qualityDelta.reason);
});
