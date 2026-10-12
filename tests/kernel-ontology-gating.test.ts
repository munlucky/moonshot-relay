import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOntologyConstraints } from '../src/kernel/knowledge/ontology-evaluate.js';

test('evaluateOntologyConstraints handles never, ask_first, and invariant severity rules', async () => {
  const stateStore = {
    listKnowledgeRecords: () => [
      { id: 'c1', projectId: 'proj-ont-gate', type: 'ontology_constraint', statement: 'Never mutate Relay state', pattern: 'mutate Relay state', severity: 'never', scope: ['scripts/kernel/**'], status: 'verified', trustTier: 'verified' },
      { id: 'c2', projectId: 'proj-ont-gate', type: 'ontology_constraint', statement: 'Ask before modifying core schemas', severity: 'ask_first', scope: ['schemas/**'], status: 'verified', trustTier: 'verified' },
    ],
  };

  const evalRes = await evaluateOntologyConstraints({
    projectId: 'proj-ont-gate',
    paths: ['scripts/kernel/state.mjs', 'schemas/test.json'],
    statements: ['mutate Relay state'],
    stateStore,
  });

  assert.equal(evalRes.passed, false);
  assert.equal(evalRes.violations.length, 1);
  assert.equal(evalRes.approvalRequired.length, 1);
});
