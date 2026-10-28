import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { normalizeSessionBinding } from '../src/kernel/run/session-binding.js';
import { openSqliteDb } from '../src/kernel/sqlite-adapter.js';
import { openKernelStateStore } from '../src/kernel/state-store.js';

const cli = path.join(process.cwd(), 'bin', 'moon-relay-kernel.mjs');
const sourceIdentity = `sha256:${'f'.repeat(64)}`;

const register = (store: Awaited<ReturnType<typeof openKernelStateStore>>, projectId: string, workspaceId: string) => store.registerProjectWorkspace({
  workspaceId,
  identity: { projectId },
  canonicalRoot: `C:\\fixtures\\${workspaceId}`,
  gitCommonDir: null,
  gitWorktreeDir: null,
});

const createRun = (store: Awaited<ReturnType<typeof openKernelStateStore>>, { runId, projectId, workspaceId, ownerBindingId = null }: { runId: string; projectId: string; workspaceId: string; ownerBindingId?: string | null }) =>
  store.createRun({
    runId,
    objective: runId,
    sourceIdentity,
    projectId,
    workspaceId,
    ownerBindingId,
  });

test('lifecycle diagnostics report ambiguous owners, terminal bindings, orphaned owners, namespace problems, and stale locks', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-lifecycle-doctor-'));
  const store = await openKernelStateStore({ runtimeHome });
  const projectId = 'doctor-project';
  const workspaceId = 'doctor-workspace';
  try {
    register(store, projectId, workspaceId);
    createRun(store, { runId: 'run-terminal', projectId, workspaceId });
    store.createSessionBinding(normalizeSessionBinding({
      bindingId: 'binding-terminal',
      provider: 'codex',
      sessionId: 'codex:shared',
      runId: 'run-terminal',
      projectId,
      workspaceId,
      accessMode: 'owner',
    }));
    const terminal = store.getRun('run-terminal');
    store.persistCompletionDecision('run-terminal', {
      decision: 'accepted',
      digest: `sha256:${'1'.repeat(64)}`,
      run: terminal,
      decisionPayload: { decision: 'accepted' },
    });
    store.createSessionBinding(normalizeSessionBinding({
      bindingId: 'binding-bad-provider',
      provider: 'claude',
      sessionId: 'codex:reviewer',
      runId: 'run-terminal',
      projectId,
      workspaceId,
      accessMode: 'reviewer',
    }));
    createRun(store, {
      runId: 'run-orphan',
      projectId,
      workspaceId,
      ownerBindingId: 'binding-missing',
    });
    store.acquireWorkspaceMutationLockV2({
      workspaceId,
      projectId,
      runId: 'run-terminal',
      sessionToken: 'binding-terminal',
      ttlMs: -1,
    });

    const raw = await openSqliteDb(store.dbPath);
    try {
      raw.exec(`
        DROP INDEX IF EXISTS uq_project_session_active_owner;
        DROP INDEX IF EXISTS uq_project_session_workspace_active_owner;
        DROP INDEX IF EXISTS uq_run_active_owner;
        UPDATE session_bindings
        SET status = 'active'
        WHERE binding_id = 'binding-terminal';
      `);
      const timestamp = new Date().toISOString();
      raw.prepare(`
        INSERT INTO session_bindings(
          binding_id, session_id, provider, surface, run_id, project_id,
          workspace_id, workspace_root, access_mode, status, created_at,
          expires_at, updated_at
        ) VALUES(?, ?, ?, NULL, ?, ?, ?, NULL, 'owner', 'active', ?, NULL, ?)
      `).run(
        'binding-ambiguous',
        'codex:shared',
        'codex',
        'run-orphan',
        projectId,
        workspaceId,
        timestamp,
        timestamp,
      );
    } finally {
      raw.close();
    }

    const diagnostics = store.diagnoseLifecycleState({ projectId });
    assert.equal(diagnostics.status, 'degraded');
    for (const code of [
      'ambiguous_session_binding',
      'terminal_run_active_binding',
      'orphaned_run_owner',
      'binding_namespace_problem',
      'stale_workspace_lock',
    ]) {
      assert.ok(diagnostics.counts[code] >= 1, code);
    }
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('doctor includes clean project lifecycle diagnostics without changing its ready contract', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-lifecycle-doctor-cli-state-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-lifecycle-doctor-cli-project-'));
  try {
    await mkdir(path.join(projectRoot, '.moon-relay'), { recursive: true });
    await writeFile(path.join(projectRoot, '.moon-relay', 'track.yaml'), 'track: kernel\n');
    await writeFile(
      path.join(projectRoot, '.moon-relay', 'project.identity.yaml'),
      'projectId: doctor-clean-project\n',
    );
    const result = spawnSync(process.execPath, [
      cli,
      'doctor',
      '--runtime-home',
      runtimeHome,
      '--json',
    ], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, MOON_RELAY_KERNEL_REEXEC: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'ready');
    assert.equal(payload.diagnostics.status, 'ready');
    assert.deepEqual(payload.diagnostics.findings, []);
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('lifecycle diagnostics isolate incompatible completed Run history', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-lifecycle-doctor-legacy-history-'));
  const store = await openKernelStateStore({ runtimeHome });
  const projectId = 'legacy-history-project';
  const workspaceId = 'legacy-history-workspace';
  try {
    register(store, projectId, workspaceId);
    createRun(store, { runId: 'legacy-completed', projectId, workspaceId });

    const raw = await openSqliteDb(store.dbPath);
    try {
      raw.prepare(
        "UPDATE runs SET proof_tier='high', status='completed' WHERE run_id='legacy-completed'",
      ).run();
    } finally {
      raw.close();
    }

    assert.throws(
      () => store.getRun('legacy-completed'),
      /Unknown persisted proof tier: high/,
    );

    const diagnostics = store.diagnoseLifecycleState({ projectId });
    assert.equal(diagnostics.status, 'ready');
    assert.deepEqual(diagnostics.findings, []);
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('lifecycle diagnostics expose stale untouched active Runs with deterministic recovery choices', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-stale-run-doctor-'));
  const store = await openKernelStateStore({ runtimeHome });
  const projectId = 'stale-run-project';
  const workspaceId = 'stale-run-workspace';
  try {
    register(store, projectId, workspaceId);
    createRun(store, { runId: 'run-stale-ready', projectId, workspaceId });
    const raw = await openSqliteDb(store.dbPath);
    try {
      raw.prepare('UPDATE runs SET updated_at=? WHERE run_id=?').run('2026-08-01T00:00:00.000Z', 'run-stale-ready');
      raw.prepare(`
        INSERT INTO run_steps(
          step_id, run_id, sequence, objective, state, plan_revision,
          created_at, updated_at
        ) VALUES(?, ?, 0, ?, 'ready', 1, ?, ?)
      `).run('step-stale', 'run-stale-ready', 'stale', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    } finally {
      raw.close();
    }

    const diagnostics = store.diagnoseLifecycleState({
      projectId,
      observedAt: '2026-08-09T00:00:00.000Z',
    });
    const finding = diagnostics.findings.find((item) => item.code === 'stale_active_run');
    assert.ok(finding);
    assert.equal(finding.runId, 'run-stale-ready');
    assert.deepEqual(finding.recoveryChoices, ['resume', 'replan', 'abort-and-successor']);
    assert.ok(finding && typeof finding === 'object' && 'provenance' in finding);
    assert.ok(finding.provenance && typeof finding.provenance === 'object' && 'attemptCount' in finding.provenance);
    assert.equal(finding.provenance.attemptCount, 0);
    assert.ok(finding && typeof finding === 'object' && 'provenance' in finding);
    assert.ok(finding.provenance && typeof finding.provenance === 'object' && 'capsuleCount' in finding.provenance);
    assert.equal(finding.provenance.capsuleCount, 0);
    assert.ok(finding && typeof finding === 'object' && 'provenance' in finding);
    assert.ok(finding.provenance && typeof finding.provenance === 'object' && 'verificationCount' in finding.provenance);
    assert.equal(finding.provenance.verificationCount, 0);
    assert.ok(finding && typeof finding === 'object' && 'provenance' in finding);
    assert.ok(finding.provenance && typeof finding.provenance === 'object' && 'completionReceiptCount' in finding.provenance);
    assert.equal(finding.provenance.completionReceiptCount, 0);
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('initialization rollback removes all pre-dispatch Run state and leaves the doctor clean', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-initialization-rollback-'));
  const store = await openKernelStateStore({ runtimeHome });
  const projectId = 'rollback-project';
  const workspaceId = 'rollback-workspace';
  const runId = 'run-rollback';
  try {
    const workspace = register(store, projectId, workspaceId);
    createRun(store, { runId, projectId, workspaceId });
    store.declareRunObligations(runId, [{
      obligationId: 'bootstrap-check',
      sourceType: 'contract',
      evidenceClass: 'hard',
      verificationMethod: 'unit-test',
      allowedCommandRefs: ['test:ok'],
    }]);
    store.createRunSteps(runId, [{
      stepId: 'bootstrap-step',
      sequence: 1,
      objective: 'bootstrap',
      state: 'ready',
      planRevision: 1,
      dependencyIds: [],
      allowedPaths: ['app.mjs'],
      acceptanceIds: ['AC-1'],
      obligationIds: ['bootstrap-check'],
      expectedOutputs: ['bootstrap output'],
    }]);
    store.createSessionBinding(normalizeSessionBinding({
      bindingId: 'binding-rollback',
      provider: 'codex',
      sessionId: 'codex:rollback',
      runId,
      projectId,
      workspaceId,
      accessMode: 'owner',
    }));
    store.acquireWorkspaceMutationLockV2({
      workspaceId,
      projectId,
      runId,
      sessionToken: 'binding-rollback',
    });

    const rolledBack = store.rollbackRunInitialization(runId, {
      projectId,
      sourceIdentity,
    });
    assert.deepEqual(rolledBack, { status: 'rolled-back', runId, rolledBack: true });
    assert.equal(store.getRun(runId), null);
    assert.ok(typeof workspace.worktreeId === 'string');
    assert.equal(store.getWorktreeMutationLease(workspace.worktreeId), null);
    assert.equal(store.getWorkspaceMutationLockV2(workspaceId), null);
    assert.deepEqual(store.getRunObligations(runId), []);
    assert.deepEqual(store.getRunSteps(runId), []);
    assert.equal(store.diagnoseLifecycleState({ projectId }).status, 'ready');
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});
