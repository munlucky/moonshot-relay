import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveArchitectureKnowledge } from '../src/kernel/knowledge/architecture-resolve.js';

test('resolveArchitectureKnowledge resolves active ADRs and ranks by path relevance', async () => {
  const stateStore = {
    listKnowledgeRecords: () => [
      { id: 'f1', projectId: 'proj-arch', type: 'semantic_fact', statement: 'ADR-0001: Use SQLite for state persistence', sourceRef: 'ADR/ADR-0001.md', status: 'verified', trustTier: 'verified' },
      { id: 'f2', projectId: 'proj-arch', type: 'semantic_fact', statement: 'ADR-0002: Superseded choice', sourceRef: 'ADR/ADR-0002.md', status: 'superseded', trustTier: 'verified' },
    ],
  };

  const res = await resolveArchitectureKnowledge({
    projectId: 'proj-arch',
    objective: 'SQLite persistence',
    stateStore,
  });
  assert.equal(res.architectureDecisions.length, 1);
  assert.equal(res.architectureDecisions[0].id, 'f1');
});
