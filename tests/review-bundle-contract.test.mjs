import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';

import { sha256Hex } from '../scripts/lib/candidate-identity.js';
import {
  buildRepairPrompt,
  buildRepairLoopReceipt,
  buildReviewBundle,
  buildReviewCritiqueLoopReceipt,
  repairLoopBlockers,
  reviewCritiqueLoopBlockers,
} from '../scripts/lib/review-bundle.mjs';
import { buildBrowserFailurePackage } from '../scripts/lib/browser-failure-package.mjs';

const tempRoots = [];
const root = process.cwd();
const fromRoot = (...segments) => path.join(root, ...segments);
const readJson = async (...segments) => JSON.parse(await readFile(fromRoot(...segments), 'utf8'));

after(async () => {
  await Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

const input = () => ({
  candidate_id: `cand_${'a'.repeat(32)}`,
  sourceDigest: sha256Hex('source'),
  contractRevision: 3,
  freshSessionId: 'fresh-review-session-1',
  spec: { id: 'spec' },
  plan: { id: 'plan' },
  done: { id: 'done' },
  diff: { files: ['a.js'] },
  testResults: { status: 'passed' },
});

test('review bundle includes only fresh review input surface and digest', () => {
  const bundle = buildReviewBundle(input());

  assert.equal(bundle.artifactId, 'REVIEW_BUNDLE');
  assert.equal(bundle.candidate_id, input().candidate_id);
  assert.equal(bundle.freshSessionId, 'fresh-review-session-1');
  assert.match(bundle.bundleDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(bundle.input).sort(), ['diff', 'done', 'plan', 'spec', 'testResults']);
});

test('review bundle rejects implementation transcript hidden reasoning and self evaluation', () => {
  assert.throws(() => buildReviewBundle({
    ...input(),
    spec: { implementationTranscript: 'do not leak' },
  }), /forbidden context/);
  assert.throws(() => buildReviewBundle({
    ...input(),
    plan: { nested: { hiddenReasoning: 'do not leak' } },
  }), /forbidden context/);
  assert.throws(() => buildReviewBundle({
    ...input(),
    testResults: { selfEvaluation: 'looks good' },
  }), /forbidden context/);
});

test('review bundle CLI emits JSON digest', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'moonshot-review-bundle-'));
  tempRoots.push(tempRoot);
  const inputPath = path.join(tempRoot, 'input.json');
  await writeFile(inputPath, JSON.stringify(input(), null, 2));

  const result = spawnSync(process.execPath, ['scripts/review-bundle-build.mjs', '--input', inputPath, '--json'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.bundleDigest, /^[a-f0-9]{64}$/);
});

test('review critique loop receipt requires two iterations and parent dispositions', () => {
  const receipt = buildReviewCritiqueLoopReceipt({
    candidate_id: input().candidate_id,
    sourceDigest: input().sourceDigest,
    bundleDigest: 'd'.repeat(64),
    iterations: [
      { reviewers: [{ reviewerId: 'agent-a', focus: 'requirements_contract' }, { reviewerId: 'agent-b', focus: 'runtime_authority' }] },
      { reviewers: [{ reviewerId: 'agent-c', focus: 'regression_risk' }, { reviewerId: 'agent-d', focus: 'security_or_data_safety' }] },
    ],
    parentResolutions: [
      { findingId: 'finding-1', status: 'accepted', evidence: 'fixed in tests', blockerId: '' },
      { findingId: 'finding-2', status: 'rejected_with_evidence', evidence: 'existing test covers it', blockerId: '' },
    ],
  });

  assert.equal(receipt.artifactId, 'REVIEW_CRITIQUE_LOOP_RECEIPT');
  assert.equal(receipt.iterations.length, 2);
  assert.equal(receipt.effectiveReviewerCount, 4);
  assert.equal(receipt.closeoutEligible, true);
  assert.equal(reviewCritiqueLoopBlockers({
    receipt,
    candidate_id: input().candidate_id,
    sourceDigest: input().sourceDigest,
    bundleDigest: 'd'.repeat(64),
  }).length, 0);

  const missing = reviewCritiqueLoopBlockers({ required: true });
  assert.equal(missing[0].code, 'review_critique_loop_missing');

  const blocking = buildReviewCritiqueLoopReceipt({
    candidate_id: input().candidate_id,
    sourceDigest: input().sourceDigest,
    bundleDigest: 'd'.repeat(64),
    iterations: receipt.iterations,
    parentResolutions: [
      { findingId: 'finding-3', status: 'blocking_tracked', evidence: '', blockerId: 'blocker-1' },
    ],
  });
  assert.ok(reviewCritiqueLoopBlockers({ receipt: blocking }).some((blocker) => blocker.code === 'review_critique_loop_unresolved_blocking'));

  const forgedReviewerIndependence = buildReviewCritiqueLoopReceipt({
    candidate_id: input().candidate_id,
    sourceDigest: input().sourceDigest,
    bundleDigest: 'd'.repeat(64),
    iterations: [
      { reviewers: [{ reviewerId: 'agent-a', focus: 'requirements_contract' }] },
      { reviewers: [{ reviewerId: 'agent-a', focus: 'runtime_authority' }] },
    ],
    parentResolutions: [],
  });
  const forgedReviewerClaim = {
    ...forgedReviewerIndependence,
    reviewerIds: ['agent-a', 'agent-b'],
    effectiveReviewerCount: 2,
  };
  assert.ok(reviewCritiqueLoopBlockers({ receipt: forgedReviewerClaim }).some((blocker) => blocker.code === 'review_critique_loop_reviewer_set_mismatch'));

  const forgedBlockingAggregate = buildReviewCritiqueLoopReceipt({
    candidate_id: input().candidate_id,
    sourceDigest: input().sourceDigest,
    bundleDigest: 'd'.repeat(64),
    iterations: receipt.iterations,
    parentResolutions: [
      { findingId: 'finding-4', status: 'blocking_tracked', evidence: '', blockerId: 'blocker-4' },
    ],
  });
  const forgedBlockingClean = {
    ...forgedBlockingAggregate,
    unresolvedBlockingCount: 0,
    closeoutEligible: true,
  };
  assert.ok(reviewCritiqueLoopBlockers({ receipt: forgedBlockingClean }).some((blocker) => blocker.code === 'review_critique_loop_blocking_count_mismatch'));

  const tampered = { ...receipt, receiptDigest: 'f'.repeat(64) };
  assert.ok(reviewCritiqueLoopBlockers({ receipt: tampered }).some((blocker) => blocker.code === 'review_critique_loop_digest_mismatch'));

  const rawPrompt = { ...receipt, rawPrompt: 'DO_NOT_STORE_RAW_PROMPT' };
  assert.ok(reviewCritiqueLoopBlockers({ receipt: rawPrompt }).some((blocker) => blocker.code === 'review_critique_loop_forbidden_context'));
});

test('repair prompt preserves failure evidence and prohibited repair actions', () => {
  const repair = buildRepairPrompt({
    scenarioId: 'critical-browser-flow',
    failedStep: 'expected_text',
    failureClass: 'browser_confirmation_failed',
    consoleSummary: { errorCount: 1 },
    networkSummary: { failedCount: 0 },
    artifacts: [{ path: '.moonshot-relay/browser-artifacts/run/goal/flow/screenshot.png' }],
    prohibitedRepairActions: [],
    rerunCommand: 'npm run browser:test -- --scenario critical-browser-flow',
    maxRepairAttempts: 99,
  });

  assert.equal(repair.artifactId, 'REPAIR_PROMPT');
  assert.equal(repair.maxRepairAttempts, 2);
  assert.equal(repair.prohibitedRepairActions.includes('do not skip required browser or integration tests'), true);
  assert.match(repair.prompt, /scenarioId: critical-browser-flow/);
  assert.match(repair.prompt, /do not delete or weaken failing assertions/);
  assert.match(repair.prompt, /npm run browser:test/);
});

test('repair prompt browserResult adapter preserves summaries and artifacts', () => {
  const repair = buildRepairPrompt({
    scenarioId: 'critical-browser-flow',
    browserResult: {
      status: 'failed',
      failedStage: 'assertion',
      failureClass: 'playwright_assertion_failed',
      consoleSummary: { errorCount: 2 },
      networkSummary: { failedCount: 1 },
      artifacts: [{ type: 'screenshot', path: '.moonshot-relay/browser-artifacts/run/goal/critical/screenshot.png' }],
      failedAssertionIds: ['assert-text'],
      rerunCommand: 'node --test tests/workflow-e2e-contract.test.mjs --test-name-pattern critical-browser-flow',
    },
  });

  assert.deepEqual(repair.failurePackage.consoleSummary, { errorCount: 2 });
  assert.deepEqual(repair.failurePackage.networkSummary, { failedCount: 1 });
  assert.deepEqual(repair.artifacts.map((artifact) => artifact.path), ['.moonshot-relay/browser-artifacts/run/goal/critical/screenshot.png']);
  assert.deepEqual(repair.failedAssertionIds, ['assert-text']);
});

test('repair prompt and receipt compose the canonical browser failure package', async () => {
  const scenario = await readJson('tests', 'fixtures', 'browser-scenarios', 'critical-browser-flow.json');
  const artifacts = [
    { type: 'screenshot', path: '.moonshot-relay/browser-artifacts/run/goal/critical/screenshot.png' },
    { type: 'trace', path: '.moonshot-relay/browser-artifacts/run/goal/critical/trace.zip' },
    { type: 'console', path: '.moonshot-relay/browser-artifacts/run/goal/critical/console.json' },
    { type: 'network', path: '.moonshot-relay/browser-artifacts/run/goal/critical/network.json' },
    { type: 'report', path: '.moonshot-relay/browser-artifacts/run/goal/critical/report.json' },
  ];
  const failurePackage = buildBrowserFailurePackage({
    scenario,
    browserResult: {
      status: 'failed',
      failedStage: 'assertion',
      failureClass: 'playwright_assertion_failed',
      setupGap: false,
    },
    failedAssertionIds: ['assert-text', 'assert-role'],
    artifacts,
    rerunCommand: 'node --test tests/workflow-e2e-contract.test.mjs --test-name-pattern critical-browser-flow',
    maxRepairAttempts: 2,
  });
  const repair = buildRepairPrompt({
    failurePackage,
  });
  const receipt = buildRepairLoopReceipt({
    failurePackage,
  });

  assert.equal(repair.artifactId, 'REPAIR_PROMPT');
  assert.equal(repair.failurePackage.artifactId, 'BROWSER_FAILURE_PACKAGE');
  assert.equal(receipt.artifactId, 'REPAIR_LOOP_RECEIPT');
  assert.equal(repair.scenarioId, receipt.scenarioId);
  assert.equal(repair.originalScenarioId, receipt.originalScenarioId);
  assert.equal(repair.rerunScenarioId, receipt.rerunScenarioId);
  assert.deepEqual(receipt.artifactLinks, artifacts.map((artifact) => artifact.path));
  assert.equal(repair.blockerMapping[0].failureClass, 'playwright_assertion_failed');
  assert.equal(receipt.blockerMapping[0].blocksCompletion, true);
  assert.match(repair.prompt, /do not delete or weaken failing assertions/);
  assert.match(repair.prompt, /do not update screenshot or visual baselines automatically/);
  assert.match(repair.prompt, /Blocker Mapping/);
  assert.equal(repairLoopBlockers({ receipt, required: true }).length, 0);
});

test('repair loop receipt blocks exhausted changed-scenario or weakened assertion reruns', () => {
  const clean = buildRepairLoopReceipt({
    scenarioId: 'critical-browser-flow',
    originalScenarioId: 'critical-browser-flow',
    rerunScenarioId: 'critical-browser-flow',
    failedAssertionIds: ['assert-text', 'assert-role'],
    preservedAssertionIds: ['assert-text', 'assert-role'],
    attemptIndex: 1,
    maxRepairAttempts: 2,
  });

  assert.equal(repairLoopBlockers({ receipt: clean, required: true }).length, 0);

  const exhausted = buildRepairLoopReceipt({
    ...clean,
    status: 'repair_exhausted',
    artifactLinks: ['.moonshot-relay/verification-reports/repair-exhausted.json'],
  });
  assert.ok(repairLoopBlockers({ receipt: exhausted, required: true }).some((blocker) => blocker.code === 'repair_exhausted'));

  const changedScenario = buildRepairLoopReceipt({
    ...clean,
    rerunScenarioId: 'different-scenario',
  });
  assert.ok(repairLoopBlockers({ receipt: changedScenario, required: true }).some((blocker) => blocker.code === 'repair_scenario_mismatch'));

  const weakenedAssertions = buildRepairLoopReceipt({
    ...clean,
    preservedAssertionIds: ['assert-text'],
  });
  assert.ok(repairLoopBlockers({ receipt: weakenedAssertions, required: true }).some((blocker) => blocker.code === 'repair_assertion_ids_changed'));
});
