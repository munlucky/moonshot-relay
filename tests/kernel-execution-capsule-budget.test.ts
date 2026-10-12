// K1 §6.5: a capsule is a BOUNDED context. Over-budget input is reduced in a
// declared priority order and the reduction is reported, so a worker is never
// handed a silently truncated context.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyCapsuleBudget, CAPSULE_BUDGET, CAPSULE_REDUCTION_ORDER, selectKnowledgeRecords } from '../src/kernel/run/capsule-selection.js';

const capsuleWith = ({ files = 0, symbols = 0, knowledge = 0, architecture = 0, failures = 0, summaryLength = 20 } = {}) => ({
  schemaVersion: 1,
  runId: 'r-budget',
  role: 'implementer',
  objective: 'x',
  repositoryContext: {
    relevantFiles: Array.from({ length: files }, (_, index) => ({ path: `src/file-${String(index).padStart(3, '0')}.mjs`, reason: 'inside the work unit scope', digest: null })),
    relevantSymbols: Array.from({ length: symbols }, (_, index) => ({ symbol: `sym${index}`, path: 'src/a.mjs' })),
    knowledgeRecords: Array.from({ length: knowledge }, (_, index) => ({ recordId: `fact-${index}`, summary: 'k'.repeat(summaryLength), revision: 1 })),
    architectureRecords: Array.from({ length: architecture }, (_, index) => ({ recordId: `arch-${index}`, summary: 'a'.repeat(summaryLength) })),
    baseline: { status: 'captured', digest: null, knownFailures: Array.from({ length: failures }, (_, index) => ({ commandRef: `cmd-${index}` })) },
  },
});

test('K1: per-list caps are enforced and every drop is reported', () => {
  const { capsule, reductions } = applyCapsuleBudget(capsuleWith({ files: 40, symbols: 50, knowledge: 30, architecture: 20, failures: 25 }));
  const repository = capsule.repositoryContext;
  assert.ok(repository);

  assert.ok(Array.isArray(repository.relevantFiles));
  assert.equal(repository.relevantFiles.length, CAPSULE_BUDGET.maxRelevantFiles);
  assert.ok(Array.isArray(repository.relevantSymbols));
  assert.equal(repository.relevantSymbols.length, CAPSULE_BUDGET.maxRelevantSymbols);
  assert.ok(Array.isArray(repository.knowledgeRecords));
  assert.equal(repository.knowledgeRecords.length, CAPSULE_BUDGET.maxKnowledgeRecords);
  assert.ok(Array.isArray(repository.architectureRecords));
  assert.equal(repository.architectureRecords.length, CAPSULE_BUDGET.maxArchitectureRecords);
  assert.ok(repository.baseline && typeof repository.baseline === 'object' && 'knownFailures' in repository.baseline && Array.isArray(repository.baseline.knownFailures));
  assert.equal(repository.baseline.knownFailures.length, CAPSULE_BUDGET.maxKnownFailures);

  const byLabel = Object.fromEntries(reductions.map((entry) => [entry.label, entry]));
  assert.equal(byLabel['relevant-file'].dropped, 20);
  assert.equal(byLabel['known-failure'].dropped, 15);
  assert.ok(reductions.every((entry) => entry.kind === 'cap'));

  // Highest-priority files survive: the ranking already ordered them.
  assert.ok(repository);
  assert.equal(repository.relevantFiles[0].path, 'src/file-000.mjs');
});

test('K1: an over-byte capsule is reduced in the declared order, not arbitrarily', () => {
  // Long summaries push the serialized capsule past the byte budget even after
  // the per-list caps have been applied.
  const oversized = capsuleWith({ files: 20, knowledge: 15, architecture: 10, failures: 10, summaryLength: 4000 });
  const { capsule, reductions, withinBudget, serializedBytes } = applyCapsuleBudget(oversized);

  assert.equal(withinBudget, true);
  assert.ok(serializedBytes <= CAPSULE_BUDGET.maxSerializedBytes);

  const budgetDrops = reductions.filter((entry) => entry.kind === 'budget');
  assert.ok(budgetDrops.length > 0, 'the reduction must be reported, never silent');
  // Semantic facts are the first thing to go; architecture and the work unit
  // outlive them.
  assert.equal(budgetDrops[0].label, CAPSULE_REDUCTION_ORDER[0].label);
  assert.ok(capsule.repositoryContext);
  assert.ok(Array.isArray(capsule.repositoryContext.knowledgeRecords));
  assert.ok(capsule.repositoryContext.knowledgeRecords.length < 15);
  assert.ok(Array.isArray(capsule.repositoryContext.relevantFiles));
  assert.equal(capsule.repositoryContext.relevantFiles.length, 20, 'files are the last context to be dropped');
});

test('K1: the same input reduces to the same capsule every time', () => {
  const input = capsuleWith({ files: 30, knowledge: 25, architecture: 15, failures: 12, summaryLength: 3000 });
  const first = applyCapsuleBudget(input);
  const second = applyCapsuleBudget(input);
  assert.deepEqual(first.capsule, second.capsule);
  assert.deepEqual(first.reductions, second.reductions);
});

test('K1: knowledge selection splits architecture from general facts and respects scope', () => {
  const knowledgeContext = {
    policyAnchors: [{ id: 'policy-1', type: 'policy_anchor', statement: 'always verify' }],
    semanticFacts: [
      { id: 'arch-1', type: 'architecture_decision', statement: 'auth is a module', scope: ['src/auth'] },
      { id: 'api-1', type: 'api_contract', statement: 'verify returns bool', scope: ['src/auth'] },
      { id: 'fail-1', type: 'known_failure_pattern', statement: 'flaky clock test', scope: ['src/auth'] },
      { id: 'fact-1', type: 'semantic_fact', statement: 'tokens expire in 1h', scope: ['src/auth'] },
      { id: 'fact-2', type: 'semantic_fact', statement: 'billing uses cents', scope: ['src/billing'] },
    ],
  };
  const selected = selectKnowledgeRecords({ knowledgeContext, allowedPaths: ['src/auth/**'] });

  assert.deepEqual(selected.architectureRecords.map((entry) => entry.recordId), ['api-1', 'arch-1']);
  assert.deepEqual(selected.knownFailurePatterns.map((entry) => entry.recordId), ['fail-1']);
  const factIds = selected.knowledgeRecords.map((entry) => entry.recordId);
  assert.ok(factIds.includes('fact-1'));
  assert.ok(factIds.includes('policy-1'), 'a global policy anchor is always in scope');
  assert.ok(!factIds.includes('fact-2'), 'knowledge scoped to another area is not this work unit s context');
});

test('K1: each file tier reduces only its own files, so scoped files outlive the rest', () => {
  const fileAt = (tier: 'scope' | 'acceptance' | 'adjacent', index: number) => ({
    path: `src/${tier}/file-${String(index).padStart(2, '0')}.mjs`,
    reason: {
      scope: 'inside the work unit scope',
      acceptance: 'named by the acceptance criteria',
      adjacent: 'adjacent to a changed path',
    }[tier],
    digest: null,
    // Padding so dropping files is what actually moves the byte total.
    note: 'x'.repeat(8000),
  });
  const capsule = {
    schemaVersion: 1,
    runId: 'r-tier',
    role: 'implementer',
    repositoryContext: {
      relevantFiles: [
        ...Array.from({ length: 6 }, (_, i) => fileAt('scope', i)),
        ...Array.from({ length: 6 }, (_, i) => fileAt('acceptance', i)),
        ...Array.from({ length: 6 }, (_, i) => fileAt('adjacent', i)),
      ],
      relevantSymbols: [],
      knowledgeRecords: [],
      architectureRecords: [],
      baseline: { status: 'captured', digest: null, knownFailures: [] },
    },
  };

  const { capsule: reduced, reductions } = applyCapsuleBudget(capsule);
  assert.ok(reduced.repositoryContext && Array.isArray(reduced.repositoryContext.relevantFiles));
  const survivingReasons = reduced.repositoryContext.relevantFiles.map((file: unknown) => { assert.ok(file && typeof file === 'object' && 'reason' in file); return file.reason; });
  const labels = reductions.filter((entry) => entry.kind === 'budget').map((entry) => entry.label);

  // Adjacent files go first and are reported as such; work-unit scope survives.
  assert.ok(!survivingReasons.includes('adjacent to a changed path'), JSON.stringify(survivingReasons));
  assert.ok(survivingReasons.includes('inside the work unit scope'));
  assert.deepEqual(labels, ['adjacent-file', 'acceptance-file'], JSON.stringify(reductions));
  const dropped = Object.fromEntries(reductions.filter((entry) => entry.kind === 'budget').map((entry) => [entry.label, entry.dropped]));
  assert.equal(dropped['adjacent-file'], 6, 'the adjacent tier drops only adjacent files');
});
