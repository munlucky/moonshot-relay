import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import {
  ensureKnowledgeStoreDirectories,
  prepareProjectKnowledgeNamespaceMigration,
  projectKnowledgeDirectory,
  recoverProjectKnowledgeNamespaceMigrations,
} from '../scripts/kernel/knowledge/store.mjs';
import { openKernelStateStore } from '../scripts/kernel/state-store.mjs';
import { canonicalPath } from '../scripts/kernel/runtime-home.mjs';

const digest = (letter) => `sha256:${letter.repeat(64)}`;
const canonicalRoot = (value) => {
  const root = canonicalPath(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? root.toLowerCase() : root;
};
const runtimeEnv = (runtimeHome) => ({ MOON_RELAY_KERNEL_HOME: runtimeHome });
const prepareMigration = (options) => prepareProjectKnowledgeNamespaceMigration({
  canonicalRoot: path.join(options.runtimeHome, 'identity-repo'),
  identityDigest: `digest-${options.projectId}`,
  ...options,
});

const registerWorkspace = (store, workspaceId, projectId, root) => store.registerProjectWorkspace({
  workspaceId,
  canonicalRoot: canonicalRoot(root),
  gitCommonDir: null,
  gitWorktreeDir: null,
  identity: { projectId, canonicalRoot: canonicalRoot(root) },
});

const seedKnowledge = async (runtimeHome, projectId, revision, marker) => {
  const env = runtimeEnv(runtimeHome);
  const root = await ensureKnowledgeStoreDirectories(projectId, { env });
  await mkdir(path.join(root, 'knowledge', 'semantic'), { recursive: true });
  await mkdir(path.join(root, 'knowledge', 'policy'), { recursive: true });
  await mkdir(path.join(root, 'knowledge', 'candidates'), { recursive: true });
  await mkdir(path.join(root, 'knowledge', 'provenance'), { recursive: true });
  await writeFile(path.join(root, 'knowledge', 'revision.json'), JSON.stringify({ schemaVersion: 1, projectId, revision: String(revision), updatedAt: new Date().toISOString() }, null, 2));
  await writeFile(path.join(root, 'knowledge', 'semantic', 'verified-facts.jsonl'), `${JSON.stringify({ id: `fact-${marker}`, projectId, statement: `fact-${marker}` })}\n`);
  await writeFile(path.join(root, 'knowledge', 'policy', 'policy-anchors.jsonl'), `${JSON.stringify({ id: `policy-${marker}`, projectId, statement: `policy-${marker}` })}\n`);
  await writeFile(path.join(root, 'knowledge', 'candidates', 'pending.jsonl'), `${JSON.stringify({ id: `candidate-${marker}`, projectId, statement: `candidate-${marker}` })}\n`);
  await writeFile(path.join(root, 'knowledge', 'provenance', 'prov-log.jsonl'), `${JSON.stringify({ id: `provenance-${marker}`, projectId, source: marker })}\n`);
  await writeFile(path.join(root, 'context-packs', `${marker}.json`), JSON.stringify({ projectId, marker }));
  await writeFile(path.join(root, 'receipts', `${marker}.json`), JSON.stringify({ projectId, marker }));
  return root;
};

test('identity migration preserves SQLite state, active binding, multiple legacy IDs, and filesystem memory', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-memory-'));
  const projectRoot = path.join(runtimeHome, 'repo');
  const store = await openKernelStateStore({ runtimeHome });
  const canonicalId = 'path-canonical-memory';
  const legacyOrigin = 'github-com-org-memory';
  const legacyPackage = 'shared-memory-package';
  try {
    await mkdir(projectRoot, { recursive: true });
    await seedKnowledge(runtimeHome, legacyOrigin, 4, 'origin');
    await seedKnowledge(runtimeHome, legacyPackage, 6, 'package');

    store.createRun({
      runId: 'legacy-origin-run',
      objective: 'legacy origin',
      sourceIdentity: digest('a'),
      projectId: legacyOrigin,
      workspaceId: 'legacy-origin-workspace',
      taskContract: { projectId: legacyOrigin, nested: { project_id: legacyOrigin } },
    });
    store.createRun({
      runId: 'legacy-package-run',
      objective: 'legacy package',
      sourceIdentity: digest('b'),
      projectId: legacyPackage,
      workspaceId: 'legacy-package-workspace',
      taskContract: { projectId: legacyPackage, nested: { project_id: legacyPackage } },
    });
    registerWorkspace(store, 'legacy-origin-workspace', legacyOrigin, projectRoot);
    registerWorkspace(store, 'legacy-package-workspace', legacyPackage, projectRoot);
    store.createRunSteps('legacy-origin-run', [{
      stepId: 'origin-step',
      sequence: 1,
      objective: 'origin step',
      planRevision: 1,
      executionWorkspaceId: 'legacy-origin-workspace',
    }]);
    store.createRunSteps('legacy-package-run', [{
      stepId: 'package-step',
      sequence: 1,
      objective: 'package step',
      planRevision: 1,
      executionWorkspaceId: 'legacy-package-workspace',
    }]);
    store.createSessionBinding({
      bindingId: 'legacy-active-binding',
      sessionId: 'codex:legacy-identity',
      provider: 'codex',
      surface: 'host',
      runId: 'legacy-origin-run',
      projectId: legacyOrigin,
      workspaceId: 'legacy-origin-workspace',
      workspaceRoot: projectRoot,
      accessMode: 'owner',
      status: 'active',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    store.recordKnowledgeCandidate('legacy-candidate', 'legacy-origin-run', {
      projectId: legacyOrigin,
      proposedType: 'semantic_fact',
      candidateJson: { candidateId: 'legacy-candidate', projectId: legacyOrigin, statement: 'legacy candidate' },
    });
    store.saveKnowledgeRecord(legacyOrigin, 'legacy-record', {
      recordJson: { id: 'legacy-record', projectId: legacyOrigin, statement: 'legacy record' },
      revision: 4,
    });
    store.updateProjectKnowledgeRevision(legacyOrigin, 1, 4);
    store.saveKnowledgeRecord(legacyPackage, 'package-record', {
      recordJson: { id: 'package-record', projectId: legacyPackage, statement: 'package record' },
      revision: 6,
    });
    store.updateProjectKnowledgeRevision(legacyPackage, 1, 6);

    const registered = store.registerProjectIdentity({
      projectId: canonicalId,
      canonicalRoot: projectRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-canonical-memory',
      aliases: ['https://github.com/org/memory'],
      legacyProjectIds: [legacyOrigin, legacyPackage],
      legacyAliases: [
        { projectId: legacyOrigin, source: 'origin' },
        { projectId: legacyPackage, source: 'package' },
      ],
    });

    assert.equal(registered.projectId, canonicalId);
    assert.equal(store.getRun('legacy-origin-run').projectId, canonicalId);
    assert.equal(store.getRun('legacy-package-run').projectId, canonicalId);
    assert.equal(store.getProjectWorkspace('legacy-origin-workspace').projectId, canonicalId);
    assert.equal(store.getProjectWorkspace('legacy-package-workspace'), null, 'same-root legacy workspaces are consolidated without losing run references');
    assert.equal(store.getRun('legacy-package-run').workspaceId, 'legacy-origin-workspace');
    assert.equal(store.getRun('legacy-origin-run').taskContract.nested.project_id, canonicalId);
    assert.equal(store.getRun('legacy-package-run').taskContract.nested.project_id, canonicalId);
    assert.equal(store.getRunSteps('legacy-origin-run')[0].executionWorkspaceId, 'legacy-origin-workspace');
    assert.equal(store.getRunSteps('legacy-package-run')[0].executionWorkspaceId, 'legacy-origin-workspace');
    assert.equal(store.getRunSteps('legacy-origin-run')[0].stepId, 'origin-step');
    assert.equal(store.getRunSteps('legacy-package-run')[0].stepId, 'package-step');
    assert.equal(store.getActiveRunBinding({
      projectId: canonicalId,
      sessionId: 'codex:legacy-identity',
      runId: 'legacy-origin-run',
    }).projectId, canonicalId);
    assert.equal(store.getKnowledgeCandidates('legacy-origin-run')[0].projectId, canonicalId);
    assert.equal(store.listKnowledgeRecords({ projectId: canonicalId }).length, 2);
    assert.equal(store.getProjectKnowledgeRevision(canonicalId), 6);
    assert.deepEqual(store.getProjectIdentity({ alias: 'project-id:github-com-org-memory' }).projectId, canonicalId);
    assert.deepEqual(store.getProjectIdentity({ alias: 'project-id:shared-memory-package' }).projectId, canonicalId);

    const destination = projectKnowledgeDirectory(canonicalId, { env: runtimeEnv(runtimeHome) });
    const migratedRevision = JSON.parse(await readFile(path.join(destination, 'knowledge', 'revision.json'), 'utf8'));
    assert.equal(migratedRevision.projectId, canonicalId);
    assert.equal(migratedRevision.revision, '6');
    const facts = await readFile(path.join(destination, 'knowledge', 'semantic', 'verified-facts.jsonl'), 'utf8');
    assert.match(facts, new RegExp(`"projectId":"${canonicalId}"`));
    assert.match(facts, /fact-origin/);
    assert.match(facts, /fact-package/);
    assert.match(await readFile(path.join(destination, 'context-packs', 'origin.json'), 'utf8'), new RegExp(canonicalId));
    assert.match(await readFile(path.join(destination, 'receipts', 'origin.json'), 'utf8'), new RegExp(canonicalId));
    await assert.rejects(access(projectKnowledgeDirectory(legacyOrigin, { env: runtimeEnv(runtimeHome) })));
    await assert.rejects(access(projectKnowledgeDirectory(legacyPackage, { env: runtimeEnv(runtimeHome) })));
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('copy-first identity journal recovers safely after an interrupted namespace replacement', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-journal-'));
  const legacyId = 'legacy-journal-source';
  const canonicalId = 'path-journal-target';
  try {
    const source = await seedKnowledge(runtimeHome, legacyId, 7, 'journal');
    const pending = prepareMigration({ runtimeHome, legacyProjectIds: [legacyId], projectId: canonicalId });
    assert.deepEqual(pending.migratedProjectIds, [legacyId]);
    assert.match(await readFile(path.join(source, 'context-packs', 'journal.json'), 'utf8'), new RegExp(legacyId));

    recoverProjectKnowledgeNamespaceMigrations({ runtimeHome, isCommitted: () => false });
    assert.match(await readFile(path.join(source, 'context-packs', 'journal.json'), 'utf8'), new RegExp(legacyId));
    await assert.rejects(access(projectKnowledgeDirectory(canonicalId, { env: runtimeEnv(runtimeHome) })));

    const committed = prepareMigration({ runtimeHome, legacyProjectIds: [legacyId], projectId: canonicalId });
    assert.deepEqual(committed.migratedProjectIds, [legacyId]);
    recoverProjectKnowledgeNamespaceMigrations({ runtimeHome, isCommitted: () => true });
    assert.match(await readFile(path.join(projectKnowledgeDirectory(canonicalId, { env: runtimeEnv(runtimeHome) }), 'context-packs', 'journal.json'), 'utf8'), new RegExp(canonicalId));
    await assert.rejects(access(projectKnowledgeDirectory(legacyId, { env: runtimeEnv(runtimeHome) })));
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('identity migration rolls back filesystem and SQLite state when project-scoped rows collide', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-rollback-'));
  const projectRoot = path.join(runtimeHome, 'repo');
  const store = await openKernelStateStore({ runtimeHome });
  const canonicalId = 'path-rollback-target';
  const legacyId = 'legacy-rollback-package';
  try {
    await mkdir(projectRoot, { recursive: true });
    const source = await seedKnowledge(runtimeHome, legacyId, 3, 'rollback');
    store.createRun({ runId: 'rollback-run', objective: 'rollback', sourceIdentity: digest('c'), projectId: legacyId, workspaceId: 'rollback-source-workspace' });
    store.createRun({ runId: 'target-run', objective: 'target', sourceIdentity: digest('d'), projectId: canonicalId, workspaceId: 'rollback-target-workspace' });
    registerWorkspace(store, 'rollback-source-workspace', legacyId, projectRoot);
    registerWorkspace(store, 'rollback-target-workspace', canonicalId, projectRoot);
    store.acquireWorkspaceMutationLockV2({
      workspaceId: 'rollback-source-workspace',
      projectId: legacyId,
      runId: 'rollback-run',
      sessionToken: 'source-session',
    });
    store.acquireWorkspaceMutationLockV2({
      workspaceId: 'rollback-target-workspace',
      projectId: canonicalId,
      runId: 'target-run',
      sessionToken: 'target-session',
    });

    assert.throws(() => store.registerProjectIdentity({
      projectId: canonicalId,
      canonicalRoot: projectRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-rollback-target',
      legacyAliases: [{ projectId: legacyId, source: 'package' }],
    }), /UNIQUE constraint|constraint failed/);

    assert.equal(store.getRun('rollback-run').projectId, legacyId);
    assert.equal(store.getRun('target-run').projectId, canonicalId);
    assert.equal(store.getProjectIdentity({ projectId: canonicalId }), null);
    assert.match(await readFile(path.join(source, 'receipts', 'rollback.json'), 'utf8'), new RegExp(legacyId));
    await assert.rejects(access(projectKnowledgeDirectory(canonicalId, { env: runtimeEnv(runtimeHome) })));
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('common package alias without root ownership fails closed instead of merging cross-repository state', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-collision-'));
  const projectRoot = path.join(runtimeHome, 'second-repo');
  const store = await openKernelStateStore({ runtimeHome });
  const legacyId = 'same-package';
  try {
    await mkdir(projectRoot, { recursive: true });
    store.createRun({ runId: 'other-repo-run', objective: 'other repo', sourceIdentity: digest('e'), projectId: legacyId, workspaceId: 'other-repo-workspace' });
    assert.throws(() => store.registerProjectIdentity({
      projectId: 'path-second-repo',
      canonicalRoot: projectRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-second-repo',
      legacyAliases: [{ projectId: legacyId, source: 'package' }],
    }), /project_identity_legacy_ownership_unproven/);
    assert.equal(store.getRun('other-repo-run').projectId, legacyId);
    assert.equal(store.getProjectIdentity({ projectId: 'path-second-repo' }), null);
    assert.equal(store.getProjectIdentity({ alias: `project-id:${legacyId}` }), null);
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('one immutable project identity can own multiple worktree roots without digest drift', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-worktrees-'));
  const rootA = path.join(runtimeHome, 'worktree-a');
  const rootB = path.join(runtimeHome, 'worktree-b');
  const store = await openKernelStateStore({ runtimeHome });
  try {
    const runGit = (cwd, args) => {
      const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
      assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
    };
    runGit(runtimeHome, ['init', rootA]);
    runGit(rootA, ['-c', 'user.name=Kernel Test', '-c', 'user.email=kernel@example.invalid', 'commit', '--allow-empty', '-m', 'initial']);
    runGit(rootA, ['worktree', 'add', '--detach', rootB]);
    const gitCommonDir = canonicalRoot(path.join(rootA, '.git'));
    const first = store.registerProjectIdentity({
      projectId: 'path-multi-worktree',
      canonicalRoot: rootA,
      identitySource: 'workspace_root',
      identityDigest: 'digest-multi-worktree',
      gitCommonDir,
    });
    store.registerProjectWorkspace({
      workspaceId: 'worktree-a',
      canonicalRoot: canonicalRoot(rootA),
      gitCommonDir,
      gitWorktreeDir: null,
      identity: { projectId: first.projectId, canonicalRoot: canonicalRoot(rootA) },
    });
    const second = store.registerProjectIdentity({
      projectId: 'path-multi-worktree',
      canonicalRoot: rootB,
      identitySource: 'local_identity_file',
      identityDigest: 'digest-must-not-replace',
      gitCommonDir,
    });
    store.registerProjectWorkspace({
      workspaceId: 'worktree-b',
      canonicalRoot: canonicalRoot(rootB),
      gitCommonDir,
      gitWorktreeDir: null,
      identity: { projectId: second.projectId, canonicalRoot: canonicalRoot(rootB) },
    });
    const persisted = store.getProjectIdentity({ projectId: 'path-multi-worktree' });
    assert.equal(second.projectId, first.projectId);
    assert.equal(persisted.identityDigest, 'digest-multi-worktree');
    assert.equal(persisted.canonicalRoot, canonicalRoot(rootA));
    assert.equal(store.getProjectWorkspace('worktree-a').projectId, 'path-multi-worktree');
    assert.equal(store.getProjectWorkspace('worktree-b').projectId, 'path-multi-worktree');
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});
