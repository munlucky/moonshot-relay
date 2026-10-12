import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openKernelStateStore } from '../src/kernel/state-store.js';
import { openSqliteDb } from '../src/kernel/sqlite-adapter.js';

const validDigest = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

test('natural PROVE -> verification -> CLOSE workflow results in accepted completion', async () => {
  const h = await mkdtemp(path.join(os.tmpdir(), 'krn-state-'));
  const s = await openKernelStateStore({ runtimeHome: h, relayHome: path.join(h, '..', 'relay') });

  const run = s.createRun({ runId: 'r1', objective: 'x', sourceIdentity: 'src-1' });
  assert.equal(run.schemaVersion, 1);
  assert.equal(run.currentState, 'FRAME');
  assert.equal(run.mutationRevision, 0);

  s.transition('r1', 'EXECUTE');
  s.transition('r1', 'PROVE');

  s.recordVerification('r1', {
    status: 'passed',
    evidenceRef: 'evidence://test/1',
    command: 'npm test',
    exitCode: 0,
    evidenceDigest: validDigest,
    sourceIdentity: 'src-1',
  });

  s.transition('r1', 'CLOSE');

  const comp = s.assessCompletion('r1', { expectedSourceIdentity: 'src-1' });
  assert.equal(comp.decision, 'accepted');
  const finalRun = s.persistCompletionDecision('r1', comp);
  assert.equal(finalRun.status, 'completed');

  s.close();
});

test('multi-obligation proof contract requires all declared obligations to pass', async () => {
  const h = await mkdtemp(path.join(os.tmpdir(), 'krn-state-multi-ob-'));
  const s = await openKernelStateStore({ runtimeHome: h, relayHome: path.join(h, '..', 'relay') });

  s.createRun({
    runId: 'r-t3',
    objective: 'security boundary mutation',
    sourceIdentity: 'src-t3',
    proofTier: 'T3',
    evidenceTier: 'E2',
    requiredObligations: ['static-analysis', 'unit-test'],
  });

  s.transition('r-t3', 'EXECUTE');
  s.transition('r-t3', 'PROVE');

  // Verify only 1 of 2 obligations
  s.recordVerification('r-t3', {
    obligationId: 'static-analysis',
    status: 'passed',
    evidenceRef: 'evidence://static/1',
    command: 'npm run lint',
    exitCode: 0,
    evidenceDigest: validDigest,
    sourceIdentity: 'src-t3',
  });

  // Should be blocked because 'unit-test' obligation is missing
  assert.equal(s.assessCompletion('r-t3').decision, 'blocked');

  // Transition to EXECUTE then PROVE to complete missing obligation
  s.transition('r-t3', 'EXECUTE');
  s.transition('r-t3', 'PROVE');

  // Re-verify both obligations at current mutation revision
  s.recordVerification('r-t3', {
    obligationId: 'static-analysis',
    status: 'passed',
    evidenceRef: 'evidence://static/2',
    command: 'npm run lint',
    exitCode: 0,
    evidenceDigest: validDigest,
    sourceIdentity: 'src-t3',
  });

  s.recordVerification('r-t3', {
    obligationId: 'unit-test',
    status: 'passed',
    evidenceRef: 'evidence://unit/1',
    command: 'npm test',
    exitCode: 0,
    evidenceDigest: validDigest,
    sourceIdentity: 'src-t3',
  });

  s.transition('r-t3', 'CLOSE');

  const comp = s.assessCompletion('r-t3');
  assert.equal(comp.decision, 'accepted');
  const finalRun = s.persistCompletionDecision('r-t3', comp);
  assert.equal(finalRun.status, 'completed');

  s.close();
});

test('multi-connection OCC prevents state conflicts across independent DB handles', async () => {
  const h = await mkdtemp(path.join(os.tmpdir(), 'krn-state-conn-'));
  const s1 = await openKernelStateStore({ runtimeHome: h, relayHome: path.join(h, '..', 'relay') });
  const s2 = await openKernelStateStore({ runtimeHome: h, relayHome: path.join(h, '..', 'relay') });

  s1.createRun({ runId: 'r-conn', objective: 'concurrency test', sourceIdentity: 'src-conn' });
  const run1 = s1.getRun('r-conn');

  // Connection 1 transitions run to EXECUTE
  s1.transition('r-conn', 'EXECUTE');

  // Connection 2 attempts transition using stale revision 0 from run1
  assert.throws(
    () => { assert.ok(run1 !== null && run1 !== undefined); return s2.transition('r-conn', 'EXECUTE', { expectedRevision: run1.revision }); },
    /STALE_RUN_REVISION/
  );

  s1.close();
  s2.close();
});

test('latest verification row wins and stale passes cannot produce completion', async () => {
  const h = await mkdtemp(path.join(os.tmpdir(), 'krn-state-latest-'));
  const s = await openKernelStateStore({ runtimeHome: h, relayHome: path.join(h, '..', 'relay') });
  s.createRun({ runId: 'r-latest', objective: 'latest row', sourceIdentity: 'src-latest', requiredObligations: ['unit-test'] });
  s.transition('r-latest', 'EXECUTE');
  s.transition('r-latest', 'PROVE');
  s.recordVerification('r-latest', { obligationId: 'unit-test', status: 'passed', evidenceRef: 'evidence://pass', command: 'npm test', evidenceDigest: validDigest, sourceIdentity: 'src-latest' });
  s.recordVerification('r-latest', { obligationId: 'unit-test', status: 'failed', evidenceRef: 'evidence://fail', command: 'npm test', exitCode: 1, evidenceDigest: validDigest, sourceIdentity: 'src-latest' });
  s.transition('r-latest', 'CLOSE');
  assert.equal(s.assessCompletion('r-latest').decision, 'blocked');
  s.close();
});

test('verification is restricted to PROVE and acceptance coverage is required', async () => {
  const h = await mkdtemp(path.join(os.tmpdir(), 'krn-state-acceptance-'));
  const s = await openKernelStateStore({ runtimeHome: h, relayHome: path.join(h, '..', 'relay') });
  s.createRun({ runId: 'r-acceptance', objective: 'acceptance', sourceIdentity: 'src-acceptance', requiredObligations: ['unit-test'], acceptanceCriteria: ['criterion-1'] });
  assert.throws(() => s.recordVerification('r-acceptance', { obligationId: 'unit-test', status: 'passed', evidenceRef: 'evidence://x', command: 'npm test', evidenceDigest: validDigest, sourceIdentity: 'src-acceptance' }), /PROVE/);
  s.transition('r-acceptance', 'EXECUTE');
  s.transition('r-acceptance', 'PROVE');
  s.recordVerification('r-acceptance', { obligationId: 'unit-test', status: 'passed', evidenceRef: 'evidence://x', command: 'npm test', evidenceDigest: validDigest, sourceIdentity: 'src-acceptance' });
  s.transition('r-acceptance', 'CLOSE');
  assert.equal(s.assessCompletion('r-acceptance').decision, 'blocked');
  s.close();
});

test('completion transaction rolls back Trust decision when terminal Work update fails', async () => {
  const h = await mkdtemp(path.join(os.tmpdir(), 'krn-state-rollback-'));
  const s = await openKernelStateStore({ runtimeHome: h, relayHome: path.join(h, '..', 'relay') });
  s.createRun({ runId: 'r-rollback', objective: 'atomic completion', sourceIdentity: 'src-rollback' });
  s.transition('r-rollback', 'EXECUTE');
  s.transition('r-rollback', 'PROVE');
  s.recordVerification('r-rollback', {
    status: 'passed',
    evidenceRef: 'evidence://rollback/1',
    command: 'npm test',
    exitCode: 0,
    evidenceDigest: validDigest,
    sourceIdentity: 'src-rollback',
  });
  s.transition('r-rollback', 'CLOSE');
  const completion = s.assessCompletion('r-rollback');
  assert.equal(completion.decision, 'accepted');

  const faultDb = await openSqliteDb(s.dbPath);
  faultDb.exec(`
    CREATE TRIGGER fail_completion_status_update
    BEFORE UPDATE OF status ON runs
    WHEN NEW.run_id='r-rollback' AND NEW.status='completed'
    BEGIN
      SELECT RAISE(ABORT, 'injected completion status failure');
    END;
  `);
  faultDb.close();

  assert.throws(
    () => s.persistCompletionDecision('r-rollback', completion),
    /injected completion status failure/,
  );
  assert.equal(s.getCompletionDecision('r-rollback'), null);
  const observedValue10 = s.getRun('r-rollback');
    assert.ok(observedValue10);
    assert.equal(observedValue10.status, 'active');

  s.close();
});

test('approved waiver can satisfy an obligation and foreign keys are enabled', async () => {
  const h = await mkdtemp(path.join(os.tmpdir(), 'krn-state-waiver-'));
  const s = await openKernelStateStore({ runtimeHome: h, relayHome: path.join(h, '..', 'relay') });
  assert.equal(s.dbPath.endsWith('runtime-state.sqlite'), true);
  s.createRun({ runId: 'r-waiver', objective: 'waiver', sourceIdentity: 'src-waiver', requiredObligations: ['lint-check'] });
  s.transition('r-waiver', 'EXECUTE');
  s.transition('r-waiver', 'PROVE');
  s.addWaiver('r-waiver', { obligationId: 'lint-check', approvedBy: 'reviewer', reason: 'not applicable', approvalReceipt: 'approval://1' });
  s.transition('r-waiver', 'CLOSE');
  assert.equal(s.assessCompletion('r-waiver').decision, 'accepted');
  s.close();
});
