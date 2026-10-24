import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openKernelStateStore } from '../src/kernel/state-store.js';
import { normalizeTaskContract } from '../src/kernel/task/task-contract.js';
import { buildSuccessorKey } from '../src/kernel/run/successor-key.js';
import { resolveKernelCloseoutRun } from '../src/application/kernel-standalone/kernel-commit.js';

const identity = `sha256:${'b'.repeat(64)}`;
const fixture = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'successor-lineage-recovery-'));
  const store = await openKernelStateStore({ runtimeHome });
  const workspace = store.registerProjectWorkspace({
    workspaceId: 'workspace', canonicalRoot: 'C:\\fixtures\\lineage', identity: { projectId: 'project' },
  });
  const create = (runId: string, predecessorRunId: string | null = null,
    overrides: { successorKey?: string; workspaceIdentity?: string; workspaceId?: string } = {},
    owned = false, beforeComplete?: (runId: string) => void) => {
    const taskContract = normalizeTaskContract({ objective: runId, acceptance: [`${runId} works`] });
    const key = predecessorRunId ? buildSuccessorKey({
      projectId: 'project', predecessorRunId, worktreeId: workspace.worktreeId,
      workspaceId: workspace.workspaceId, taskContractDigest: taskContract.digest,
    }) : null;
    store.createRun({
      runId, objective: runId, sourceIdentity: `sha256:${'a'.repeat(64)}`,
      projectId: 'project', workspaceId: workspace.workspaceId, worktreeId: workspace.worktreeId,
      workspaceIdentity: identity, taskContract, successorKey: key, ...overrides,
    });
    if (owned) store.createSessionBinding({
      bindingId: 'owner-first', sessionId: 'codex:fixture', provider: 'codex',
      runId, projectId: 'project', workspaceId: workspace.workspaceId, accessMode: 'owner', status: 'active',
    });
    beforeComplete?.(runId);
    store.transition(runId, 'CLOSE');
    // Seed only isolated fixture completion through the store API.
    store.persistCompletionDecision(runId, {
      decision: 'accepted', digest: `sha256:${'c'.repeat(64)}`,
      run: store.getRun(runId), decisionPayload: { decision: 'accepted' },
    });
    store.setFinalizationStatus(runId, 'completed');
  };
  return { store, workspace, create, async close() { store.close(); await rm(runtimeHome, { recursive: true, force: true }); } };
};

test('key-only successor restores predecessor and earlier waves without rewriting records', async () => {
  const f = await fixture();
  try {
    f.create('first');
    f.create('second', 'first');
    f.create('third', 'second');
    f.store.recordGitCloseoutReceipt('first', { projectId: 'project', mode: 'commit',
      commitSha: 'f'.repeat(40), branch: 'fixture', pushStatus: 'not_requested', parity: 'not_requested',
      receiptJson: { fixture: true } });
    const snapshot = () => ['first', 'second', 'third'].map(id => ({
      run: f.store.getRun(id), binding: f.store.getRunOwnerBinding(id),
      completion: f.store.getCompletionDecision(id), receipt: f.store.getGitCloseoutReceipt(id),
    }));
    const before = snapshot();
    const result = f.store.resolveSuccessorLineage('third');
    assert.deepEqual(result.runIds, ['first', 'second', 'third']);
    assert.equal(result.isTerminal, true);
    assert.equal(result.edges.length, 2);
    assert.equal(result.edges[0]?.binding, null);
    assert.equal(f.store.resolveSuccessorLineage('first').isTerminal, false);
    assert.deepEqual(snapshot(), before);
  } finally { await f.close(); }
});

test('native successor creation after owner finalization retains derivable lineage', async () => {
  const f = await fixture();
  try {
    f.create('first', null, {}, true);
    assert.equal(f.store.getActiveRunBinding({ projectId: 'project', sessionId: 'codex:fixture', runId: 'first' }), null);
    const contract = normalizeTaskContract({ objective: 'successor', acceptance: ['successor works'] });
    const successorKey = buildSuccessorKey({ projectId: 'project', predecessorRunId: 'first',
      worktreeId: f.workspace.worktreeId, workspaceId: f.workspace.workspaceId,
      taskContractDigest: contract.digest });
    f.store.createSuccessorRunAtomic({
      projectId: 'project', sessionId: 'codex:fixture', predecessorRunId: 'first', successorKey,
      successorRun: { runId: 'second', objective: 'successor', sourceIdentity: `sha256:${'a'.repeat(64)}`,
        projectId: 'project', workspaceId: f.workspace.workspaceId, worktreeId: f.workspace.worktreeId,
        workspaceIdentity: identity, taskContract: contract },
    });
    assert.deepEqual(f.store.resolveSuccessorLineage('second').runIds, ['first', 'second']);
    assert.equal(f.store.resolveSuccessorLineage('first').isTerminal, false);
  } finally { await f.close(); }
});

test('a malformed or foreign stored key cannot import predecessor proof', async () => {
  for (const key of ['successor-invalid', buildSuccessorKey({ projectId: 'foreign', predecessorRunId: 'first',
    worktreeId: 'foreign', taskContractDigest: 'foreign' })]) {
    const f = await fixture();
    try {
      f.create('first'); f.create('second', 'first', { successorKey: key });
      assert.throws(() => f.store.resolveSuccessorLineage('second'), /SUCCESSOR_LINEAGE_KEY_MISMATCH/);
    } finally { await f.close(); }
  }
});

test('key recovery still rejects workspace content discontinuity', async () => {
  const f = await fixture();
  try {
    f.create('first');
    f.create('second', 'first', { workspaceIdentity: `sha256:${'d'.repeat(64)}` });
    assert.throws(() => f.store.resolveSuccessorLineage('second'), /SUCCESSOR_WORKSPACE_CONTINUITY_MISMATCH/);
  } finally { await f.close(); }
});

test('key recovery does not import another workspace', async () => {
  const f = await fixture();
  try {
    f.create('first'); f.create('second', 'first', { workspaceId: 'different-workspace' });
    assert.throws(() => f.store.resolveSuccessorLineage('second'), /SUCCESSOR_LINEAGE_SCOPE_MISMATCH/);
  } finally { await f.close(); }
});

test('a key-only fork fails closed from its parent, either child and a later descendant', async () => {
  const f = await fixture();
  try {
    f.create('first'); f.create('second', 'first'); f.create('third', 'first');
    f.create('fourth', 'second');
    for (const id of ['first', 'second', 'third', 'fourth']) {
      assert.throws(() => f.store.resolveSuccessorLineage(id), /SUCCESSOR_LINEAGE_AMBIGUOUS/);
    }
  } finally { await f.close(); }
});

const bindSuccessor = (f: Awaited<ReturnType<typeof fixture>>, runId: string, successorRunId: string) => {
  const bindingId = `owner-${runId}`;
  const sessionId = `codex:${runId}`;
  f.store.createSessionBinding({ bindingId, sessionId, provider: 'codex', runId,
    projectId: 'project', workspaceId: f.workspace.workspaceId, accessMode: 'owner', status: 'active' });
  f.store.deactivateSessionBinding({ projectId: 'project', sessionId, bindingId,
    reason: 'fixture-successor', successorRunId });
};

test('legacy binding-based lineage without a successor key remains valid', async () => {
  const f = await fixture();
  try {
    f.create('first'); f.create('second'); bindSuccessor(f, 'first', 'second');
    const result = f.store.resolveSuccessorLineage('second');
    assert.deepEqual(result.runIds, ['first', 'second']);
    assert.equal(result.edges[0]?.binding?.bindingId, 'owner-first');
  } finally { await f.close(); }
});

test('a binding that disagrees with the stored successor key fails closed', async () => {
  const f = await fixture();
  try {
    f.create('first'); f.create('foreign'); f.create('second', 'first');
    bindSuccessor(f, 'foreign', 'second');
    assert.throws(() => f.store.resolveSuccessorLineage('second'), /SUCCESSOR_LINEAGE_KEY_MISMATCH/);
  } finally { await f.close(); }
});

test('binding cycles fail closed', async () => {
  const f = await fixture();
  try {
    f.create('first'); f.create('second');
    bindSuccessor(f, 'first', 'second'); bindSuccessor(f, 'second', 'first');
    assert.throws(() => f.store.resolveSuccessorLineage('first'), /SUCCESSOR_LINEAGE_CYCLE/);
  } finally { await f.close(); }
});

test('unrelated malformed candidate metadata is diagnosed without materializing it', async () => {
  const f = await fixture();
  try {
    f.create('first'); f.create('second', 'first');
    f.store.createRun({ runId: 'malformed', objective: 'legacy', sourceIdentity: 'old',
      projectId: 'project', workspaceId: f.workspace.workspaceId, worktreeId: f.workspace.worktreeId,
      workspaceIdentity: identity, taskContract: null, successorKey: 'unrelated-old-key' });
    const result = f.store.resolveSuccessorLineage('second');
    assert.deepEqual(result.runIds, ['first', 'second']);
    assert.deepEqual(result.diagnostics, [{ runId: 'malformed', code: 'invalid-successor-candidate' }]);
    assert.throws(() => f.store.resolveSuccessorLineage('malformed'));
  } finally { await f.close(); }
});

test('closeout consumes recovered lineage and retains accepted mutation provenance guards', async () => {
  const f = await fixture();
  try {
    const middleIdentity = `sha256:${'d'.repeat(64)}`;
    const finalIdentity = `sha256:${'e'.repeat(64)}`;
    const mutate = (workspaceIdentity: string, changedPath: string) => (runId: string) => {
      f.store.observeWorkspaceIdentity(runId, workspaceIdentity, { provenance: {
        changedPaths: [changedPath], mutationDigest: workspaceIdentity,
      } });
    };
    f.create('first', null, {}, true, mutate(middleIdentity, 'app.ts'));
    f.create('second', 'first', { workspaceIdentity: middleIdentity }, false, mutate(finalIdentity, 'README.md'));
    const input = { stateStore: f.store, projectId: 'project', workspaceId: f.workspace.workspaceId,
      currentWorkspaceIdentity: finalIdentity, currentPaths: ['app.ts', 'README.md'],
      selectedPaths: ['app.ts', 'README.md'] };
    const result = resolveKernelCloseoutRun(input);
    assert.equal(result.run.runId, 'second');
    assert.deepEqual(result.lineage.runIds, ['first', 'second']);
    assert.deepEqual(result.approvedPaths, ['app.ts', 'README.md']
      .map(p => process.platform === 'win32' ? p.toLowerCase() : p).sort());
    assert.throws(() => resolveKernelCloseoutRun({ ...input, runId: 'first' }), /RUN_NOT_FINALIZED/);
    assert.throws(() => resolveKernelCloseoutRun({ ...input, selectedPaths: ['foreign.ts'] }), /RUN_PROVENANCE_REQUIRED/);
    assert.throws(() => resolveKernelCloseoutRun({ ...input, currentWorkspaceIdentity: identity }), /RUN_PROVENANCE_REQUIRED/);
    const completion = f.store.getCompletionDecision.bind(f.store);
    assert.throws(() => resolveKernelCloseoutRun({ ...input, stateStore: { ...f.store,
      getCompletionDecision: (id: string) => id === 'first' ? null : completion(id),
    } }), /RUN_PROVENANCE_REQUIRED/);
    const provenance = f.store.getMutationProvenance.bind(f.store);
    assert.throws(() => resolveKernelCloseoutRun({ ...input, stateStore: { ...f.store,
      getMutationProvenance: (id: string) => id === 'first' ? { ...provenance(id), mutationRevision: 999 } : provenance(id),
    } }), /RUN_PROVENANCE_REQUIRED/);
  } finally { await f.close(); }
});
