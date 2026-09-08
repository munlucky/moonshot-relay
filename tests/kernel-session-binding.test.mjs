import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { normalizeSessionBinding } from '../scripts/kernel/run/session-binding.mjs';
import { buildSuccessorKey } from '../scripts/kernel/run/successor-key.mjs';
import { openSqliteDb } from '../scripts/kernel/sqlite-adapter.mjs';
import { openKernelStateStore } from '../scripts/kernel/state-store.mjs';

const sourceIdentity = `sha256:${'c'.repeat(64)}`;
const workspaceIdentity = `sha256:${'e'.repeat(64)}`;

const createRun = (store, { runId, projectId, workspaceId }) =>
  store.createRun({
    runId,
    objective: runId,
    sourceIdentity,
    projectId,
    workspaceId,
    workspaceIdentity,
  });

const owner = ({ bindingId, sessionId, runId, projectId, workspaceId }) =>
  normalizeSessionBinding({
    bindingId,
    provider: sessionId.split(':')[0],
    sessionId,
    runId,
    projectId,
    workspaceId,
    accessMode: 'owner',
  });

const registerWorkspace = (store, { projectId, workspaceId }) =>
  store.registerProjectWorkspace({
    workspaceId,
    identity: { projectId },
    canonicalRoot: `C:\\fixtures\\${workspaceId}`,
    gitCommonDir: null,
    gitWorktreeDir: null,
  });

test('active owner lookup is scoped by project and session', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-binding-scope-'));
  const store = await openKernelStateStore({ runtimeHome });
  try {
    createRun(store, { runId: 'run-a', projectId: 'project-a', workspaceId: 'workspace-a' });
    createRun(store, { runId: 'run-b', projectId: 'project-b', workspaceId: 'workspace-b' });
    store.createSessionBinding(owner({
      bindingId: 'binding-a',
      sessionId: 'codex:shared-session',
      runId: 'run-a',
      projectId: 'project-a',
      workspaceId: 'workspace-a',
    }));
    store.createSessionBinding(owner({
      bindingId: 'binding-b',
      sessionId: 'codex:shared-session',
      runId: 'run-b',
      projectId: 'project-b',
      workspaceId: 'workspace-b',
    }));

    assert.equal(
      store.getActiveOwnerBinding({ projectId: 'project-a', sessionId: 'codex:shared-session' }).runId,
      'run-a',
    );
    assert.equal(
      store.getActiveOwnerBinding({ projectId: 'project-b', sessionId: 'codex:shared-session' }).runId,
      'run-b',
    );
    assert.equal(
      store.getActiveRunBinding({
        projectId: 'project-a',
        sessionId: 'codex:shared-session',
        runId: 'run-b',
      }),
      null,
    );
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('owner bindings allow one session across worktrees but still reject a second owner for one Run', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-binding-unique-'));
  const store = await openKernelStateStore({ runtimeHome });
  try {
    createRun(store, { runId: 'run-one', projectId: 'project-one', workspaceId: 'workspace-one' });
    createRun(store, { runId: 'run-two', projectId: 'project-one', workspaceId: 'workspace-two' });
    store.createSessionBinding(owner({
      bindingId: 'binding-one',
      sessionId: 'codex:session-one',
      runId: 'run-one',
      projectId: 'project-one',
      workspaceId: 'workspace-one',
    }));

    const independent = store.createSessionBinding(owner({
        bindingId: 'binding-two',
        sessionId: 'codex:session-one',
        runId: 'run-two',
        projectId: 'project-one',
        workspaceId: 'workspace-two',
      }));
    assert.equal(independent.runId, 'run-two');
    assert.throws(
      () => store.createSessionBinding(owner({
        bindingId: 'binding-three',
        sessionId: 'claude:session-two',
        runId: 'run-one',
        projectId: 'project-one',
        workspaceId: 'workspace-one',
      })),
      (error) => error.code === 'successor_binding_conflict',
    );
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('binding deactivation records closure and successor lineage without changing the predecessor owner reference', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-binding-lifecycle-'));
  const store = await openKernelStateStore({ runtimeHome });
  try {
    createRun(store, { runId: 'run-old', projectId: 'project-one', workspaceId: 'workspace-one' });
    store.createSessionBinding(owner({
      bindingId: 'binding-old',
      sessionId: 'codex:session-one',
      runId: 'run-old',
      projectId: 'project-one',
      workspaceId: 'workspace-one',
    }));

    const closed = store.deactivateSessionBinding({
      projectId: 'project-one',
      sessionId: 'codex:session-one',
      bindingId: 'binding-old',
      reason: 'successor_started',
      successorRunId: 'run-new',
    });

    assert.equal(closed.status, 'inactive');
    assert.equal(closed.closeReason, 'successor_started');
    assert.equal(closed.successorRunId, 'run-new');
    assert.ok(closed.closedAt);
    assert.equal(
      store.getActiveOwnerBinding({ projectId: 'project-one', sessionId: 'codex:session-one' }),
      null,
    );
    assert.equal(store.getRun('run-old').ownerBindingId, 'binding-old');
    assert.throws(
      () => store.deactivateSessionBinding({
        projectId: 'project-one',
        sessionId: 'codex:session-one',
        bindingId: 'binding-old',
        reason: 'successor_started',
      }),
      (error) => error.code === 'binding_already_inactive',
    );
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('terminal lifecycle cleanup deactivates owners and releases stale locks without session preservation authority', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-binding-terminal-cleanup-'));
  const store = await openKernelStateStore({ runtimeHome });
  const projectId = 'cleanup-project';
  try {
    registerWorkspace(store, { projectId, workspaceId: 'workspace-completed' });
    registerWorkspace(store, { projectId, workspaceId: 'workspace-blocked' });
    registerWorkspace(store, { projectId, workspaceId: 'workspace-current' });

    createRun(store, { runId: 'run-completed', projectId, workspaceId: 'workspace-completed' });
    store.createSessionBinding(owner({
      bindingId: 'binding-completed',
      sessionId: 'codex:old-completed',
      runId: 'run-completed',
      projectId,
      workspaceId: 'workspace-completed',
    }));
    store.persistCompletionDecision('run-completed', {
      decision: 'accepted',
      digest: `sha256:${'b'.repeat(64)}`,
      run: store.getRun('run-completed'),
      decisionPayload: { decision: 'accepted' },
    });
    const completedLock = store.acquireWorkspaceMutationLockV2({
      workspaceId: 'workspace-completed',
      projectId,
      runId: 'run-completed',
      sessionToken: 'binding-completed',
      ttlMs: 60000,
    });
    assert.equal(completedLock.acquired, true);

    createRun(store, { runId: 'run-blocked', projectId, workspaceId: 'workspace-blocked' });
    store.createSessionBinding(owner({
      bindingId: 'binding-blocked',
      sessionId: 'codex:old-blocked',
      runId: 'run-blocked',
      projectId,
      workspaceId: 'workspace-blocked',
    }));
    const blockedLock = store.acquireWorkspaceMutationLockV2({
      workspaceId: 'workspace-blocked',
      projectId,
      runId: 'run-blocked',
      sessionToken: 'binding-blocked',
      ttlMs: 60000,
    });
    assert.equal(blockedLock.acquired, true);
    store.markRunBlocked('run-blocked', 'unsupported-verification');
    assert.equal(store.getActiveOwnerBinding({ projectId, sessionId: 'codex:old-blocked' }), null);
    assert.equal(store.getWorkspaceMutationLockV2('workspace-blocked'), null);

    createRun(store, { runId: 'run-current-completed', projectId, workspaceId: 'workspace-current' });
    store.createSessionBinding(owner({
      bindingId: 'binding-current-completed',
      sessionId: 'codex:current-host',
      runId: 'run-current-completed',
      projectId,
      workspaceId: 'workspace-current',
    }));
    store.persistCompletionDecision('run-current-completed', {
      decision: 'accepted',
      digest: `sha256:${'c'.repeat(64)}`,
      run: store.getRun('run-current-completed'),
      decisionPayload: { decision: 'accepted' },
    });
    const currentLock = store.acquireWorkspaceMutationLockV2({
      workspaceId: 'workspace-current',
      projectId,
      runId: 'run-current-completed',
      sessionToken: 'binding-current-completed',
      ttlMs: 60000,
    });
    assert.equal(currentLock.acquired, true);

    const first = store.reconcileTerminalLifecycle({
      projectId,
      preserveSessionId: 'codex:current-host',
    });
    assert.deepEqual(first.deactivatedBindings, []);
    assert.equal(store.getActiveOwnerBinding({ projectId, sessionId: 'codex:old-completed' }), null);
    assert.equal(store.getWorkspaceMutationLockV2('workspace-completed'), null);
    assert.equal(store.getActiveOwnerBinding({ projectId, sessionId: 'codex:current-host' }), null);
    assert.equal(store.getWorkspaceMutationLockV2('workspace-current'), null);

    const second = store.reconcileTerminalLifecycle({
      projectId,
      preserveSessionId: 'codex:current-host',
    });
    assert.deepEqual(second.deactivatedBindings, []);
    assert.deepEqual(second.releasedLocks, []);
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('blocked owner binding resumes only through the same-session lifecycle transition', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-binding-blocked-resume-'));
  const store = await openKernelStateStore({ runtimeHome });
  const projectId = 'blocked-resume-project';
  try {
    createRun(store, { runId: 'run-blocked-resume', projectId, workspaceId: 'workspace-blocked-resume' });
    store.createSessionBinding(owner({
      bindingId: 'binding-blocked-resume',
      sessionId: 'codex:resume-session',
      runId: 'run-blocked-resume',
      projectId,
      workspaceId: 'workspace-blocked-resume',
    }));
    store.markRunBlocked('run-blocked-resume', 'unsupported-verification');
    assert.equal(store.getActiveOwnerBinding({ projectId, sessionId: 'codex:resume-session' }), null);

    const resumed = store.reactivateBlockedRunBinding(owner({
      bindingId: 'binding-blocked-resume',
      sessionId: 'codex:resume-session',
      runId: 'run-blocked-resume',
      projectId,
      workspaceId: 'workspace-blocked-resume',
    }));
    assert.equal(resumed.status, 'active');
    assert.equal(store.getRun('run-blocked-resume').status, 'active');
    assert.equal(store.getRun('run-blocked-resume').interventionCount, 1);

    store.markRunBlocked('run-blocked-resume', 'unsupported-verification');
    assert.equal(
      store.reactivateBlockedRunBinding(owner({
        bindingId: 'binding-blocked-resume',
        sessionId: 'codex:other-session',
        runId: 'run-blocked-resume',
        projectId,
        workspaceId: 'workspace-blocked-resume',
      })),
      null,
    );
    assert.equal(store.getActiveOwnerBinding({ projectId, sessionId: 'codex:other-session' }), null);
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

const crossProjectBindingRollbackSpec = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-binding-cross-project-'));
  const store = await openKernelStateStore({ runtimeHome });
  try {
    createRun(store, {
      runId: 'run-project-a',
      projectId: 'project-a',
      workspaceId: 'workspace-a',
    });

    assert.throws(
      () => store.createSessionBinding(owner({
        bindingId: 'binding-project-b',
        sessionId: 'codex:session-b',
        runId: 'run-project-a',
        projectId: 'project-b',
        workspaceId: 'workspace-b',
      })),
      (error) => error.code === 'run_project_mismatch',
    );
    assert.equal(store.getRun('run-project-a').ownerBindingId, null);
    assert.equal(
      store.getActiveOwnerBinding({
        projectId: 'project-b',
        sessionId: 'codex:session-b',
      }),
      null,
    );
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
};
test('binding creation rolls back atomically when Run project or workspace ownership mismatches', crossProjectBindingRollbackSpec);

test('legacy binding migration is additive and idempotent across repeated database opens', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-binding-legacy-migration-'));
  let dbPath;
  try {
    const initial = await openKernelStateStore({ runtimeHome });
    dbPath = initial.dbPath;
    try {
      createRun(initial, {
        runId: 'codex-legacy-run',
        projectId: 'legacy-project',
        workspaceId: 'legacy-workspace',
      });
      initial.createSessionBinding(owner({
        bindingId: 'binding-legacy',
        sessionId: 'legacy-session',
        runId: 'codex-legacy-run',
        projectId: 'legacy-project',
        workspaceId: 'legacy-workspace',
      }));
    } finally {
      initial.close();
    }

    const legacyDb = await openSqliteDb(dbPath);
    try {
      legacyDb.exec(`
        DROP INDEX IF EXISTS uq_project_session_active_owner;
        DROP INDEX IF EXISTS uq_run_active_owner;
        ALTER TABLE session_bindings DROP COLUMN successor_run_id;
        ALTER TABLE session_bindings DROP COLUMN close_reason;
        ALTER TABLE session_bindings DROP COLUMN closed_at;
      `);
    } finally {
      legacyDb.close();
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const migrated = await openKernelStateStore({ runtimeHome });
      try {
        const binding = migrated.getActiveOwnerBinding({
          projectId: 'legacy-project',
          sessionId: 'legacy-session',
        });
        assert.equal(binding.bindingId, 'binding-legacy');
        assert.equal(binding.runId, 'codex-legacy-run');
        assert.equal(binding.closedAt, null);
        assert.equal(binding.closeReason, null);
        assert.equal(binding.successorRunId, null);
      } finally {
        migrated.close();
      }
    }
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('legacy active owners for one session remain valid when they belong to different worktrees', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-binding-legacy-duplicate-'));
  let dbPath;
  try {
    const initial = await openKernelStateStore({ runtimeHome });
    dbPath = initial.dbPath;
    try {
      createRun(initial, {
        runId: 'legacy-run-one',
        projectId: 'legacy-project',
        workspaceId: 'legacy-workspace-one',
      });
      createRun(initial, {
        runId: 'legacy-run-two',
        projectId: 'legacy-project',
        workspaceId: 'legacy-workspace-two',
      });
      initial.createSessionBinding(owner({
        bindingId: 'legacy-binding-one',
        sessionId: 'legacy-session',
        runId: 'legacy-run-one',
        projectId: 'legacy-project',
        workspaceId: 'legacy-workspace-one',
      }));
    } finally {
      initial.close();
    }

    const legacyDb = await openSqliteDb(dbPath);
    try {
      legacyDb.exec(`
        DROP INDEX IF EXISTS uq_project_session_active_owner;
        DROP INDEX IF EXISTS uq_run_active_owner;
      `);
      const timestamp = new Date().toISOString();
      legacyDb.prepare(`
        INSERT INTO session_bindings(
          binding_id, session_id, provider, surface, run_id, project_id,
          workspace_id, workspace_root, access_mode, status, created_at,
          expires_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'legacy-binding-two',
        'legacy-session',
        'codex',
        null,
        'legacy-run-two',
        'legacy-project',
        'legacy-workspace-two',
        null,
        'owner',
        'active',
        timestamp,
        null,
        timestamp,
      );
      legacyDb.prepare(`
        UPDATE runs SET owner_binding_id=? WHERE run_id=? AND project_id=?
      `).run('legacy-binding-two', 'legacy-run-two', 'legacy-project');
    } finally {
      legacyDb.close();
    }

    const migrated = await openKernelStateStore({ runtimeHome });
    migrated.close();

    const preserved = await openSqliteDb(dbPath);
    try {
      const rows = preserved.prepare(`
        SELECT binding_id AS bindingId, run_id AS runId, status
        FROM session_bindings
        WHERE project_id=? AND session_id=?
        ORDER BY binding_id
      `).all('legacy-project', 'legacy-session').map((row) => ({ ...row }));
      assert.deepEqual(rows, [
        { bindingId: 'legacy-binding-one', runId: 'legacy-run-one', status: 'active' },
        { bindingId: 'legacy-binding-two', runId: 'legacy-run-two', status: 'active' },
      ]);
    } finally {
      preserved.close();
    }
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

const completeRun = (store, runId, finalizationStatus = 'completed') => {
  const run = store.getRun(runId);
  store.persistCompletionDecision(runId, {
    decision: 'accepted',
    digest: `sha256:${'a'.repeat(64)}`,
    run,
    decisionPayload: { decision: 'accepted' },
  });
  store.setFinalizationStatus(runId, finalizationStatus);
};

const successorSpec = ({
  runId,
  bindingId,
  projectId = 'successor-project',
  sessionId = 'codex:successor-session',
  workspaceId = 'successor-workspace',
  worktreeId = null,
  workspaceIdentityValue = workspaceIdentity,
}) => {
  const taskContractDigest = `sha256:${'d'.repeat(64)}`;
  return {
    successorRun: {
    runId,
    objective: 'successor objective',
    sourceIdentity,
    projectId,
    workspaceId,
    workspaceIdentity: workspaceIdentityValue,
    ...(worktreeId ? { worktreeId } : {}),
    taskContract: {
      schemaVersion: 1,
      objective: 'successor objective',
      digest: taskContractDigest,
    },
  },
  successorBinding: owner({
    bindingId,
    sessionId,
    runId,
    projectId,
    workspaceId,
  }),
  successorKey: buildSuccessorKey({
    projectId,
    predecessorRunId: 'run-predecessor',
    worktreeId,
    workspaceId,
    taskContractDigest,
  }),
  obligations: [{
    obligationId: 'unit-test',
    sourceType: 'task-contract',
    evidenceClass: 'hard',
  }],
  steps: [{
    stepId: 'successor-step-1',
    sequence: 1,
    objective: 'implement successor',
    obligationIds: ['unit-test'],
  }],
  };
};

test('successor handoff is atomic, idempotent, preserves predecessor lineage, and releases its mutation lock', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-successor-atomic-'));
  const store = await openKernelStateStore({ runtimeHome });
  const projectId = 'successor-project';
  const sessionId = 'codex:successor-session';
  const workspaceId = 'successor-workspace';
  const predecessorRunId = 'run-predecessor';
  const predecessorBindingId = 'binding-predecessor';
  try {
    const workspace = registerWorkspace(store, { projectId, workspaceId });
    createRun(store, { runId: predecessorRunId, projectId, workspaceId });
    store.createSessionBinding(owner({
      bindingId: predecessorBindingId,
      sessionId,
      runId: predecessorRunId,
      projectId,
      workspaceId,
    }));
    completeRun(store, predecessorRunId);
    const predecessorLock = store.acquireWorkspaceMutationLockV2({
      workspaceId,
      projectId,
      runId: predecessorRunId,
      sessionToken: predecessorBindingId,
    });
    assert.equal(predecessorLock.acquired, true);
    const predecessorBefore = store.getRun(predecessorRunId);
    const request = {
      projectId,
      sessionId,
      predecessorRunId,
      predecessorBindingId,
      predecessorLock: predecessorLock.lock,
      ...successorSpec({
        runId: 'run-successor-first-attempt',
        bindingId: 'binding-successor-first-attempt',
        worktreeId: workspace.worktreeId,
      }),
    };

    assert.throws(
      () => store.createSuccessorRunAtomic({
        ...request,
        ...successorSpec({
          runId: 'run-successor-continuity-mismatch',
          bindingId: 'binding-successor-continuity-mismatch',
          worktreeId: workspace.worktreeId,
          workspaceIdentityValue: `sha256:${'f'.repeat(64)}`,
        }),
      }),
      (error) => error.code === 'successor_workspace_continuity_mismatch',
    );

    const first = store.createSuccessorRunAtomic(request);
    const retry = store.createSuccessorRunAtomic({
      ...request,
      ...successorSpec({
        runId: 'run-successor-retry-nonce',
        bindingId: 'binding-successor-retry-nonce',
        worktreeId: workspace.worktreeId,
      }),
    });

    assert.equal(first.created, true);
    assert.equal(retry.created, false);
    assert.equal(retry.run.runId, first.run.runId);
    assert.equal(store.getRun('run-successor-retry-nonce'), null);
    assert.equal(store.getRunObligations(first.run.runId).length, 1);
    assert.equal(store.getRunSteps(first.run.runId).length, 1);
    assert.equal(store.getWorkspaceMutationLockV2(workspaceId), null);
    assert.deepEqual(
      {
        objective: store.getRun(predecessorRunId).objective,
        status: store.getRun(predecessorRunId).status,
        finalizationStatus: store.getRun(predecessorRunId).finalizationStatus,
        ownerBindingId: store.getRun(predecessorRunId).ownerBindingId,
      },
      {
        objective: predecessorBefore.objective,
        status: predecessorBefore.status,
        finalizationStatus: predecessorBefore.finalizationStatus,
        ownerBindingId: predecessorBefore.ownerBindingId,
      },
    );
    assert.equal(first.predecessorBinding.status, 'inactive');
    assert.equal(first.predecessorBinding.closeReason, 'terminal_completed_cleanup');
    assert.equal(first.predecessorBinding.successorRunId, null);
    assert.equal(
      store.getActiveOwnerBinding({ projectId, sessionId }).runId,
      first.run.runId,
    );
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('successor handoff rejects incomplete finalization and rolls back a mid-transaction binding conflict', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-successor-rollback-'));
  const store = await openKernelStateStore({ runtimeHome });
  const projectId = 'successor-project';
  const sessionId = 'codex:successor-session';
  const workspaceId = 'successor-workspace';
  const predecessorRunId = 'run-predecessor';
  const predecessorBindingId = 'binding-predecessor';
  try {
    const workspace = registerWorkspace(store, { projectId, workspaceId });
    createRun(store, { runId: predecessorRunId, projectId, workspaceId });
    store.createSessionBinding(owner({
      bindingId: predecessorBindingId,
      sessionId,
      runId: predecessorRunId,
      projectId,
      workspaceId,
    }));
    completeRun(store, predecessorRunId, 'partial');
    const base = {
      projectId,
      sessionId,
      predecessorRunId,
      predecessorBindingId,
      ...successorSpec({
        runId: 'run-successor',
        bindingId: 'binding-successor',
        worktreeId: workspace.worktreeId,
      }),
    };

    assert.throws(
      () => store.createSuccessorRunAtomic(base),
      (error) => error.code === 'successor_not_allowed'
        && error.nextAction === 'retry-finalization',
    );
    assert.equal(store.getRun('run-successor'), null);
    assert.equal(store.getActiveOwnerBinding({ projectId, sessionId }), null);

    store.setFinalizationStatus(predecessorRunId, 'completed');
    const crossWorkspace = successorSpec({
      runId: 'run-successor-unregistered-workspace',
      bindingId: 'binding-successor-unregistered-workspace',
      projectId,
      sessionId,
      workspaceId: 'unregistered-workspace',
    });
    assert.throws(
      () => store.createSuccessorRunAtomic({
        projectId,
        sessionId,
        predecessorRunId,
        predecessorBindingId,
        ...crossWorkspace,
      }),
      (error) => error.code === 'successor_not_allowed',
    );
    assert.equal(store.getRun('run-successor-unregistered-workspace'), null);
    assert.equal(store.getActiveOwnerBinding({ projectId, sessionId }), null);

    const conflicting = successorSpec({
      runId: 'run-successor-conflict',
      bindingId: predecessorBindingId,
      worktreeId: workspace.worktreeId,
    });
    assert.throws(
      () => store.createSuccessorRunAtomic({
        projectId,
        sessionId,
        predecessorRunId,
        predecessorBindingId,
        ...conflicting,
      }),
      (error) => error.code === 'successor_binding_conflict',
    );
    assert.equal(store.getRun('run-successor-conflict'), null);
    assert.equal(store.getActiveOwnerBinding({ projectId, sessionId }), null);
    assert.equal(store.getWorkspaceMutationLockV2(workspaceId), null);
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('successor handoff fails closed on a missing, stale, or changed-owner workspace lock', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-successor-lock-fence-'));
  const store = await openKernelStateStore({ runtimeHome });
  const projectId = 'successor-project';
  const sessionId = 'codex:successor-session';
  const workspaceId = 'successor-workspace';
  const predecessorRunId = 'run-predecessor';
  const predecessorBindingId = 'binding-predecessor';
  try {
    const workspace = registerWorkspace(store, { projectId, workspaceId });
    createRun(store, { runId: predecessorRunId, projectId, workspaceId });
    store.createSessionBinding(owner({
      bindingId: predecessorBindingId,
      sessionId,
      runId: predecessorRunId,
      projectId,
      workspaceId,
    }));
    completeRun(store, predecessorRunId);
    const request = {
      projectId,
      sessionId,
      predecessorRunId,
      predecessorBindingId,
      ...successorSpec({
        runId: 'run-successor-lock-check',
        bindingId: 'binding-successor-lock-check',
        worktreeId: workspace.worktreeId,
      }),
    };
    const missingLock = {
      workspaceId,
      projectId,
      holderRunId: predecessorRunId,
      sessionToken: predecessorBindingId,
      fencingToken: 1,
    };
    assert.throws(
      () => store.createSuccessorRunAtomic({ ...request, predecessorLock: missingLock }),
      (error) => error.code === 'workspace_lock_handoff_failed',
    );
    assert.equal(store.getRun(request.successorRun.runId), null);

    const stale = store.acquireWorkspaceMutationLockV2({
      workspaceId,
      projectId,
      runId: predecessorRunId,
      sessionToken: predecessorBindingId,
      ttlMs: -1,
    }).lock;
    createRun(store, {
      runId: 'run-other-owner',
      projectId,
      workspaceId,
    });
    const changedOwner = store.acquireWorkspaceMutationLockV2({
      workspaceId,
      projectId,
      runId: 'run-other-owner',
      sessionToken: 'binding-other-owner',
    });
    assert.equal(changedOwner.acquired, true);
    assert.notEqual(changedOwner.lock.fencingToken, stale.fencingToken);
    assert.throws(
      () => store.createSuccessorRunAtomic({ ...request, predecessorLock: stale }),
      (error) => error.code === 'worktree_run_conflict',
    );
    assert.throws(
      () => store.createSuccessorRunAtomic(request),
      (error) => error.code === 'worktree_run_conflict',
    );
    assert.equal(store.getRun(request.successorRun.runId), null);
    assert.equal(store.getActiveOwnerBinding({ projectId, sessionId }), null);
    assert.equal(store.getWorkspaceMutationLockV2(workspaceId).holderRunId, 'run-other-owner');
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});
