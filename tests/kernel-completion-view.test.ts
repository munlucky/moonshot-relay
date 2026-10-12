import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeCompletionView } from '../src/kernel/proof/completion-view.js';

test('completion view is derived from existing authorities', () => {
  const view = computeCompletionView({
    run: { finalizationStatus: 'completed', status: 'completed' },
    step: { state: 'passed' },
    obligations: [{ obligationId: 'test', evidenceClass: 'hard', status: 'required' }],
    verifications: [{ obligationId: 'test', status: 'passed' }],
    completionDecision: { decision: 'accepted' },
  });
  assert.deepEqual(view, {
    implementation: 'complete',
    verification: 'passed',
    deployment: 'not-required',
    observation: 'not-required',
    resolution: 'not-required',
    outcomes: {
      implemented: 'complete',
      verified: 'passed',
      deployed: 'not-required',
      observed: 'not-required',
      resolved: 'not-required',
    },
    review: 'not-required',
    kernelAcceptance: 'accepted',
    finalization: 'complete',
    overall: 'done',
  });
});

test('completion view keeps verified, deployed, observed, and resolved outcomes separate', () => {
  const obligations = [
    { obligationId: 'build', evidenceClass: 'hard', status: 'required', metadata: { outcome: 'verified' } },
    { obligationId: 'deploy', evidenceClass: 'hard', status: 'required', metadata: { outcome: 'deployed' } },
    { obligationId: 'observe', evidenceClass: 'hard', status: 'required', metadata: { outcome: 'observed' } },
    { obligationId: 'resolve', evidenceClass: 'hard', status: 'required', metadata: { outcome: 'resolved' } },
  ];
  const view = computeCompletionView({
    run: {
      finalizationStatus: 'pending',
      status: 'active',
      mutationRevision: 1,
      taskContract: { completionPredicate: { requiredOutcomes: ['implemented', 'verified', 'deployed', 'observed', 'resolved'] } },
    },
    step: { state: 'passed' },
    obligations,
    verifications: [
      { obligationId: 'build', status: 'passed' },
      { obligationId: 'deploy', status: 'passed' },
      { obligationId: 'observe', status: 'passed' },
    ],
  });
  assert.equal(view.implementation, 'complete');
  assert.equal(view.verification, 'pending', 'the unresolved hard obligation still keeps aggregate verification pending');
  assert.equal(view.deployment, 'passed');
  assert.equal(view.observation, 'passed');
  assert.equal(view.resolution, 'pending');
  assert.deepEqual(view.outcomes, {
    implemented: 'complete',
    verified: 'passed',
    deployed: 'passed',
    observed: 'passed',
    resolved: 'pending',
  });
  assert.equal(view.overall, 'active');
});

test('completion view derives a resolved judgment outcome from its review receipt', () => {
  const view = computeCompletionView({
    run: {
      finalizationStatus: 'pending',
      status: 'active',
      mutationRevision: 1,
      taskContract: { completionPredicate: { requiredOutcomes: ['resolved'] } },
    },
    step: { state: 'passed' },
    obligations: [{
      obligationId: 'resolution-review',
      evidenceClass: 'judgment',
      status: 'required',
      metadata: { outcome: 'resolved' },
    }],
    reviews: [{
      obligationId: 'resolution-review',
      verdict: 'pass',
      subject: { mutationRevision: 1 },
    }],
  });
  assert.equal(view.review, 'passed');
  assert.equal(view.resolution, 'passed');
  assert.equal(view.outcomes.resolved, 'passed');
});

test('completion view uses latest obligation state for retries (failed -> passed)', () => {
  const view = computeCompletionView({
    run: { finalizationStatus: 'pending', status: 'active', mutationRevision: 1 },
    step: { state: 'passed' },
    obligations: [{ obligationId: 'test', evidenceClass: 'hard', status: 'required' }],
    verifications: [
      { id: 1, obligationId: 'test', status: 'failed' },
      { id: 2, obligationId: 'test', status: 'passed' },
    ],
  });
  assert.equal(view.verification, 'passed');
  assert.equal(view.overall, 'active');
});

test('completion view reflects latest obligation state for retries (passed -> failed)', () => {
  const view = computeCompletionView({
    run: { finalizationStatus: 'pending', status: 'active', mutationRevision: 1 },
    step: { state: 'passed' },
    obligations: [{ obligationId: 'test', evidenceClass: 'hard', status: 'required' }],
    verifications: [
      { id: 1, obligationId: 'test', status: 'passed' },
      { id: 2, obligationId: 'test', status: 'failed' },
    ],
  });
  assert.equal(view.verification, 'failed');
  assert.equal(view.overall, 'blocked');
});

test('completion view ignores historical reviews from prior mutation revisions', () => {
  const view = computeCompletionView({
    run: { finalizationStatus: 'pending', status: 'active', mutationRevision: 2 },
    step: { state: 'passed' },
    obligations: [{ obligationId: 'review-engineering', evidenceClass: 'judgment', status: 'required' }],
    reviews: [
      { id: 1, obligationId: 'review-engineering', verdict: 'fail', subject: { mutationRevision: 1 } },
      { id: 2, obligationId: 'review-engineering', verdict: 'pass', subject: { mutationRevision: 2 } },
    ],
  });
  assert.equal(view.review, 'passed');
  assert.equal(view.overall, 'active');
});

test('completion view review retry (fail -> pass) updates view to passed', () => {
  const view = computeCompletionView({
    run: { finalizationStatus: 'pending', status: 'active', mutationRevision: 1 },
    step: { state: 'passed' },
    obligations: [{ obligationId: 'review-engineering', evidenceClass: 'judgment', status: 'required' }],
    reviews: [
      { id: 1, obligationId: 'review-engineering', verdict: 'fail', subject: { mutationRevision: 1 } },
      { id: 2, obligationId: 'review-engineering', verdict: 'pass', subject: { mutationRevision: 1 } },
    ],
  });
  assert.equal(view.review, 'passed');
  assert.equal(view.overall, 'active');
});
