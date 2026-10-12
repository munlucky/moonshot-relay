import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTacitPractices } from '../src/kernel/knowledge/tacit-resolve.js';

test('resolveTacitPractices requires >= 2 distinct runs and verification evidence', async () => {
  const stateStore = {
    listKnowledgeRecords: () => [
      { id: 'o1', runId: 'run-1', projectId: 'proj-tacit', type: 'episodic_observation', statement: 'Always use atomic rename for JSONL files', status: 'verified', evidence: { pass: true }, trustTier: 'quarantined' },
      { id: 'o2', runId: 'run-2', projectId: 'proj-tacit', type: 'episodic_observation', statement: 'Always use atomic rename for JSONL files', status: 'observed', trustTier: 'quarantined' },
    ],
  };

  const practices = await resolveTacitPractices({
    projectId: 'proj-tacit',
    stateStore,
  });
  assert.equal(practices.length, 1);
  assert.equal(practices[0].statement, 'Always use atomic rename for JSONL files');
  assert.equal(practices[0].observedRuns.length, 2);
});
