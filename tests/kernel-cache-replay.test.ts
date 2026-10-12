import test from 'node:test';
import assert from 'node:assert/strict';
import { runCacheReplay, loadFixtures, replayFixture } from '../src/host/kernel/cache-replay.js';

test('the corpus covers every declared replay scenario', async () => {
  const names = (await loadFixtures()).map((fixture) => fixture.name).sort();
  assert.deepEqual(names, [
    'cross-run', 'escalation', 'evidence-change', 'project-knowledge-change',
    'reviewer', 'same-run', 'step-change', 'task-knowledge-change',
  ]);
});

test('every fixture behaves as its declaration says, on both providers', async () => {
  const report = await runCacheReplay();
  assert.equal(report.failures.length, 0, JSON.stringify(report.failures, null, 2));
  assert.equal(report.results.length, 16);
});

test('a repeated implement turn reuses the whole prefix', async () => {
  const fixtures = await loadFixtures();
  const fixture = fixtures.find((f) => f.name === 'same-run');
  assert.ok(fixture);
  const result = replayFixture(fixture);
  assert.equal(result.prefixStable, true);
  assert.deepEqual(result.changedSegments, []);
  assert.equal(result.sessionContinued, true);
});

test('step, evidence, and task-knowledge changes touch only the tail', async () => {
  const fixtures = await loadFixtures();
  for (const name of ['step-change', 'evidence-change', 'task-knowledge-change']) {
    const fixture = fixtures.find((f) => f.name === name);
    assert.ok(fixture);
    const result = replayFixture(fixture);
    assert.deepEqual(result.changedSegments, ['volatile'], name);
    assert.equal(result.prefixStable, true, name);
    assert.equal(result.sessionContinued, true, name);
  }
});

test('a reviewer turn and an effort escalation change no bytes but do reset the lineage', async () => {
  const fixtures = await loadFixtures();
  for (const name of ['reviewer', 'escalation']) {
    const fixture = fixtures.find((f) => f.name === name);
    assert.ok(fixture);
    const result = replayFixture(fixture);
    assert.deepEqual(result.changedSegments, [], name);
    assert.equal(result.prefixStable, false, name);
    assert.equal(result.sessionContinued, false, name);
    assert.ok(result.sessionResetReasons.length > 0, name);
  }
});

test('the replay reports the cacheable prefix size it measured', async () => {
  const fixtures = await loadFixtures();
  const fixture = fixtures.find((f) => f.name === 'same-run');
  assert.ok(fixture);
  const result = replayFixture(fixture);
  assert.ok(result.eligiblePrefixTokens > 0);
  assert.ok(result.volatileTokens >= 0);
  // The whole point of the layout: the reusable prefix dominates the tail.
  assert.ok(result.eligiblePrefixTokens > result.volatileTokens);
});

test('the replay runs in shadow by default', async () => {
  const report = await runCacheReplay({ env: {} });
  assert.equal(report.modes.cacheMode, 'shadow');
  assert.equal(report.modes.claude, 'shadow');
  assert.equal(report.modes.codex, 'shadow');
});
