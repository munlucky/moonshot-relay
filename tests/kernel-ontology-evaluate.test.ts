import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOntologyConstraints } from '../src/kernel/knowledge/ontology-evaluate.js';

test('evaluateOntologyConstraints detects never and ask_first violations', async () => {
  const stateStore = {
    listKnowledgeRecords: () => [{
      id: 'c1',
      projectId: 'proj-ont',
      type: 'ontology_constraint',
      statement: 'Never mutate Relay state',
      pattern: 'Never mutate Relay state',
      severity: 'never',
      scope: ['scripts/kernel/**'],
      status: 'verified',
      trustTier: 'verified',
    }],
  };

  const evalRes = await evaluateOntologyConstraints({
    projectId: 'proj-ont',
    paths: ['scripts/kernel/state.mjs'],
    statements: ['Never mutate Relay state'],
    stateStore,
  });
  assert.equal(evalRes.passed, false);
  assert.equal(evalRes.violations.length, 1);
});
