import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openKernelStateStore, kernelDbPath } from '../scripts/kernel/state-store.mjs';
import { openSqliteDb } from '../scripts/kernel/sqlite-adapter.mjs';

const withRuntime = async (fn) => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-report-migration-'));
  try {
    await fn(runtimeHome);
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
  }
};

const seedRunAndStep = async (runtimeHome, runId) => {
  const store = await openKernelStateStore({ runtimeHome });
  try {
    store.createRun({ runId, objective: 'report migration fixture', sourceIdentity: 'fixture-source' });
    store.replaceRunPlanAtomic(runId, {
      currentPlanRevision: 1,
      nextPlanRevision: 1,
      steps: [{
        stepId: `${runId}-step`,
        sequence: 1,
        objective: 'fixture step',
        state: 'ready',
        planRevision: 1,
      }],
    });
  } finally {
    store.close();
  }
};

const insertAttempt = async (runtimeHome, {
  runId,
  attemptId,
  attemptNumber,
  status,
  reportDigest = null,
  reportKey = null,
  reportPayloadDigest = null,
  reportResultJson = null,
}) => {
  const db = await openSqliteDb(kernelDbPath(runtimeHome));
  try {
    db.prepare(`
      INSERT INTO run_step_attempts(
        attempt_id, run_id, step_id, attempt_number, provenance_kind,
        plan_revision, mutation_revision, status,
        changed_paths_json, failure_reasons_json,
        verification_refs_json, knowledge_observation_refs_json,
        started_at, finished_at,
        report_digest, report_key, report_payload_digest, report_result_json
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      attemptId,
      runId,
      `${runId}-step`,
      attemptNumber,
      'legacy-unattributed',
      1,
      0,
      status,
      '[]',
      '[]',
      '[]',
      '[]',
      '2026-10-05T00:00:00.000Z',
      status === 'started' ? null : '2026-10-05T00:01:00.000Z',
      reportDigest,
      reportKey,
      reportPayloadDigest,
      reportResultJson,
    );
  } finally {
    db.close?.();
  }
};

test('W-05: terminal legacy report identity migrates to explicit legacy key and preserves durable response', async () => {
  await withRuntime(async (runtimeHome) => {
    const runId = 'migration-terminal';
    await seedRunAndStep(runtimeHome, runId);
    await insertAttempt(runtimeHome, {
      runId,
      attemptId: 'attempt-terminal',
      attemptNumber: 1,
      status: 'passed',
      reportDigest: 'legacy-payload-hash',
      reportResultJson: JSON.stringify({ status: 'completed', value: 7 }),
    });

    const reopened = await openKernelStateStore({ runtimeHome });
    try {
      const attempt = reopened.getStepAttemptByAttemptId('attempt-terminal', { runId });
      assert.match(attempt.reportKey || '', /^legacy:\d+:legacy-payload-hash$/);
      assert.equal(attempt.reportPayloadDigest, null);
      assert.deepEqual(attempt.reportResult, { status: 'completed', value: 7 });
    } finally {
      reopened.close();
    }

    const raw = await openSqliteDb(kernelDbPath(runtimeHome));
    try {
      const row = raw.prepare('SELECT report_digest AS reportDigest FROM run_step_attempts WHERE attempt_id=?').get('attempt-terminal');
      assert.equal(row.reportDigest, null);
    } finally {
      raw.close?.();
    }
  });
});

test('W-05: active legacy report digest is discarded instead of becoming a false operation identity', async () => {
  await withRuntime(async (runtimeHome) => {
    const runId = 'migration-active';
    await seedRunAndStep(runtimeHome, runId);
    await insertAttempt(runtimeHome, {
      runId,
      attemptId: 'attempt-active',
      attemptNumber: 1,
      status: 'started',
      reportDigest: 'legacy-inflight-payload-hash',
    });

    const reopened = await openKernelStateStore({ runtimeHome });
    try {
      const attempt = reopened.getStepAttemptByAttemptId('attempt-active', { runId });
      assert.equal(attempt.reportKey, null);
      assert.equal(attempt.reportPayloadDigest, null);
    } finally {
      reopened.close();
    }

    const raw = await openSqliteDb(kernelDbPath(runtimeHome));
    try {
      const row = raw.prepare('SELECT report_digest AS reportDigest FROM run_step_attempts WHERE attempt_id=?').get('attempt-active');
      assert.equal(row.reportDigest, null);
    } finally {
      raw.close?.();
    }
  });
});

test('W-05: report identity data migration rolls back atomically when the new uniqueness invariant cannot be installed', async () => {
  await withRuntime(async (runtimeHome) => {
    const runId = 'migration-rollback';
    await seedRunAndStep(runtimeHome, runId);
    const raw = await openSqliteDb(kernelDbPath(runtimeHome));
    try {
      raw.exec('DROP INDEX IF EXISTS uq_run_step_attempts_report_key');
    } finally {
      raw.close?.();
    }

    await insertAttempt(runtimeHome, {
      runId,
      attemptId: 'attempt-a',
      attemptNumber: 1,
      status: 'passed',
      reportDigest: 'legacy-a',
      reportKey: 'duplicate-operation-key',
    });
    await insertAttempt(runtimeHome, {
      runId,
      attemptId: 'attempt-b',
      attemptNumber: 2,
      status: 'passed',
      reportDigest: 'legacy-b',
      reportKey: 'duplicate-operation-key',
    });

    await assert.rejects(
      () => openKernelStateStore({ runtimeHome }),
      /UNIQUE|constraint/i,
    );

    const verify = await openSqliteDb(kernelDbPath(runtimeHome));
    try {
      const rows = verify.prepare(`
        SELECT attempt_id AS attemptId, report_digest AS reportDigest, report_key AS reportKey
        FROM run_step_attempts
        WHERE run_id=?
        ORDER BY attempt_number
      `).all(runId).map((row) => ({ ...row }));
      assert.deepEqual(rows, [
        { attemptId: 'attempt-a', reportDigest: 'legacy-a', reportKey: 'duplicate-operation-key' },
        { attemptId: 'attempt-b', reportDigest: 'legacy-b', reportKey: 'duplicate-operation-key' },
      ]);
      const indexes = verify.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='uq_run_step_attempts_report_key'").all();
      assert.equal(indexes.length, 0);
    } finally {
      verify.close?.();
    }
  });
});
