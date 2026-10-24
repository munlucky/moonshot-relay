import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openKernelStateStore } from '../src/kernel/state-store.js';
import { normalizeTaskContract } from '../src/kernel/task/task-contract.js';
import { buildSuccessorKey } from '../src/kernel/run/successor-key.js';

const identity = `sha256:${'b'.repeat(64)}`;
const fixture = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'successor-lineage-recovery-'));
  const store = await openKernelStateStore({ runtimeHome });
  const workspace = store.registerProjectWorkspace({
    workspaceId: 'workspace', canonicalRoot: 'C:\\fixtures\\lineage', identity: { projectId: 'project' },
  });
  const create = (runId: string, predecessorRunId: string | null = null,
    overrides: { successorKey?: string; workspaceIdentity?: string; workspaceId?: string } = {},
    owned = false) => {
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
    const before = ['first', 'second', 'third'].map(id => f.store.getRun(id));
    const result = f.store.resolveSuccessorLineage('third');
    assert.deepEqual(result.runIds, ['first', 'second', 'third']);
    assert.equal(result.isTerminal, true);
    assert.equal(result.edges.length, 2);
    assert.equal(result.edges[0]?.binding, null);
    assert.equal(f.store.resolveSuccessorLineage('first').isTerminal, false);
    assert.deepEqual(['first', 'second', 'third'].map(id => f.store.getRun(id)), before);
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

test('two key-only successors fail closed when selecting their predecessor', async () => {
  const f = await fixture();
  try {
    f.create('first'); f.create('second', 'first'); f.create('third', 'first');
    assert.throws(() => f.store.resolveSuccessorLineage('first'), /SUCCESSOR_LINEAGE_AMBIGUOUS/);
  } finally { await f.close(); }
});
