import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  retrievalCorpusDigest,
  runKnowledgeRetrievalEvaluation,
  type RetrievalEvalCorpus,
} from '../src/host-tooling/kernel-eval/retrieval-eval.js';
import { matchesKnowledgeQuery } from '../src/kernel/knowledge/path-scope.js';

const corpus: RetrievalEvalCorpus = JSON.parse(
  await readFile(
    new URL('./fixtures/kernel-retrieval-eval/corpus.json', import.meta.url),
    'utf8',
  ),
);

const baseline = JSON.parse(
  await readFile(
    new URL('./fixtures/kernel-retrieval-eval/baseline.json', import.meta.url),
    'utf8',
  ),
) as {
  schemaVersion: number;
  policyRevision: string;
  baselineSourceHead: string;
  metricContract: RetrievalEvalCorpus['metricContract'];
  deterministic: {
    taskSetRevision: string;
    corpusDigest: string;
    caseCount: number;
    aggregate: {
      retrieveRecall: { value: number | null };
      retrievePrecision: { value: number | null };
      injectionRecall: { value: number | null };
      injectionPrecision: { value: number | null };
      staleMissRate: { value: number | null };
      contextTokenEstimate: number;
    };
    cases: Array<{
      id: string;
      retrievedIds: string[];
      injectedIds: string[];
      staleOrUnavailableIds: string[];
    }>;
  };
  latency: {
    status: string;
    unit: string;
    cold: { condition: string; samples: Array<{ id: string; value: number }> };
    warm: { condition: string; samples: Array<{ id: string; value: number }> };
    comparison: string;
  };
};

test('C25 retrieval corpus fixes truth before scoring and separates negative classes', () => {
  assert.equal(corpus.schemaVersion, 1);
  assert.equal(corpus.taskSetRevision, 'kernel-retrieval.v1');
  assert.match(corpus.baselineSourceHead, /^[0-9a-f]{40}$/);
  assert.equal(corpus.cases.length, 3);

  for (const testCase of corpus.cases) {
    assert.match(testCase.id, /^RET-\d{3}$/);
    assert.ok(testCase.objective.length > 0);
    assert.ok(testCase.records.length > 0);

    const knownIds = new Set(testCase.records.map((record) => record.id));
    const truthSets = [
      testCase.truth.relevantIds,
      testCase.truth.irrelevantIds,
      testCase.truth.staleIds,
      testCase.truth.supersededIds,
    ];
    const seen = new Set<string>();
    for (const entries of truthSets) {
      for (const id of entries) {
        assert.ok(knownIds.has(id), `${testCase.id} truth ID must exist: ${id}`);
        assert.equal(seen.has(id), false, `${testCase.id} truth classes overlap: ${id}`);
        seen.add(id);
      }
    }
    assert.ok(testCase.truth.relevantIds.length > 0);
  }
});

test('C25 metric contract fixes denominators, unavailable handling, cold/warm, and token semantics', () => {
  const contract = corpus.metricContract;
  assert.match(contract.retrieveDefinition, /before freshness/i);
  assert.match(contract.injectionDefinition, /final context pack/i);
  assert.match(contract.recallDenominator, /relevantIds/);
  assert.match(contract.precisionDenominator, /Observed retrieved or injected IDs/);
  assert.match(contract.staleMissDenominator, /staleIds plus supersededIds/);
  assert.match(contract.tokenMetric, /proxy, not provider token usage/);
  assert.match(contract.latencyCold, /First context build/);
  assert.match(contract.latencyWarm, /Second context build/);
  assert.match(contract.unavailableRule, /Never substitute zero/);
});

test('C25 saved baseline is bound to the immutable corpus and current baseline head', () => {
  assert.equal(baseline.schemaVersion, 1);
  assert.equal(baseline.policyRevision, 'kernel-retrieval-eval.v1');
  assert.equal(baseline.baselineSourceHead, corpus.baselineSourceHead);
  assert.equal(
    baseline.deterministic.corpusDigest,
    retrievalCorpusDigest(corpus),
  );
  assert.equal(
    baseline.deterministic.taskSetRevision,
    corpus.taskSetRevision,
  );
  assert.equal(
    baseline.deterministic.caseCount,
    corpus.cases.length,
  );
  assert.deepEqual(baseline.metricContract, corpus.metricContract);
});

test('C25 saved baseline retains complete deterministic and latency observations', () => {
  assert.equal(
    baseline.deterministic.cases.length,
    corpus.cases.length,
  );
  assert.equal(baseline.latency.status, 'available');
  assert.equal(baseline.latency.unit, 'ms');
  assert.equal(baseline.latency.comparison, 'informational-only');
  assert.equal(baseline.latency.cold.samples.length, corpus.cases.length);
  assert.equal(baseline.latency.warm.samples.length, corpus.cases.length);
  assert.ok(
    baseline.latency.cold.samples.every((sample) => sample.value >= 0),
  );
  assert.ok(
    baseline.latency.warm.samples.every((sample) => sample.value >= 0),
  );
});

test('C25 baseline exposes the current scoped-irrelevant injection bottleneck without stale leakage', () => {
  const aggregate = baseline.deterministic.aggregate;
  assert.equal(aggregate.retrieveRecall.value, 1);
  assert.equal(aggregate.injectionRecall.value, 1);
  assert.equal(aggregate.staleMissRate.value, 0);
  assert.ok(
    aggregate.injectionPrecision.value !== null
      && aggregate.injectionPrecision.value < 1,
  );

  const auth = baseline.deterministic.cases.find(
    (entry) => entry.id === 'RET-001',
  );
  assert.ok(auth);
  assert.ok(auth.retrievedIds.includes('auth-refresh-stale'));
  assert.ok(auth.staleOrUnavailableIds.includes('auth-refresh-stale'));
  assert.equal(auth.injectedIds.includes('auth-refresh-stale'), false);
  assert.equal(auth.retrievedIds.includes('auth-refresh-superseded'), false);
  assert.equal(auth.injectedIds.includes('auth-refresh-superseded'), false);
  assert.equal(auth.retrievedIds.includes('foreign-auth-rule'), false);
  assert.equal(auth.injectedIds.includes('foreign-auth-rule'), false);

  for (const testCase of baseline.deterministic.cases) {
    const truth = corpus.cases.find((entry) => entry.id === testCase.id)?.truth;
    assert.ok(truth);
    assert.ok(
      truth.irrelevantIds.some((id) => testCase.injectedIds.includes(id)),
      `${testCase.id} should preserve the measured baseline false positive`,
    );
  }
});

test('C26 query relevance is independent of trust/status base score and supports Unicode objectives', () => {
  const unrelated = {
    status: 'committed',
    trustTier: 'verified',
    scope: ['src/billing/**'],
    statement: 'Billing retries use a capped delay.',
  };
  assert.equal(matchesKnowledgeQuery({
    item: unrelated,
    objective: 'Fix refresh token expiry handling.',
    paths: ['src/auth/refresh.ts'],
  }), false);

  const pathRelevant = {
    ...unrelated,
    scope: ['src/auth/**'],
  };
  assert.equal(matchesKnowledgeQuery({
    item: pathRelevant,
    objective: 'Fix refresh token expiry handling.',
    paths: ['src/auth/refresh.ts'],
  }), true);

  const unicodeRelevant = {
    ...unrelated,
    scope: ['src/other/**'],
    statement: '인증토큰 갱신 규칙을 적용한다.',
  };
  assert.equal(matchesKnowledgeQuery({
    item: unicodeRelevant,
    objective: '인증토큰 갱신 규칙을 확인한다',
    paths: [],
  }), true);
});

test('C26 same corpus improves injection precision without recall or stale regressions', async () => {
  const candidate = await runKnowledgeRetrievalEvaluation({ corpus });
  const before = baseline.deterministic.aggregate;
  const after = candidate.deterministic.aggregate;

  assert.equal(after.retrieveRecall.value, before.retrieveRecall.value);
  assert.equal(after.retrievePrecision.value, before.retrievePrecision.value);
  assert.equal(after.injectionRecall.value, 1);
  assert.equal(after.staleMissRate.value, 0);
  assert.ok(
    after.injectionPrecision.value !== null
      && before.injectionPrecision.value !== null
      && after.injectionPrecision.value > before.injectionPrecision.value,
  );
  assert.ok(
    after.contextTokenEstimate <= before.contextTokenEstimate,
  );

  for (const observed of candidate.deterministic.cases) {
    const truth = corpus.cases.find((entry) => entry.id === observed.id)?.truth;
    const beforeCase = baseline.deterministic.cases.find(
      (entry) => entry.id === observed.id,
    );
    assert.ok(truth);
    assert.ok(beforeCase);
    assert.deepEqual(
      observed.retrievedIds,
      beforeCase.retrievedIds,
      `${observed.id} authority retrieval must remain unchanged`,
    );
    assert.ok(
      truth.relevantIds.every((id) => observed.injectedIds.includes(id)),
      `${observed.id} must preserve relevant injection recall`,
    );
    assert.equal(
      truth.irrelevantIds.some((id) => observed.injectedIds.includes(id)),
      false,
      `${observed.id} must remove scoped irrelevant injection`,
    );
    assert.equal(
      [...truth.staleIds, ...truth.supersededIds]
        .some((id) => observed.injectedIds.includes(id)),
      false,
      `${observed.id} must not regress stale/superseded filtering`,
    );
  }
});
