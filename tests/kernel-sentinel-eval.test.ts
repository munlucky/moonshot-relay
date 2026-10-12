import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { runSentinelEvaluation } from '../src/host-tooling/kernel-eval/sentinel-eval.js';

const corpus: { schemaVersion: number; taskSetRevision: string; cases: { id: string; trap: string; expect: "accept" | "reject"; rationale: string }[] } = JSON.parse(await readFile(new URL('./fixtures/kernel-sentinel/corpus.json', import.meta.url), 'utf8'));

test('sentinel corpus is fixed and revision-stamped', () => {
  assert.equal(corpus.schemaVersion, 1);
  assert.ok(corpus.taskSetRevision);
  assert.ok(corpus.cases.length >= 8);
  assert.ok(corpus.cases.some((c) => c.expect === 'accept'), 'must include a positive control');
  assert.ok(corpus.cases.filter((c) => c.expect === 'reject').length >= 6);
  for (const c of corpus.cases) {
    assert.match(c.id, /^SEN-\d{3}$/);
    assert.ok(['accept', 'reject'].includes(c.expect));
    assert.ok(c.rationale);
  }
});

test('Kernel produces zero false completions on the sentinel set and records provenance', async () => {
  const report = await runSentinelEvaluation({ corpus, seed: 1 });
  assert.equal(report.falseCompletions, 0, JSON.stringify(report.results.filter((r) => r.falseCompletion)));
  assert.equal(report.missedAccepts, 0, JSON.stringify(report.results.filter((r) => r.missedAccept)));
  // Provenance the promotion gate requires (짠26).
  assert.equal(report.taskSetRevision, corpus.taskSetRevision);
  assert.ok(report.kernelRevision);
  assert.equal(report.seed, 1);
  assert.equal(report.caseCount, corpus.cases.length);
});
