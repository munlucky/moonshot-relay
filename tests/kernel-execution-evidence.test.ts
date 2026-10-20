import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  attributeExecutionUsage,
  projectExecutionEvidence,
} from '../src/host-tooling/kernel-eval/execution-evidence.js';

const run = {
  runId: 'run-a',
  contractRevision: 3,
  sourceIdentity: 'source-a',
  workspaceId: 'workspace-a',
  currentWorkspaceIdentity: 'workspace-identity-a',
};

test('owner-session attempt without usage receipt remains execution evidence, not telemetry failure', () => {
  const [view] = projectExecutionEvidence({
    runs: [run],
    attempts: [{
      runId: 'run-a',
      attemptId: 'attempt-owner',
      provenanceKind: 'owner-session',
      actorSessionId: 'session-owner',
      usageReceiptId: null,
      contractRevision: 3,
      planRevision: 4,
      mutationRevision: 7,
      status: 'completed',
    }],
  });
  assert.ok(view);
  assert.equal(view.provenanceKind, 'owner-session');
  assert.equal(view.actorSessionIdPresent, true);
  assert.equal(view.usageAttributionStatus, 'owner-session-unattributed-cost');
  assert.equal(view.executionIdentity, 'run-a:contract-3:plan-4:mutation-7');
});

test('routed and kernel-owned attempts with usage receipts remain receipt-attributed', () => {
  const views = projectExecutionEvidence({
    runs: [run],
    attempts: [
      {
        runId: 'run-a',
        attemptId: 'attempt-routed',
        provenanceKind: 'routed',
        actorSessionId: 'session-routed',
        usageReceiptId: 'receipt-routed',
        planRevision: 4,
        mutationRevision: 7,
      },
      {
        runId: 'run-a',
        attemptId: 'attempt-kernel',
        provenanceKind: 'kernel-owned',
        actorSessionId: 'session-kernel',
        usageReceiptId: 'receipt-kernel',
        planRevision: 4,
        mutationRevision: 7,
      },
    ],
  });
  assert.deepEqual(views.map((view) => view.usageAttributionStatus), [
    'receipt-attributed',
    'receipt-attributed',
  ]);
});

test('legacy attempt stays explicitly unattributed and does not invent revision lineage', () => {
  const [view] = projectExecutionEvidence({
    runs: [run],
    attempts: [{
      runId: 'run-a',
      provenanceKind: 'legacy-unattributed',
      planRevision: null,
      mutationRevision: null,
      status: 'failed',
    }],
  });
  assert.ok(view);
  assert.equal(view.usageAttributionStatus, 'legacy-unattributed');
  assert.equal(view.executionIdentity, null);
  assert.equal(view.planRevision, null);
  assert.equal(view.mutationRevision, null);
});

test('current Run revision is not backfilled onto historical attempts', () => {
  const [view] = projectExecutionEvidence({
    runs: [{ ...run, contractRevision: 9 }],
    attempts: [{
      runId: 'run-a',
      attemptId: 'historical-a',
      provenanceKind: 'owner-session',
      planRevision: 4,
      mutationRevision: 7,
    }],
  });
  assert.ok(view);
  assert.equal(view.contractRevision, null);
  assert.equal(view.executionIdentity, null);
});

test('plan and mutation revisions fence execution identities', () => {
  const views = projectExecutionEvidence({
    runs: [run],
    attempts: [
      { runId: 'run-a', attemptId: 'a1', provenanceKind: 'owner-session', contractRevision: 3, planRevision: 4, mutationRevision: 7 },
      { runId: 'run-a', attemptId: 'a2', provenanceKind: 'owner-session', contractRevision: 3, planRevision: 5, mutationRevision: 7 },
      { runId: 'run-a', attemptId: 'a3', provenanceKind: 'owner-session', contractRevision: 3, planRevision: 4, mutationRevision: 8 },
    ],
  });
  assert.equal(new Set(views.map((view) => view.executionIdentity)).size, 3);
});

test('contract revision also fences execution identities without adding attempt storage', () => {
  const attempt = {
    runId: 'run-a',
    attemptId: 'a1',
    provenanceKind: 'owner-session',
    contractRevision: 3,
    planRevision: 4,
    mutationRevision: 7,
  };
  const [before] = projectExecutionEvidence({ runs: [run], attempts: [attempt] });
  const [after] = projectExecutionEvidence({ runs: [run], attempts: [{ ...attempt, contractRevision: 4 }] });
  assert.ok(before && after);
  assert.notEqual(before.executionIdentity, after.executionIdentity);
});

test('one session total is not duplicated across two Runs', () => {
  const evidence = projectExecutionEvidence({
    runs: [run, { ...run, runId: 'run-b', workspaceId: 'workspace-b' }],
    attempts: [
      {
        runId: 'run-a',
        attemptId: 'a1',
        provenanceKind: 'owner-session',
        actorSessionId: 'shared-session',
        planRevision: 4,
        mutationRevision: 7,
      },
      {
        runId: 'run-b',
        attemptId: 'b1',
        provenanceKind: 'owner-session',
        actorSessionId: 'shared-session',
        planRevision: 4,
        mutationRevision: 7,
      },
    ],
  });
  const rows = attributeExecutionUsage({
    evidence,
    sessionTotals: [{ actorSessionId: 'shared-session', inputTokens: 1000, outputTokens: 100 }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, 'shared-session-unattributed');
  assert.equal(rows[0]?.runId, null);
  assert.equal(rows[0]?.inputTokens, 1000);
});

test('explicit binding or durable usage receipt permits token attribution', () => {
  const evidence = projectExecutionEvidence({
    runs: [run],
    attempts: [{
      runId: 'run-a',
      attemptId: 'a1',
      provenanceKind: 'owner-session',
      actorSessionId: 'session-a',
      planRevision: 4,
      mutationRevision: 7,
    }],
  });
  const rows = attributeExecutionUsage({
    evidence,
    usageReceipts: [{
      receiptId: 'receipt-a',
      runId: 'run-a',
      actorSessionId: 'session-a',
      inputTokens: 600,
      outputTokens: 50,
    }],
    sessionTotals: [{
      actorSessionId: 'session-external',
      runId: 'run-a',
      inputTokens: 400,
      outputTokens: 40,
    }],
  });
  assert.equal(rows[0]?.status, 'receipt-attributed');
  assert.equal(rows[0]?.runId, 'run-a');
  assert.equal(rows[1]?.status, 'explicit-session-run-binding');
  assert.equal(rows[1]?.runId, 'run-a');
});
