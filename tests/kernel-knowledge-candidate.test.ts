import test from 'node:test';
import assert from 'node:assert/strict';
import { extractKnowledgeCandidates } from '../src/kernel/knowledge/candidate-extract.js';

test('extractKnowledgeCandidates extracts candidates and filters secret leaks', () => {
  const candidates = extractKnowledgeCandidates({
    runId: 'run-101',
    projectId: 'test-proj',
    changedFiles: ['scripts/test.mjs'],
    evidencePack: { status: 'pass', digest: 'dig-1' },
    observedStatements: [
      'SQLite WAL mode is enabled by default.',
      'API key sk-12345678901234567890 leaked in log',
    ],
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].statement, 'SQLite WAL mode is enabled by default.');
});
