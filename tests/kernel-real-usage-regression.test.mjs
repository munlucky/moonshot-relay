import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openKernelStateStore } from '../scripts/kernel/state-store.mjs';
import { openSqliteDb } from '../scripts/kernel/sqlite-adapter.mjs';
import { test } from 'node:test';
const fixtureUrl = new URL('./fixtures/kernel-real-usage/scenarios.json', import.meta.url);
const baselineUrl = new URL('../docs/decomplexification/kernel-authority-refactor-baseline.json', import.meta.url);

const readJson = async (url) => JSON.parse(await readFile(url, 'utf8'));

// The standard Node runner executes each mapped suite in its own process.
// This assertion prevents a provenance-only corpus from silently dropping its
// behavioral registrations when the npm command changes.
test('every corpus regression suite is registered in the native reliability command', async () => {
  const corpus = await readJson(fixtureUrl);
  const manifest = await readJson(new URL('../package.json', import.meta.url));
  const registered = new Set(manifest.scripts['test:kernel-reliability'].split(/\s+/));
  for (const scenario of corpus.scenarios) {
    assert.ok(scenario.regressionTests.length > 0, scenario.id);
    for (const file of scenario.regressionTests) {
      assert.match(file, /^kernel-[a-z0-9-]+\.test\.mjs$/);
      assert.ok(registered.has(`tests/${file}`), `${scenario.id}: ${file} is not registered`);
    }
    assert.ok(scenario.behavioralCases.length > 0, `${scenario.scenarioId}: no fault assertions are mapped`);
    for (const entry of scenario.behavioralCases) {
      assert.ok(scenario.regressionTests.includes(entry.file));
      const source = await readFile(new URL(`./${entry.file}`, import.meta.url), 'utf8');
      assert.ok(source.includes(`test('${entry.name}'`), `${scenario.scenarioId}: behavioral case disappeared: ${entry.name}`);
    }
  }
});

test('Wave 18: lifecycle journal is atomic, append-only, replay-safe, and never progress authority', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-journal-'));
  let store;
  let raw;
  try {
    store = await openKernelStateStore({ runtimeHome });
    store.createRun({ runId: 'journal-run', objective: 'private objective is not journal content', sourceIdentity: 'source-journal' });
    store.createRunSteps('journal-run', [{ stepId: 'work-a', sequence: 1, objective: 'bounded work', state: 'ready', planRevision: 1 }]);
    store.updateRunStep('journal-run', 'work-a', { state: 'running' });
    store.updateRunStep('journal-run', 'work-a', { state: 'passed' });
    store.updateRunStep('journal-run', 'work-a', { state: 'passed' });
    store.transition('journal-run', 'EXECUTE');
    store.transition('journal-run', 'PROVE');
    store.recordVerification('journal-run', {
      status: 'passed', evidenceRef: 'evidence://journal/1', command: 'npm test',
      evidenceDigest: `sha256:${'a'.repeat(64)}`, sourceIdentity: 'source-journal',
    });
    store.recordCompletionDecision('journal-run', {
      decision: 'accepted', sourceIdentity: 'source-journal', mutationRevision: 0,
      evidenceDigest: `sha256:${'a'.repeat(64)}`, decisionJson: {},
    });
    store.recordKnowledgeCommitReceipt('journal-run', {
      projectId: 'journal-project', revisionBefore: 0, revisionAfter: 1, receiptJson: {},
    });
    const before = store.getRunJournal('journal-run');
    assert.deepEqual(before.map((entry) => entry.kind), [
      'task-created', 'work-started', 'work-completed', 'evidence-produced', 'completion-decided', 'knowledge-committed',
    ]);
    assert.doesNotMatch(JSON.stringify(before), /private objective|bounded work/);
    const progress = store.getKernelDurableState('journal-run');
    store.close();
    store = await openKernelStateStore({ runtimeHome });
    assert.deepEqual(store.getRunJournal('journal-run'), before);
    assert.deepEqual(store.getKernelDurableState('journal-run'), progress);

    raw = await openSqliteDb(store.dbPath);
    assert.throws(() => raw.exec("UPDATE run_journal SET kind='fake'"), /run_journal_append_only/);
    assert.throws(() => raw.exec('DELETE FROM run_journal'), /run_journal_append_only/);
    raw.exec('BEGIN');
    raw.exec("UPDATE runs SET contract_revision=contract_revision+1 WHERE run_id='journal-run'");
    raw.exec('ROLLBACK');
    assert.deepEqual(store.getRunJournal('journal-run'), before, 'rolled-back authority writes leave no audit fact');
    assert.deepEqual(store.getKernelDurableState('journal-run'), progress);
    raw.exec("UPDATE runs SET contract_revision=contract_revision+1 WHERE run_id='journal-run'");
    assert.equal(store.getRunJournal('journal-run').at(-1).kind, 'contract-revised');
  } finally {
    raw?.close();
    store?.close();
    await rm(runtimeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('real-usage corpus keeps exactly S-01 through S-20 with explicit provenance classification', async () => {
  const fixture = await readJson(fixtureUrl);
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.scenarioCount, 20);
  assert.equal(fixture.scenarios.length, 20);
  const expected = Array.from({ length: 20 }, (_, index) => `S-${String(index + 1).padStart(2, '0')}`);
  assert.deepEqual(fixture.scenarios.map((entry) => entry.scenarioId), expected);
  const allowed = new Set(['defect', 'expected-guard', 'environment', 'recovered', 'design-requirement']);
  for (const scenario of fixture.scenarios) {
    assert.ok(allowed.has(scenario.classification), `unsupported classification for ${scenario.scenarioId}`);
    assert.match(scenario.ownerWorkUnit, /^W-(?:0[1-9]|1[0-9]|2[0-4])$/);
    assert.ok(String(scenario.expectedContract || '').length > 20);
    if (scenario.classification !== 'design-requirement') {
      assert.ok(scenario.source?.sessionId, `${scenario.scenarioId} needs session provenance`);
      assert.match(String(scenario.source?.fileSha256 || ''), /^[a-f0-9]{64}$/);
      assert.ok(Number.isInteger(scenario.source?.callLine) && scenario.source.callLine > 0);
    }
    assert.ok(scenario.observedVersion && typeof scenario.observedVersion === 'object');
    assert.ok(scenario.regressionTests.length > 0, `${scenario.scenarioId} must execute a regression`);
    assert.equal('excerpt' in scenario, false);
    assert.equal('transcript' in scenario, false);
  }
});

test('real-usage corpus preserves observed failure families without copying transcripts', async () => {
  const fixture = await readJson(fixtureUrl);
  const observedNames = new Set(
    fixture.scenarios.filter((entry) => ['defect', 'expected-guard', 'environment', 'recovered'].includes(entry.classification)).map((entry) => entry.name),
  );
  for (const required of [
    'worktree-mismatch',
    'parallel-session-conflict',
    'reviewer-bridge-missing',
    'review-transport-failure',
    'duplicate-reviewer-race',
    'subagent-dispatch-failure',
  ]) {
    assert.ok(observedNames.has(required), `missing observed family: ${required}`);
  }
  const serialized = JSON.stringify(fixture);
  assert.doesNotMatch(serialized, /invocationExcerpt|replacement_history|response_item|custom_tool_call_output/);
});

test('historical refactor baseline records user changes, Host surface and complexity budget', async () => {
  const baseline = await readJson(baselineUrl);
  assert.equal(baseline.baselineCommit, 'aca19ec85cf06f40860e07ef5006b37b02f7a260');
  assert.equal(baseline.userChanges.length, 6);
  for (const change of baseline.userChanges) {
    assert.match(change.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(baseline.userChangesVerification.matchedFiles, baseline.userChanges.length);
  assert.equal(baseline.userChangesVerification.refactorWorktreeUsesFixedCommit, true);
  assert.equal(baseline.refactorProtectedFiles.length, 6);
  for (const change of baseline.refactorProtectedFiles) {
    assert.match(change.sha256Lf, /^[a-f0-9]{64}$/);
    assert.equal(change.sourceCommit, baseline.baselineCommit);
  }
  assert.deepEqual(baseline.canonicalAuthorities, ['work', 'trust', 'knowledge']);
  assert.equal(baseline.hosts.find((host) => host.id === 'codex')?.state, 'implemented');
  assert.equal(baseline.hosts.find((host) => host.id === 'gemini')?.state, 'not-implemented-at-baseline');
  assert.deepEqual(baseline.constraints, {
    newCanonicalDb: 0,
    newWorkflowEngine: 0,
    newPluginFramework: 0,
    providerSpecificKernelExecutionPolicyBranches: 0,
    silentFallback: 0,
  });
});

test('historical protected-file hashes match their recorded immutable commit', async (t) => {
  const baseline = await readJson(baselineUrl);
  const options = { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', windowsHide: true };
  const available = spawnSync('git', ['cat-file', '-e', `${baseline.baselineCommit}^{commit}`], options);
  if (available.status !== 0) {
    t.skip('Historical commit is unavailable in this source export or shallow checkout.');
    return;
  }
  // This artifact describes a past refactor. Comparing it with today's source
  // or a machine-specific workspace would freeze unrelated future changes.
  // Current behavior is covered by the registered reliability suites; generated
  // output integrity is covered by build:check and source-runtime tests.
  for (const change of baseline.refactorProtectedFiles) {
    const original = spawnSync('git', ['show', `${change.sourceCommit}:${change.file}`], options);
    assert.equal(original.status, 0, original.stderr);
    const bytes = original.stdout.replaceAll('\r\n', '\n');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), change.sha256Lf, `historical bytes: ${change.file}`);
  }
});
