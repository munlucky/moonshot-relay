import { assertTestPresent, assertTestRecord, assertTestString } from './helpers/assert-value.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { pathHashId, resolveKernelProjectIdentity, normalizeRemoteUrl, sanitizeId } from '../src/kernel/project-identity.js';
import { kernelDbPath, openKernelStateStore } from '../src/kernel/state-store.js';
import {
  approveKernelProjectIdentityRepair,
  bootstrapKernelProjectIdentity as bootstrapKernelProjectIdentityCore,
  inspectKernelProjectIdentity,
  repairKernelProjectIdentity as repairKernelProjectIdentityCore,
} from '../src/kernel/project-identity-preflight.js';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { resolveStableWorkspaceIdentity } from '../src/host/kernel/workspace/stable-workspace.js';
import { registerWorktreeObservation } from '../src/kernel/run/workspace-registration.js';

const bootstrapKernelProjectIdentity = (options = {}) => bootstrapKernelProjectIdentityCore({
  ...options,
  resolveStableWorkspaceIdentity,
});
const repairKernelProjectIdentity = (options = {}) => repairKernelProjectIdentityCore({
  ...options,
  resolveStableWorkspaceIdentity,
});

const canonicalTestRoot = (value: string) => {
  const resolved = realpathSync(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

const runGit = (cwd: string, args: string[]) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
};

test('resolveKernelProjectIdentity anchors identity to the workspace root and keeps origin as an alias', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-test-'));
  const gitDir = path.join(tmp, '.git');
  await mkdir(gitDir, { recursive: true });
  await writeFile(path.join(gitDir, 'config'), '[remote "origin"]\n  url = git@github.com:myorg/my-cool-project.git\n');

  const result = resolveKernelProjectIdentity({ cwd: tmp, env: { MOON_RELAY_KERNEL_HOME: path.join(tmp, '.moon-relay-kernel') } });
  assert.match(result.projectId, /^path-[a-f0-9]{16}$/);
  assert.equal(result.identitySource, 'workspace_root');
  assert.deepEqual(result.aliases, ['https://github.com/myorg/my-cool-project']);
  assert.ok(result.identityDigest);
  assert.ok(result.namespaces.projectKnowledgeRoot.includes(result.projectId));
});

test('adding origin after the first resolution preserves projectId and identityDigest', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-origin-migration-'));
  try {
    const gitDir = path.join(tmp, '.git');
    await mkdir(gitDir, { recursive: true });
    await writeFile(path.join(gitDir, 'config'), '[core]\n\trepositoryformatversion = 0\n');
    const env = { MOON_RELAY_KERNEL_HOME: path.join(tmp, '.moon-relay-kernel') };
    const before = resolveKernelProjectIdentity({ cwd: tmp, env });
    await writeFile(path.join(gitDir, 'config'), '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://github.com/myorg/my-cool-project.git\n');
    const after = resolveKernelProjectIdentity({ cwd: tmp, env });
    assert.equal(after.projectId, before.projectId);
    assert.equal(after.identityDigest, before.identityDigest);
    assert.deepEqual(after.aliases, ['https://github.com/myorg/my-cool-project']);
    assert.ok(after.legacyProjectIds.includes('github-com-myorg-my-cool-project'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('normalizeRemoteUrl normalizes git ssh and https URLs cleanly', () => {
  assert.equal(normalizeRemoteUrl('git@github.com:foo/bar.git'), 'https://github.com/foo/bar');
  assert.equal(normalizeRemoteUrl('https://github.com/foo/bar.git/'), 'https://github.com/foo/bar');
});

test('resolveKernelProjectIdentity prefers local project.identity.yaml when present', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-test-'));
  const localDir = path.join(tmp, '.moon-relay');
  await mkdir(localDir, { recursive: true });
  await writeFile(path.join(localDir, 'project.identity.yaml'), 'projectId: explicit-project-id\n');

  const result = resolveKernelProjectIdentity({ cwd: tmp, env: { MOON_RELAY_KERNEL_HOME: path.join(tmp, '.moon-relay-kernel') } });
  assert.equal(result.projectId, 'explicit-project-id');
  assert.equal(result.identitySource, 'local_identity_file');
});

test('legacy project-aliases.json direct maps accept Windows backslash and forward-slash root keys', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-alias-path-'));
  try {
    const stateDir = path.join(tmp, '.moon-relay-kernel', 'state');
    await mkdir(stateDir, { recursive: true });
    const resolved = path.resolve(tmp);
    const keys = [resolved.toLowerCase(), resolved.replaceAll('\\', '/').toLowerCase()];
    for (const key of keys) {
      await writeFile(path.join(stateDir, 'project-aliases.json'), JSON.stringify({
        [key]: { projectId: 'legacy-windows-identity', identitySource: 'account_alias_registry' },
      }));
      const result = resolveKernelProjectIdentity({ cwd: tmp, env: { MOON_RELAY_KERNEL_HOME: path.join(tmp, '.moon-relay-kernel') } });
      assert.equal(result.projectId, 'legacy-windows-identity');
      assert.equal(result.identitySource, 'account_alias_registry');
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('local identity changes retain persisted and path-derived lineage candidates for migration', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-lineage-'));
  const runtimeHome = path.join(tmp, '.moon-relay-kernel');
  const legacyPersisted = 'legacy-persisted-lineage';
  try {
    await mkdir(path.join(tmp, '.git'), { recursive: true });
    await mkdir(path.join(tmp, '.moon-relay'), { recursive: true });
    await writeFile(path.join(tmp, '.moon-relay', 'project.identity.yaml'), 'projectId: explicit-lineage-project\n');
    await mkdir(path.join(runtimeHome, 'state'), { recursive: true });
    await writeFile(path.join(runtimeHome, 'state', 'project-aliases.json'), JSON.stringify({
      [path.resolve(tmp).toLowerCase()]: { projectId: legacyPersisted, identitySource: 'account_alias_registry' },
    }));

    const identity = resolveKernelProjectIdentity({ cwd: tmp, env: { MOON_RELAY_KERNEL_HOME: runtimeHome } });
    assert.equal(identity.projectId, 'explicit-lineage-project');
    assert.ok(identity.legacyProjectIds.includes(legacyPersisted));
    assert.ok(identity.legacyProjectIds.includes(pathHashId(tmp)));
    assert.ok(identity.legacyAliases.some((candidate) => candidate.projectId === legacyPersisted && candidate.source === 'persisted'));

    const store = await openKernelStateStore({ runtimeHome });
    try {
      store.createRun({ runId: 'persisted-lineage-run', objective: 'lineage', sourceIdentity: `sha256:${'a'.repeat(64)}`, projectId: legacyPersisted, workspaceId: 'persisted-lineage-workspace' });
      store.registerProjectWorkspace({
        workspaceId: 'persisted-lineage-workspace',
        canonicalRoot: canonicalTestRoot(tmp),
        gitCommonDir: null,
        gitWorktreeDir: null,
        identity: { projectId: legacyPersisted },
      });
      const registered = store.registerProjectIdentity(identity);
      assert.equal(assertTestPresent(registered).projectId, 'explicit-lineage-project');
      assert.equal(assertTestPresent(store.getRun('persisted-lineage-run')).projectId, 'explicit-lineage-project');
      assert.equal(assertTestPresent(store.getProjectIdentity({ alias: `project-id:${legacyPersisted}` })).projectId, 'explicit-lineage-project');
    } finally {
      store.close();
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('runtime identity registration is immutable, aliases are idempotent, and legacy project rows migrate atomically', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-state-'));
  const workspaceRoot = path.join(runtimeHome, 'workspace');
  try {
    await mkdir(workspaceRoot, { recursive: true });
    const store = await openKernelStateStore({ runtimeHome });
    const sourceIdentity = `sha256:${'a'.repeat(64)}`;
    store.createRun({
      runId: 'legacy-identity-run',
      objective: 'legacy identity migration',
      sourceIdentity,
      projectId: 'github-com-myorg-my-cool-project',
      workspaceId: 'legacy-identity-workspace',
    });
    store.registerProjectWorkspace({
      workspaceId: 'legacy-identity-workspace',
      canonicalRoot: workspaceRoot,
      gitCommonDir: null,
      gitWorktreeDir: null,
      identity: { projectId: 'github-com-myorg-my-cool-project', canonicalRoot: workspaceRoot },
    });
    const first = store.registerProjectIdentity({
      projectId: 'path-immutable-project',
      canonicalRoot: workspaceRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-immutable-project',
      aliases: [],
      legacyProjectIds: ['github-com-myorg-my-cool-project'],
      legacyAliases: [{ projectId: 'github-com-myorg-my-cool-project', source: 'origin' }],
    });
    const second = store.registerProjectIdentity({
      projectId: 'github-com-myorg-my-cool-project',
      canonicalRoot: workspaceRoot,
      identitySource: 'git_remote_origin',
      identityDigest: 'digest-must-not-replace',
      aliases: ['https://github.com/myorg/my-cool-project'],
      legacyProjectIds: [],
    });
    assert.equal(assertTestPresent(first).projectId, 'path-immutable-project');
    assert.equal(assertTestPresent(second).projectId, assertTestPresent(first).projectId);
    assert.equal(assertTestPresent(second).identityDigest, assertTestPresent(first).identityDigest);
    assert.deepEqual(assertTestPresent(second).aliases, ['https://github.com/myorg/my-cool-project']);
    assert.equal(assertTestPresent(store.getProjectIdentity({ alias: 'https://github.com/myorg/my-cool-project' })).projectId, assertTestPresent(first).projectId);
    assert.equal(assertTestPresent(store.getRun('legacy-identity-run')).projectId, assertTestPresent(first).projectId);
    const repeat = store.registerProjectIdentity({
      projectId: 'path-immutable-project',
      canonicalRoot: workspaceRoot,
      identitySource: 'workspace_root',
      identityDigest: assertTestPresent(first).identityDigest,
      aliases: ['https://github.com/myorg/my-cool-project'],
      legacyProjectIds: [],
    });
    assert.deepEqual(assertTestPresent(repeat).aliases, assertTestPresent(second).aliases);
    store.close();
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('POSIX canonical roots preserve meaningful surrounding whitespace', { skip: process.platform === 'win32' ? 'POSIX-only absolute-root semantics' : false }, async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-posix-whitespace-'));
  const root = path.join(runtimeHome, 'repo');
  const spacedRoot = `${root} `;
  await mkdir(root, { recursive: true });
  await mkdir(spacedRoot, { recursive: true });
  const store = await openKernelStateStore({ runtimeHome });
  try {
    const plain = store.registerProjectIdentity({
      projectId: 'path-posix-whitespace-plain',
      canonicalRoot: root,
      identitySource: 'workspace_root',
      identityDigest: 'digest-posix-whitespace-plain',
    });
    const spaced = store.registerProjectIdentity({
      projectId: 'path-posix-whitespace-spaced',
      canonicalRoot: spacedRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-posix-whitespace-spaced',
    });

    assert.equal(assertTestPresent(plain).projectId, 'path-posix-whitespace-plain');
    assert.equal(assertTestPresent(spaced).projectId, 'path-posix-whitespace-spaced');
    assert.notEqual(assertTestPresent(plain).canonicalRoot, assertTestPresent(spaced).canonicalRoot);
    assert.equal(
      assertTestPresent(store.getProjectIdentity({ canonicalRoot: root })).projectId,
      'path-posix-whitespace-plain',
    );
    assert.equal(
      assertTestPresent(store.getProjectIdentity({ canonicalRoot: spacedRoot })).projectId,
      'path-posix-whitespace-spaced',
    );
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('invalid Windows ownership roots cannot be registered or resolved by exact persisted lookup', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-invalid-windows-root-'));
  let store = await openKernelStateStore({ runtimeHome });
  try {
    for (const canonicalRoot of ['C:repo', 'C:/CON']) {
      assert.throws(() => store.registerProjectIdentity({
        projectId: `path-invalid-${canonicalRoot.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
        canonicalRoot,
        identitySource: 'workspace_root',
        identityDigest: 'digest-invalid-windows-root',
      }), (error: unknown) => assertTestRecord(error).code === 'project_identity_invalid');
    }
  } finally {
    store.close();
  }

  const db = new DatabaseSync(kernelDbPath(runtimeHome));
  try {
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO project_identities(
        project_id, canonical_root, identity_source,
        identity_digest, aliases_json, created_at, updated_at
      )
      VALUES(?, ?, ?, ?, '[]', ?, ?)
    `).run(
      'path-invalid-persisted-root',
      'C:/CON',
      'workspace_root',
      'digest-invalid-persisted-root',
      timestamp,
      timestamp,
    );
  } finally {
    db.close();
  }

  store = await openKernelStateStore({ runtimeHome });
  try {
    assert.equal(store.getProjectIdentity({ canonicalRoot: 'C:/CON' }), null);
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('canonicalIdentityRoot preserves POSIX path casing on case-sensitive platforms', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-case-AB12-'));
  try {
    const gitDir = path.join(tmp, '.git');
    await mkdir(gitDir, { recursive: true });
    await writeFile(path.join(gitDir, 'config'), '[core]\n\trepositoryformatversion = 0\n');
    const env = { MOON_RELAY_KERNEL_HOME: path.join(tmp, '.moon-relay-kernel') };
    const result = resolveKernelProjectIdentity({ cwd: tmp, env });
    if (process.platform !== 'win32') {
      assert.equal(result.canonicalRoot, realpathSync(tmp).replaceAll('\\', '/'));
    } else {
      assert.equal(result.canonicalRoot, path.resolve(tmp).replaceAll('\\', '/').toLowerCase());
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('identity preflight bootstraps a fresh namespace without a Kernel Run', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-preflight-bootstrap-'));
  const runtimeHome = path.join(tmp, 'runtime');
  try {
    await mkdir(path.join(tmp, '.git'), { recursive: true });
    const before = await inspectKernelProjectIdentity({ projectRoot: tmp, runtimeHome });
    assert.equal(before.status, 'bootstrap_required');
    const bootstrapped = await bootstrapKernelProjectIdentity({ projectRoot: tmp, runtimeHome, policy: 'isolate' });
    assert.equal(bootstrapped.status, 'ready');
    assert.equal(bootstrapped.mutation, 'isolated');
    assert.ok(bootstrapped.workspaceId);
    assert.equal((await inspectKernelProjectIdentity({ projectRoot: tmp, runtimeHome })).status, 'ready');

    const store = await openKernelStateStore({ runtimeHome });
    try {
      assert.equal(store.listActiveRuns({ projectId: bootstrapped.projectId }).length, 0);
      assert.equal(assertTestPresent(store.getProjectIdentity({ canonicalRoot: path.resolve(tmp) })).projectId, bootstrapped.projectId);
    } finally {
      store.close();
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('linked worktree identity preflight reuses the proven logical project identity', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-linked-worktree-'));
  const repository = path.join(fixtureRoot, 'repository');
  const linkedWorktree = path.join(fixtureRoot, 'linked-worktree');
  const runtimeHome = path.join(fixtureRoot, 'runtime');
  try {
    await mkdir(repository, { recursive: true });
    await writeFile(path.join(repository, 'tracked.txt'), 'fixture\n');
    runGit(repository, ['init']);
    runGit(repository, ['config', 'user.email', 'kernel-test@example.invalid']);
    runGit(repository, ['config', 'user.name', 'Kernel Test']);
    runGit(repository, ['add', '.']);
    runGit(repository, ['commit', '-m', 'fixture']);
    runGit(repository, ['worktree', 'add', '-b', 'linked', linkedWorktree, 'HEAD']);

    const primary = await bootstrapKernelProjectIdentity({ projectRoot: repository, runtimeHome, policy: 'isolate' });
    const linked = await inspectKernelProjectIdentity({ projectRoot: linkedWorktree, runtimeHome });

    assert.equal(linked.status, 'ready', JSON.stringify({
      primary: { projectId: primary.projectId, canonicalRoot: primary.canonicalRoot, gitCommonDir: primary.gitCommonDir },
      linked: { status: linked.status, projectId: linked.projectId, resolvedProjectId: linked.resolvedProjectId, canonicalRoot: linked.canonicalRoot, legacyCandidates: linked.legacyCandidates },
      linkedResolution: resolveKernelProjectIdentity({ cwd: linkedWorktree, env: { MOON_RELAY_KERNEL_HOME: runtimeHome } }),
    }));
    assert.equal(linked.projectId, primary.projectId);
    assert.equal(assertTestPresent(linked.identity).projectId, primary.projectId);
    assert.equal(assertTestPresent(linked.identity).canonicalRoot, canonicalTestRoot(repository));
    assert.notEqual(linked.canonicalRoot, assertTestPresent(linked.identity).canonicalRoot);

    const controlPlane = await createKernelControlPlane({
      runtimeHome,
      projectRoot: linkedWorktree,
      env: {
        MOON_RELAY_KERNEL_HOME: runtimeHome,
        MOON_RELAY_KERNEL_PROVIDER: 'codex',
        MOON_RELAY_KERNEL_SESSION_ID: 'codex:linked-worktree-preflight',
      },
      requireHostBinding: false,
    });
    await controlPlane.close();
  } finally {
    try { runGit(repository, ['worktree', 'remove', '--force', linkedWorktree]); } catch {}
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('identity preflight isolates unowned legacy data and preserves it', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-preflight-legacy-'));
  const runtimeHome = path.join(tmp, 'runtime');
  const legacyProjectId = 'github-com-example-legacy-project';
  try {
    await mkdir(path.join(tmp, '.git'), { recursive: true });
    await writeFile(path.join(tmp, '.git', 'config'), '[remote "origin"]\n  url = https://github.com/example/legacy-project.git\n');
    const store = await openKernelStateStore({ runtimeHome });
    store.createRun({
      runId: 'legacy-unowned-run',
      objective: 'legacy state',
      sourceIdentity: `sha256:${'b'.repeat(64)}`,
      projectId: legacyProjectId,
    });
    store.close();

    const before = await inspectKernelProjectIdentity({ projectRoot: tmp, runtimeHome });
    assert.equal(before.status, 'repair_required');
    assert.equal(before.unresolvedLegacyCandidates[0].projectId, legacyProjectId);
    const isolated = await bootstrapKernelProjectIdentity({ projectRoot: tmp, runtimeHome, policy: 'isolate' });
    assert.equal(isolated.legacyState, 'preserved-unimported');
    assert.notEqual(isolated.projectId, legacyProjectId);

    const afterStore = await openKernelStateStore({ runtimeHome });
    try {
      assert.equal(assertTestPresent(afterStore.getRun('legacy-unowned-run')).projectId, legacyProjectId);
      assert.equal(assertTestPresent(afterStore.getProjectIdentity({ canonicalRoot: path.resolve(tmp) })).projectId, isolated.projectId);
    } finally {
      afterStore.close();
    }

    await approveKernelProjectIdentityRepair({
      projectRoot: tmp,
      runtimeHome,
      legacyProjectId,
      approvalRef: 'operator:isolated-legacy-project',
      approvedBy: os.userInfo().username,
    });
    const repaired = await repairKernelProjectIdentity({
      projectRoot: tmp,
      runtimeHome,
      legacyProjectId,
      approvalRef: 'operator:isolated-legacy-project',
    });
    assert.equal(repaired.projectId, legacyProjectId);
    assert.equal(repaired.mutation, 'identity-adopted-with-current-state-merge');

    const repairedStore = await openKernelStateStore({ runtimeHome });
    try {
      assert.equal(repairedStore.getProjectIdentity({ projectId: isolated.projectId }), null);
      assert.equal(assertTestPresent(repairedStore.getProjectIdentity({ projectId: legacyProjectId })).projectId, legacyProjectId);
      assert.equal(assertTestPresent(repairedStore.getRun('legacy-unowned-run')).projectId, legacyProjectId);
    } finally {
      repairedStore.close();
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('identity repair adopts a selected legacy namespace only with an approval reference', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-preflight-repair-'));
  const runtimeHome = path.join(tmp, 'runtime');
  const legacyProjectId = 'github-com-example-approved-project';
  try {
    await mkdir(path.join(tmp, '.git'), { recursive: true });
    await writeFile(path.join(tmp, '.git', 'config'), '[remote "origin"]\n  url = https://github.com/example/approved-project.git\n');
    const store = await openKernelStateStore({ runtimeHome });
    store.createRun({
      runId: 'legacy-approved-run',
      objective: 'legacy state',
      sourceIdentity: `sha256:${'c'.repeat(64)}`,
      projectId: legacyProjectId,
    });
    store.close();

    await assert.rejects(
      repairKernelProjectIdentity({ projectRoot: tmp, runtimeHome, legacyProjectId }),
      (error) => assertTestRecord(error).code === 'project_identity_approval_required',
    );
    const approval = await approveKernelProjectIdentityRepair({
      projectRoot: tmp,
      runtimeHome,
      legacyProjectId,
      approvalRef: 'operator:approved-project',
      approvedBy: os.userInfo().username,
    });
    assert.equal(approval.status, 'approved');
    const repaired = await repairKernelProjectIdentity({
      projectRoot: tmp,
      runtimeHome,
      legacyProjectId,
      approvalRef: 'operator:approved-project',
    });
    assert.equal(repaired.status, 'ready');
    assert.equal(repaired.projectId, legacyProjectId);
    assert.equal(repaired.legacyState, 'retained-under-adopted-id');
    assert.equal(repaired.approval.approvedBy, os.userInfo().username);
    assert.deepEqual(repaired.approval.signer, { kind: 'os-user', username: os.userInfo().username, uid: typeof process.getuid === 'function' ? String(process.getuid()) : null });
    assert.match(assertTestString(repaired.approval.approvalDigest), /^hmac-sha256:/);
    assert.deepEqual(repaired.receipt.signer, repaired.approval.signer);
    assert.ok(repaired.receipt.path);

    const afterStore = await openKernelStateStore({ runtimeHome });
    try {
      assert.equal(assertTestPresent(afterStore.getProjectIdentity({ canonicalRoot: path.resolve(tmp) })).projectId, legacyProjectId);
      assert.equal(assertTestPresent(afterStore.getRun('legacy-approved-run')).projectId, legacyProjectId);
      assert.ok(afterStore.getProjectWorkspace(repaired.workspaceId));
    } finally {
      afterStore.close();
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('distinct POSIX mount spellings do not become repository ownership evidence by themselves', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-distinct-posix-mounts-'));
  const store = await openKernelStateStore({ runtimeHome });
  try {
    const cMount = store.registerProjectIdentity({
      projectId: 'path-posix-c-mount',
      canonicalRoot: '/c/dev/same-spelling',
      identitySource: 'workspace_root',
      identityDigest: 'digest-posix-c-mount',
    });
    const mntMount = store.registerProjectIdentity({
      projectId: 'path-posix-mnt-c-mount',
      canonicalRoot: '/mnt/c/dev/same-spelling',
      identitySource: 'workspace_root',
      identityDigest: 'digest-posix-mnt-c-mount',
    });

    assert.equal(assertTestPresent(cMount).projectId, 'path-posix-c-mount');
    assert.equal(assertTestPresent(mntMount).projectId, 'path-posix-mnt-c-mount');
    assert.equal(
      assertTestPresent(store.getProjectIdentity({ canonicalRoot: '/c/dev/same-spelling' })).projectId,
      'path-posix-c-mount',
    );
    assert.equal(
      assertTestPresent(store.getProjectIdentity({ canonicalRoot: '/mnt/c/dev/same-spelling' })).projectId,
      'path-posix-mnt-c-mount',
    );
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('cross-surface drive spelling reuses the persisted project identity instead of creating a split namespace', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-cross-surface-root-'));
  const store = await openKernelStateStore({ runtimeHome });
  try {
    const windowsProjectId = 'path-windows-surface';
    store.registerProjectIdentity({
      projectId: windowsProjectId,
      canonicalRoot: 'C:\\Dev\\CrossSurfaceRepo',
      identitySource: 'workspace_root',
      identityDigest: 'digest-windows-surface',
    });
    store.registerProjectWorkspace({
      workspaceId: 'workspace-windows-surface',
      canonicalRoot: 'C:\\Dev\\CrossSurfaceRepo',
      gitCommonDir: 'C:\\Dev\\CrossSurfaceRepo\\.git',
      gitWorktreeDir: 'C:\\Dev\\CrossSurfaceRepo\\.git',
      identity: { projectId: windowsProjectId, canonicalRoot: 'C:\\Dev\\CrossSurfaceRepo' },
    });

    const reused = store.registerProjectIdentity({
      projectId: 'path-posix-surface',
      canonicalRoot: '/c/dev/crosssurfacerepo',
      identitySource: 'workspace_root',
      identityDigest: 'digest-posix-surface',
      gitCommonDir: '/c/dev/crosssurfacerepo/.git',
    });

    assert.equal(assertTestPresent(reused).projectId, windowsProjectId);
    assert.equal(store.getProjectIdentity({ projectId: 'path-posix-surface' }), null);
    // A mounted spelling is not ownership evidence by itself. Registration
    // reused the identity only because root and Git common-dir observations
    // matched as a pair.
    assert.equal(store.getProjectIdentity({ canonicalRoot: '/c/dev/crosssurfacerepo' }), null);
    assert.equal(store.getProjectIdentity({ canonicalRoot: 'C:\\Dev\\CrossSurfaceRepo ' }), null);
    assert.equal(store.getProjectIdentity({ canonicalRoot: 'C:\\Dev\\CON\\..\\CrossSurfaceRepo' }), null);
    assert.equal(store.getProjectIdentity({ canonicalRoot: 'C:' }), null);
    assert.equal(store.getProjectIdentity({ canonicalRoot: 'C:CrossSurfaceRepo' }), null);
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('project identity merge fails closed when the source project-id alias is owned by a third identity', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-alias-conflict-'));
  const sourceRoot = path.join(runtimeHome, 'source');
  const targetRoot = path.join(runtimeHome, 'target');
  const thirdRoot = path.join(runtimeHome, 'third');
  const gitCommonDir = path.join(runtimeHome, 'shared.git');
  await Promise.all([
    mkdir(sourceRoot, { recursive: true }),
    mkdir(targetRoot, { recursive: true }),
    mkdir(thirdRoot, { recursive: true }),
    mkdir(gitCommonDir, { recursive: true }),
  ]);
  const sourceProjectId = 'path-alias-source';
  const targetProjectId = 'path-alias-target';
  const thirdProjectId = 'path-alias-third';
  const store = await openKernelStateStore({ runtimeHome });
  try {
    store.registerProjectIdentity({
      projectId: sourceProjectId,
      canonicalRoot: sourceRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-alias-source',
    });
    store.registerProjectIdentity({
      projectId: targetProjectId,
      canonicalRoot: targetRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-alias-target',
    });
    store.registerProjectIdentity({
      projectId: thirdProjectId,
      canonicalRoot: thirdRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-alias-third',
      aliases: [`project-id:${sourceProjectId}`],
    });
    store.registerProjectWorkspace({
      workspaceId: 'workspace-alias-source',
      canonicalRoot: sourceRoot,
      gitCommonDir,
      gitWorktreeDir: gitCommonDir,
      identity: { projectId: sourceProjectId, canonicalRoot: sourceRoot },
    });
    store.registerProjectWorkspace({
      workspaceId: 'workspace-alias-target',
      canonicalRoot: targetRoot,
      gitCommonDir,
      gitWorktreeDir: gitCommonDir,
      identity: { projectId: targetProjectId, canonicalRoot: targetRoot },
    });
    store.createRun({
      runId: 'run-alias-source',
      objective: 'source state must remain when alias ownership conflicts',
      sourceIdentity: 'sha256:' + 'a'.repeat(64),
      projectId: sourceProjectId,
      workspaceId: 'workspace-alias-source',
    });
    const sourceKnowledgeRoot = path.join(runtimeHome, 'state', 'projects', sourceProjectId);
    const sourceKnowledgeMarker = path.join(sourceKnowledgeRoot, 'context-packs', 'alias-conflict.json');
    await mkdir(path.dirname(sourceKnowledgeMarker), { recursive: true });
    await writeFile(
      sourceKnowledgeMarker,
      JSON.stringify({ projectId: sourceProjectId, marker: 'must-not-stage-before-alias-check' }),
    );

    assert.throws(() => store.mergeProjectIdentity({
      sourceProjectId,
      targetProjectId,
      canonicalRoot: sourceRoot,
      gitCommonDir,
    }), (error: unknown) => (
      assertTestRecord(error).code === 'project_identity_alias_conflict'
    ));
    assert.equal(assertTestPresent(store.getProjectIdentity({ projectId: sourceProjectId })).projectId, sourceProjectId);
    assert.equal(assertTestPresent(store.getProjectIdentity({ projectId: targetProjectId })).projectId, targetProjectId);
    assert.equal(assertTestPresent(store.getProjectIdentity({ alias: `project-id:${sourceProjectId}` })).projectId, thirdProjectId);
    assert.equal(assertTestPresent(store.getRun('run-alias-source')).projectId, sourceProjectId);
    assert.equal(
      await readFile(sourceKnowledgeMarker, 'utf8'),
      JSON.stringify({ projectId: sourceProjectId, marker: 'must-not-stage-before-alias-check' }),
    );
    const projectNamespaces = await readdir(path.join(runtimeHome, 'state', 'projects'));
    assert.equal(projectNamespaces.includes(targetProjectId), false);
    assert.deepEqual(
      projectNamespaces.filter((name) => name.startsWith('.identity-migration-')),
      [],
    );
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('project identity merge rejects a third-party target project-id alias before namespace migration preparation', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-target-alias-conflict-'));
  const sourceRoot = path.join(runtimeHome, 'source');
  const thirdRoot = path.join(runtimeHome, 'third');
  const sourceProjectId = 'path-target-alias-source';
  const targetProjectId = 'legacy-target-alias-destination';
  const thirdProjectId = 'path-target-alias-third';
  await Promise.all([
    mkdir(sourceRoot, { recursive: true }),
    mkdir(thirdRoot, { recursive: true }),
  ]);
  const store = await openKernelStateStore({ runtimeHome });
  try {
    store.registerProjectIdentity({
      projectId: sourceProjectId,
      canonicalRoot: sourceRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-target-alias-source',
    });
    store.registerProjectIdentity({
      projectId: thirdProjectId,
      canonicalRoot: thirdRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-target-alias-third',
      aliases: [`project-id:${targetProjectId}`],
    });
    store.createRun({
      runId: 'run-target-alias-source',
      objective: 'source state must remain when target alias ownership conflicts',
      sourceIdentity: 'sha256:' + 'c'.repeat(64),
      projectId: sourceProjectId,
    });
    store.createRun({
      runId: 'run-target-alias-existing-data',
      objective: 'approved target has persisted state but no identity row',
      sourceIdentity: 'sha256:' + 'd'.repeat(64),
      projectId: targetProjectId,
    });
    const sourceKnowledgeRoot = path.join(runtimeHome, 'state', 'projects', sourceProjectId);
    const sourceKnowledgeMarker = path.join(sourceKnowledgeRoot, 'context-packs', 'target-alias-conflict.json');
    await mkdir(path.dirname(sourceKnowledgeMarker), { recursive: true });
    await writeFile(
      sourceKnowledgeMarker,
      JSON.stringify({ projectId: sourceProjectId, marker: 'must-not-stage-before-target-alias-check' }),
    );

    assert.throws(() => store.mergeProjectIdentity({
      sourceProjectId,
      targetProjectId,
      canonicalRoot: sourceRoot,
      approvedTargetIdentity: {
        projectId: targetProjectId,
        canonicalRoot: sourceRoot,
        identitySource: 'operator_approved_legacy',
        identityDigest: 'digest-approved-target-alias',
      },
    }), (error: unknown) => (
      assertTestRecord(error).code === 'project_identity_alias_conflict'
    ));

    assert.equal(assertTestPresent(store.getProjectIdentity({ projectId: sourceProjectId })).projectId, sourceProjectId);
    assert.equal(store.getProjectIdentity({ projectId: targetProjectId }), null);
    assert.equal(
      assertTestPresent(store.getProjectIdentity({ alias: `project-id:${targetProjectId}` })).projectId,
      thirdProjectId,
    );
    assert.equal(assertTestPresent(store.getRun('run-target-alias-source')).projectId, sourceProjectId);
    assert.equal(
      await readFile(sourceKnowledgeMarker, 'utf8'),
      JSON.stringify({ projectId: sourceProjectId, marker: 'must-not-stage-before-target-alias-check' }),
    );
    const projectNamespaces = await readdir(path.join(runtimeHome, 'state', 'projects'));
    assert.equal(projectNamespaces.includes(targetProjectId), false);
    assert.deepEqual(
      projectNamespaces.filter((name) => name.startsWith('.identity-migration-')),
      [],
    );
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('initial identity registration checks orphan alias ownership before namespace migration preparation', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-orphan-alias-preflight-'));
  const targetRoot = path.join(runtimeHome, 'target');
  const legacyProjectId = 'legacy-orphan-alias-source';
  const targetProjectId = 'path-orphan-alias-target';
  const orphanOwnerProjectId = 'orphan-alias-owner';
  const conflictingAlias = 'https://example.invalid/orphan/alias.git';
  await mkdir(targetRoot, { recursive: true });

  let store = await openKernelStateStore({ runtimeHome });
  try {
    store.registerProjectWorkspace({
      workspaceId: 'workspace-orphan-alias-source',
      canonicalRoot: targetRoot,
      gitCommonDir: null,
      gitWorktreeDir: null,
      identity: { projectId: legacyProjectId, canonicalRoot: targetRoot },
    });
    store.createRun({
      runId: 'run-orphan-alias-source',
      objective: 'legacy state must remain before orphan alias preflight',
      sourceIdentity: 'sha256:' + '9'.repeat(64),
      projectId: legacyProjectId,
      workspaceId: 'workspace-orphan-alias-source',
    });
  } finally {
    store.close();
  }

  const sourceKnowledgeMarker = path.join(
    runtimeHome,
    'state',
    'projects',
    legacyProjectId,
    'context-packs',
    'orphan-alias-preflight.json',
  );
  await mkdir(path.dirname(sourceKnowledgeMarker), { recursive: true });
  await writeFile(sourceKnowledgeMarker, JSON.stringify({ marker: 'must-remain-before-preflight' }));

  const db = new DatabaseSync(kernelDbPath(runtimeHome));
  try {
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO project_identity_aliases(
        alias, project_id, alias_type, created_at, updated_at
      ) VALUES(?, ?, 'remote', ?, ?)
    `).run(conflictingAlias, orphanOwnerProjectId, timestamp, timestamp);
  } finally {
    db.close();
  }

  store = await openKernelStateStore({ runtimeHome });
  try {
    assert.throws(() => store.registerProjectIdentity({
      projectId: targetProjectId,
      canonicalRoot: targetRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-orphan-alias-target',
      aliases: [conflictingAlias],
      legacyAliases: [{
        projectId: legacyProjectId,
        source: 'path-hash',
        canonicalRoot: targetRoot,
      }],
    }), (error: unknown) => (
      assertTestRecord(error).code === 'project_identity_alias_conflict'
    ));

    assert.equal(store.getProjectIdentity({ projectId: targetProjectId }), null);
    assert.equal(
      await readFile(sourceKnowledgeMarker, 'utf8'),
      JSON.stringify({ marker: 'must-remain-before-preflight' }),
    );
    const projectNamespaces = await readdir(path.join(runtimeHome, 'state', 'projects'));
    assert.equal(projectNamespaces.includes(targetProjectId), false);
    assert.deepEqual(
      projectNamespaces.filter((name) => name.startsWith('.identity-migration-')),
      [],
    );
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('approved target remote aliases are checked before namespace migration preparation', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-approved-target-remote-alias-'));
  const sourceRoot = path.join(runtimeHome, 'source');
  const thirdRoot = path.join(runtimeHome, 'third');
  const sourceProjectId = 'path-approved-alias-source';
  const targetProjectId = 'legacy-approved-alias-target';
  const thirdProjectId = 'path-approved-alias-third';
  const conflictingAlias = 'https://example.invalid/shared/repository.git';
  await Promise.all([
    mkdir(sourceRoot, { recursive: true }),
    mkdir(thirdRoot, { recursive: true }),
  ]);
  const store = await openKernelStateStore({ runtimeHome });
  try {
    store.registerProjectIdentity({
      projectId: sourceProjectId,
      canonicalRoot: sourceRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-approved-alias-source',
    });
    store.registerProjectIdentity({
      projectId: thirdProjectId,
      canonicalRoot: thirdRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-approved-alias-third',
      aliases: [conflictingAlias],
    });
    store.createRun({
      runId: 'run-approved-alias-source',
      objective: 'source state remains before alias conflict',
      sourceIdentity: 'sha256:' + '7'.repeat(64),
      projectId: sourceProjectId,
    });
    store.createRun({
      runId: 'run-approved-alias-target-data',
      objective: 'target namespace data without identity row',
      sourceIdentity: 'sha256:' + '8'.repeat(64),
      projectId: targetProjectId,
    });
    const sourceKnowledgeMarker = path.join(
      runtimeHome,
      'state',
      'projects',
      sourceProjectId,
      'context-packs',
      'approved-alias-conflict.json',
    );
    await mkdir(path.dirname(sourceKnowledgeMarker), { recursive: true });
    await writeFile(sourceKnowledgeMarker, JSON.stringify({ marker: 'must-remain' }));

    assert.throws(() => store.mergeProjectIdentity({
      sourceProjectId,
      targetProjectId,
      canonicalRoot: sourceRoot,
      approvedTargetIdentity: {
        projectId: targetProjectId,
        canonicalRoot: sourceRoot,
        identitySource: 'operator_approved_legacy',
        identityDigest: 'digest-approved-alias-target',
        aliases: [conflictingAlias],
      },
    }), (error: unknown) => assertTestRecord(error).code === 'project_identity_alias_conflict');

    assert.equal(assertTestPresent(store.getProjectIdentity({ projectId: sourceProjectId })).projectId, sourceProjectId);
    assert.equal(assertTestPresent(store.getProjectIdentity({ alias: conflictingAlias })).projectId, thirdProjectId);
    assert.equal(await readFile(sourceKnowledgeMarker, 'utf8'), JSON.stringify({ marker: 'must-remain' }));
    const projectNamespaces = await readdir(path.join(runtimeHome, 'state', 'projects'));
    assert.deepEqual(
      projectNamespaces.filter((name) => name.startsWith('.identity-migration-')),
      [],
    );
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('successful approved target merge persists new remote aliases in the lookup authority', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-approved-alias-success-'));
  const sourceRoot = path.join(runtimeHome, 'source');
  const sourceProjectId = 'path-approved-alias-success-source';
  const targetProjectId = 'legacy-approved-alias-success-target';
  const approvedAlias = 'https://example.invalid/approved/target.git';
  await mkdir(sourceRoot, { recursive: true });
  const store = await openKernelStateStore({ runtimeHome });
  try {
    store.registerProjectIdentity({
      projectId: sourceProjectId,
      canonicalRoot: sourceRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-approved-alias-success-source',
    });
    store.createRun({
      runId: 'run-approved-alias-success-source',
      objective: 'source state merges into approved target',
      sourceIdentity: 'sha256:' + '4'.repeat(64),
      projectId: sourceProjectId,
    });
    store.createRun({
      runId: 'run-approved-alias-success-target-data',
      objective: 'target namespace data without an identity row',
      sourceIdentity: 'sha256:' + '5'.repeat(64),
      projectId: targetProjectId,
    });

    const merged = store.mergeProjectIdentity({
      sourceProjectId,
      targetProjectId,
      canonicalRoot: sourceRoot,
      approvedTargetIdentity: {
        projectId: targetProjectId,
        canonicalRoot: sourceRoot,
        identitySource: 'operator_approved_legacy',
        identityDigest: 'digest-approved-alias-success-target',
        aliases: [approvedAlias],
      },
    });

    assert.equal(assertTestPresent(merged).projectId, targetProjectId);
    assert.ok(assertTestPresent(merged).aliases.includes(approvedAlias));
    assert.equal(
      assertTestPresent(store.getProjectIdentity({ alias: approvedAlias })).projectId,
      targetProjectId,
    );
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('identity registration rejects third-party legacy aliases before namespace migration preparation', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-register-alias-conflict-'));
  const targetRoot = path.join(runtimeHome, 'target');
  const thirdRoot = path.join(runtimeHome, 'third');
  const targetProjectId = 'path-register-alias-target';
  const legacyProjectId = 'legacy-register-alias-source';
  const thirdProjectId = 'path-register-alias-third';
  await Promise.all([
    mkdir(targetRoot, { recursive: true }),
    mkdir(thirdRoot, { recursive: true }),
  ]);
  const store = await openKernelStateStore({ runtimeHome });
  try {
    store.registerProjectIdentity({
      projectId: targetProjectId,
      canonicalRoot: targetRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-register-alias-target',
    });
    store.registerProjectIdentity({
      projectId: thirdProjectId,
      canonicalRoot: thirdRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-register-alias-third',
      aliases: [`project-id:${legacyProjectId}`],
    });
    store.registerProjectWorkspace({
      workspaceId: 'workspace-register-alias-source',
      canonicalRoot: targetRoot,
      gitCommonDir: null,
      gitWorktreeDir: null,
      identity: { projectId: legacyProjectId, canonicalRoot: targetRoot },
    });
    store.createRun({
      runId: 'run-register-alias-source',
      objective: 'legacy state must remain before register migration preparation',
      sourceIdentity: 'sha256:' + 'b'.repeat(64),
      projectId: legacyProjectId,
      workspaceId: 'workspace-register-alias-source',
    });
    const sourceKnowledgeRoot = path.join(runtimeHome, 'state', 'projects', legacyProjectId);
    const sourceKnowledgeMarker = path.join(sourceKnowledgeRoot, 'context-packs', 'register-alias-conflict.json');
    await mkdir(path.dirname(sourceKnowledgeMarker), { recursive: true });
    await writeFile(
      sourceKnowledgeMarker,
      JSON.stringify({ projectId: legacyProjectId, marker: 'must-not-stage-before-register-alias-check' }),
    );

    assert.throws(() => store.registerProjectIdentity({
      projectId: targetProjectId,
      canonicalRoot: targetRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-register-alias-target',
      legacyAliases: [{ projectId: legacyProjectId, source: 'path-hash' }],
    }), (error: unknown) => (
      assertTestRecord(error).code === 'project_identity_alias_conflict'
    ));

    assert.equal(assertTestPresent(store.getRun('run-register-alias-source')).projectId, legacyProjectId);
    assert.equal(assertTestPresent(store.getProjectIdentity({ projectId: targetProjectId })).projectId, targetProjectId);
    assert.equal(
      assertTestPresent(store.getProjectIdentity({ alias: `project-id:${legacyProjectId}` })).projectId,
      thirdProjectId,
    );
    assert.equal(
      await readFile(sourceKnowledgeMarker, 'utf8'),
      JSON.stringify({ projectId: legacyProjectId, marker: 'must-not-stage-before-register-alias-check' }),
    );
    const projectNamespaces = await readdir(path.join(runtimeHome, 'state', 'projects'));
    assert.deepEqual(
      projectNamespaces.filter((name) => name.startsWith('.identity-migration-')),
      [],
    );
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('project identity merge preserves the existing target worktree lease when equivalent workspaces consolidate', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-worktree-consolidation-'));
  const sourceIdentityRoot = path.join(runtimeHome, 'source-identity');
  const targetIdentityRoot = path.join(runtimeHome, 'target-identity');
  const targetWorkspaceRoot = 'C:\\Dev\\WorktreeConsolidation';
  const sourceWorkspaceRoot = '/c/dev/worktreeconsolidation';
  const sharedGitCommonDir = path.join(runtimeHome, 'shared.git');
  const sourceProjectId = 'path-worktree-source';
  const targetProjectId = 'path-worktree-target';
  const sourceWorkspaceId = 'workspace-worktree-source';
  const targetWorkspaceId = 'workspace-worktree-target';
  await Promise.all([
    mkdir(sourceIdentityRoot, { recursive: true }),
    mkdir(targetIdentityRoot, { recursive: true }),
    mkdir(sharedGitCommonDir, { recursive: true }),
  ]);
  const store = await openKernelStateStore({ runtimeHome });
  try {
    store.registerProjectIdentity({
      projectId: sourceProjectId,
      canonicalRoot: sourceIdentityRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-worktree-source',
    });
    store.registerProjectIdentity({
      projectId: targetProjectId,
      canonicalRoot: targetIdentityRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-worktree-target',
    });
    const targetWorkspace = store.registerProjectWorkspace({
      workspaceId: targetWorkspaceId,
      canonicalRoot: targetWorkspaceRoot,
      gitCommonDir: sharedGitCommonDir,
      gitWorktreeDir: sharedGitCommonDir,
      identity: { projectId: targetProjectId, canonicalRoot: targetWorkspaceRoot },
    });
    const sourceWorkspace = store.registerProjectWorkspace({
      workspaceId: sourceWorkspaceId,
      canonicalRoot: sourceWorkspaceRoot,
      gitCommonDir: sharedGitCommonDir,
      gitWorktreeDir: sharedGitCommonDir,
      identity: { projectId: sourceProjectId, canonicalRoot: sourceWorkspaceRoot },
    });
    const targetWorktreeId = assertTestString(targetWorkspace.worktreeId);
    const sourceWorktreeId = assertTestString(sourceWorkspace.worktreeId);
    assert.notEqual(targetWorktreeId, sourceWorktreeId);

    store.createRun({
      runId: 'target-worktree-run',
      objective: 'target worktree owner',
      sourceIdentity: 'sha256:' + 'f'.repeat(64),
      projectId: targetProjectId,
      workspaceId: targetWorkspaceId,
    });
    store.createRun({
      runId: 'source-worktree-run',
      objective: 'source worktree owner before identity merge',
      sourceIdentity: 'sha256:' + 'a'.repeat(64),
      projectId: sourceProjectId,
      workspaceId: sourceWorkspaceId,
    });
    assert.equal(assertTestPresent(store.getWorktreeMutationLease(targetWorktreeId)).holderRunId, 'target-worktree-run');
    assert.equal(assertTestPresent(store.getWorktreeMutationLease(sourceWorktreeId)).holderRunId, 'source-worktree-run');
    const targetWorkspaceLock = store.acquireWorkspaceMutationLockV2({
      workspaceId: targetWorkspaceId,
      projectId: targetProjectId,
      runId: 'target-worktree-run',
      sessionToken: 'target-workspace-session',
    });
    const sourceWorkspaceLock = store.acquireWorkspaceMutationLockV2({
      workspaceId: sourceWorkspaceId,
      projectId: sourceProjectId,
      runId: 'source-worktree-run',
      sessionToken: 'source-workspace-session',
    });
    assert.equal(targetWorkspaceLock.acquired, true);
    assert.equal(sourceWorkspaceLock.acquired, true);
    const retiredWorkspaceToken = Math.max(
      assertTestPresent(targetWorkspaceLock.lock).fencingToken,
      assertTestPresent(sourceWorkspaceLock.lock).fencingToken,
    );

    store.mergeProjectIdentity({
      sourceProjectId,
      targetProjectId,
      canonicalRoot: sourceIdentityRoot,
      gitCommonDir: sharedGitCommonDir,
    });

    const migratedSourceRun = assertTestPresent(store.getRun('source-worktree-run'));
    assert.equal(migratedSourceRun.projectId, targetProjectId);
    assert.equal(migratedSourceRun.workspaceId, targetWorkspaceId);
    assert.equal(migratedSourceRun.worktreeId, targetWorktreeId);
    assert.equal(store.getProjectWorkspace(sourceWorkspaceId), null);
    assert.equal(store.getWorktreeMutationLease(sourceWorktreeId), null);
    const survivingLease = assertTestPresent(store.getWorktreeMutationLease(targetWorktreeId));
    assert.equal(survivingLease.projectId, targetProjectId);
    assert.equal(survivingLease.holderRunId, 'target-worktree-run');
    assert.equal(store.getWorkspaceMutationLockV2(sourceWorkspaceId), null);
    assert.equal(store.getWorkspaceMutationLockV2(targetWorkspaceId), null);

    const reacquiredTargetWorkspaceLock = store.acquireWorkspaceMutationLockV2({
      workspaceId: targetWorkspaceId,
      projectId: targetProjectId,
      runId: 'target-worktree-run',
      sessionToken: 'target-workspace-session-after-merge',
    });
    assert.equal(reacquiredTargetWorkspaceLock.acquired, true);
    assert.ok(assertTestPresent(reacquiredTargetWorkspaceLock.lock).fencingToken > retiredWorkspaceToken);

    const reobservedWorkspace = store.registerProjectWorkspace({
      workspaceId: sourceWorkspaceId,
      canonicalRoot: sourceWorkspaceRoot,
      gitCommonDir: sharedGitCommonDir,
      gitWorktreeDir: sharedGitCommonDir,
      identity: { projectId: targetProjectId, canonicalRoot: sourceWorkspaceRoot },
    });
    assert.equal(reobservedWorkspace.workspaceId, targetWorkspaceId);
    assert.equal(reobservedWorkspace.worktreeId, targetWorktreeId);
    assert.equal(store.getProjectWorkspace(sourceWorkspaceId), null);
    assert.equal(assertTestPresent(store.getWorktreeMutationLease(targetWorktreeId)).holderRunId, 'target-worktree-run');

    assert.equal(store.acquireWorktreeMutationLease({
      worktreeId: targetWorktreeId,
      projectId: targetProjectId,
      runId: 'source-worktree-run',
    }).acquired, false);
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});


test('project identity migration rewrites a legacy target survivor worktree id to the derived target authority', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-target-legacy-worktree-'));
  const sourceIdentityRoot = path.join(runtimeHome, 'source-identity');
  const targetIdentityRoot = path.join(runtimeHome, 'target-identity');
  const sharedGitCommonDir = path.join(runtimeHome, 'shared.git');
  const sourceProjectId = 'path-target-legacy-source';
  const targetProjectId = 'path-target-legacy-target';
  const sourceWorkspaceId = 'workspace-target-legacy-source';
  const targetWorkspaceId = 'workspace-target-legacy-target';
  const sourceRoot = '/c/dev/targetlegacy';
  const targetRoot = 'C:\\Dev\\TargetLegacy';
  const legacyTargetWorktreeId = 'worktree-target-legacy-row';
  await Promise.all([
    mkdir(sourceIdentityRoot, { recursive: true }),
    mkdir(targetIdentityRoot, { recursive: true }),
    mkdir(sharedGitCommonDir, { recursive: true }),
  ]);

  const store = await openKernelStateStore({ runtimeHome });
  try {
    store.registerProjectIdentity({
      projectId: sourceProjectId,
      canonicalRoot: sourceIdentityRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-target-legacy-source',
    });
    store.registerProjectIdentity({
      projectId: targetProjectId,
      canonicalRoot: targetIdentityRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-target-legacy-target',
    });
    const targetWorkspace = store.registerProjectWorkspace({
      workspaceId: targetWorkspaceId,
      canonicalRoot: targetRoot,
      gitCommonDir: sharedGitCommonDir,
      gitWorktreeDir: sharedGitCommonDir,
      identity: { projectId: targetProjectId, canonicalRoot: targetRoot },
    });
    const sourceWorkspace = store.registerProjectWorkspace({
      workspaceId: sourceWorkspaceId,
      canonicalRoot: sourceRoot,
      gitCommonDir: sharedGitCommonDir,
      gitWorktreeDir: sharedGitCommonDir,
      identity: { projectId: sourceProjectId, canonicalRoot: sourceRoot },
    });
    const expectedTargetWorktreeId = assertTestString(targetWorkspace.worktreeId);
    const sourceWorktreeId = assertTestString(sourceWorkspace.worktreeId);

    const db = new DatabaseSync(kernelDbPath(runtimeHome));
    try {
      const row = db.prepare(
        'SELECT identity_json FROM project_workspaces WHERE workspace_id=?',
      ).get(targetWorkspaceId) as { identity_json: string };
      const identity = JSON.parse(row.identity_json) as Record<string, unknown>;
      identity.worktreeId = legacyTargetWorktreeId;
      db.prepare(
        'UPDATE project_workspaces SET worktree_id=?, identity_json=? WHERE workspace_id=?',
      ).run(legacyTargetWorktreeId, JSON.stringify(identity), targetWorkspaceId);
    } finally {
      db.close();
    }

    assert.equal(
      assertTestPresent(store.getProjectWorkspace(targetWorkspaceId)).worktreeId,
      legacyTargetWorktreeId,
    );
    store.createRun({
      runId: 'run-target-legacy-target',
      objective: 'legacy target worktree before migration',
      sourceIdentity: 'sha256:' + '4'.repeat(64),
      projectId: targetProjectId,
      workspaceId: targetWorkspaceId,
    });
    store.createRun({
      runId: 'run-target-legacy-source',
      objective: 'source worktree before migration',
      sourceIdentity: 'sha256:' + '5'.repeat(64),
      projectId: sourceProjectId,
      workspaceId: sourceWorkspaceId,
    });

    store.mergeProjectIdentity({
      sourceProjectId,
      targetProjectId,
      canonicalRoot: sourceIdentityRoot,
      gitCommonDir: sharedGitCommonDir,
    });

    const survivor = assertTestPresent(store.getProjectWorkspace(targetWorkspaceId));
    assert.equal(survivor.projectId, targetProjectId);
    assert.equal(survivor.worktreeId, expectedTargetWorktreeId);
    assert.notEqual(survivor.worktreeId, legacyTargetWorktreeId);
    assert.equal(store.getProjectWorkspace(sourceWorkspaceId), null);
    for (const runId of ['run-target-legacy-target', 'run-target-legacy-source']) {
      const run = assertTestPresent(store.getRun(runId));
      assert.equal(run.projectId, targetProjectId);
      assert.equal(run.workspaceId, targetWorkspaceId);
      assert.equal(run.worktreeId, expectedTargetWorktreeId);
    }
    assert.equal(store.getWorktreeMutationLease(legacyTargetWorktreeId), null);
    assert.equal(store.getWorktreeMutationLease(sourceWorktreeId), null);
    assert.ok(store.getWorktreeMutationLease(expectedTargetWorktreeId));
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('project identity migration collapses existing target workspaces when one source bridges their transitive repository component', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-target-bridge-component-'));
  const sourceIdentityRoot = path.join(runtimeHome, 'source-identity');
  const sourceProjectId = 'path-target-bridge-source';
  const targetProjectId = 'path-target-bridge-target';
  const targetAId = 'workspace-target-bridge-a';
  const targetBId = 'workspace-target-bridge-b';
  const sourceWorkspaceId = 'workspace-target-bridge-source';
  const targetARoot = '/c/dev/targetbridge';
  const targetBRoot = '/mnt/c/dev/targetbridge';
  const sourceRoot = 'C:\\Dev\\TargetBridge';
  const targetAGit = '/c/dev/targetbridge/.git';
  const targetBGit = '/mnt/c/dev/targetbridge/.git';
  const sourceGit = 'C:\\Dev\\TargetBridge\\.git';
  await mkdir(sourceIdentityRoot, { recursive: true });

  const store = await openKernelStateStore({ runtimeHome });
  try {
    store.registerProjectIdentity({
      projectId: sourceProjectId,
      canonicalRoot: sourceIdentityRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-target-bridge-source',
    });
    const targetA = store.registerProjectWorkspace({
      workspaceId: targetAId,
      canonicalRoot: targetARoot,
      gitCommonDir: targetAGit,
      gitWorktreeDir: targetAGit,
      identity: { projectId: targetProjectId, canonicalRoot: targetARoot },
    });
    const targetB = store.registerProjectWorkspace({
      workspaceId: targetBId,
      canonicalRoot: targetBRoot,
      gitCommonDir: targetBGit,
      gitWorktreeDir: targetBGit,
      identity: { projectId: targetProjectId, canonicalRoot: targetBRoot },
    });
    const source = store.registerProjectWorkspace({
      workspaceId: sourceWorkspaceId,
      canonicalRoot: sourceRoot,
      gitCommonDir: sourceGit,
      gitWorktreeDir: sourceGit,
      identity: { projectId: sourceProjectId, canonicalRoot: sourceRoot },
    });
    assert.equal(assertTestPresent(store.getProjectWorkspace(targetAId)).workspaceId, targetAId);
    assert.equal(assertTestPresent(store.getProjectWorkspace(targetBId)).workspaceId, targetBId);

    store.createRun({
      runId: 'run-target-bridge-a',
      objective: 'target bridge survivor',
      sourceIdentity: 'sha256:' + '1'.repeat(64),
      projectId: targetProjectId,
      workspaceId: targetAId,
    });
    store.createRun({
      runId: 'run-target-bridge-b',
      objective: 'target bridge duplicate',
      sourceIdentity: 'sha256:' + '2'.repeat(64),
      projectId: targetProjectId,
      workspaceId: targetBId,
    });
    store.createRun({
      runId: 'run-target-bridge-source',
      objective: 'source bridge',
      sourceIdentity: 'sha256:' + '3'.repeat(64),
      projectId: sourceProjectId,
      workspaceId: sourceWorkspaceId,
    });

    const targetALock = store.acquireWorkspaceMutationLockV2({
      workspaceId: targetAId,
      projectId: targetProjectId,
      runId: 'run-target-bridge-a',
      sessionToken: 'target-bridge-a-session',
    });
    const targetBLock = store.acquireWorkspaceMutationLockV2({
      workspaceId: targetBId,
      projectId: targetProjectId,
      runId: 'run-target-bridge-b',
      sessionToken: 'target-bridge-b-session',
    });
    const sourceLock = store.acquireWorkspaceMutationLockV2({
      workspaceId: sourceWorkspaceId,
      projectId: sourceProjectId,
      runId: 'run-target-bridge-source',
      sessionToken: 'target-bridge-source-session',
    });
    assert.equal(targetALock.acquired, true);
    assert.equal(targetBLock.acquired, true);
    assert.equal(sourceLock.acquired, true);
    const retiredToken = Math.max(
      assertTestPresent(targetALock.lock).fencingToken,
      assertTestPresent(targetBLock.lock).fencingToken,
      assertTestPresent(sourceLock.lock).fencingToken,
    );

    store.mergeProjectIdentity({
      sourceProjectId,
      targetProjectId,
      canonicalRoot: sourceIdentityRoot,
      gitCommonDir: sourceGit,
      approvedTargetIdentity: {
        projectId: targetProjectId,
        canonicalRoot: sourceIdentityRoot,
        identitySource: 'operator_approved_legacy',
        identityDigest: 'digest-target-bridge-target',
      },
    });

    const survivor = assertTestPresent(store.getProjectWorkspace(sourceWorkspaceId));
    const survivorWorktreeId = assertTestString(survivor.worktreeId);
    assert.equal(survivor.projectId, targetProjectId);
    assert.equal(survivor.canonicalRoot, 'c:/dev/targetbridge');
    assert.notEqual(assertTestString(targetA.worktreeId), survivorWorktreeId);
    assert.notEqual(assertTestString(targetB.worktreeId), survivorWorktreeId);
    assert.notEqual(assertTestString(source.worktreeId), survivorWorktreeId);
    assert.equal(store.getProjectWorkspace(targetAId), null);
    assert.equal(store.getProjectWorkspace(targetBId), null);
    for (const runId of ['run-target-bridge-a', 'run-target-bridge-b', 'run-target-bridge-source']) {
      const run = assertTestPresent(store.getRun(runId));
      assert.equal(run.projectId, targetProjectId);
      assert.equal(run.workspaceId, sourceWorkspaceId);
      assert.equal(run.worktreeId, survivorWorktreeId);
    }
    assert.equal(store.getWorktreeMutationLease(assertTestString(targetA.worktreeId)), null);
    assert.equal(store.getWorktreeMutationLease(assertTestString(targetB.worktreeId)), null);
    assert.equal(store.getWorktreeMutationLease(assertTestString(source.worktreeId)), null);
    assert.equal(
      assertTestPresent(store.getWorktreeMutationLease(survivorWorktreeId)).holderRunId,
      'run-target-bridge-source',
    );
    assert.equal(store.getWorkspaceMutationLockV2(targetAId), null);
    assert.equal(store.getWorkspaceMutationLockV2(targetBId), null);
    assert.equal(store.getWorkspaceMutationLockV2(sourceWorkspaceId), null);

    const reacquired = store.acquireWorkspaceMutationLockV2({
      workspaceId: sourceWorkspaceId,
      projectId: targetProjectId,
      runId: 'run-target-bridge-source',
      sessionToken: 'target-bridge-source-session-after-merge',
    });
    assert.equal(reacquired.acquired, true);
    assert.ok(assertTestPresent(reacquired.lock).fencingToken > retiredToken);

    for (const [workspaceId, canonicalRoot, gitCommonDir] of [
      ['workspace-target-bridge-c-reobserved', targetARoot, targetAGit],
      ['workspace-target-bridge-mnt-reobserved', targetBRoot, targetBGit],
    ] as const) {
      const reobserved = store.registerProjectWorkspace({
        workspaceId,
        canonicalRoot,
        gitCommonDir,
        gitWorktreeDir: gitCommonDir,
        identity: { projectId: targetProjectId, canonicalRoot },
      });
      assert.equal(reobserved.workspaceId, sourceWorkspaceId);
      assert.equal(reobserved.worktreeId, survivorWorktreeId);
      assert.equal(reobserved.canonicalRoot, 'c:/dev/targetbridge');
      assert.equal(store.getProjectWorkspace(workspaceId), null);
    }

    const dbAfter = new DatabaseSync(kernelDbPath(runtimeHome), { readOnly: true });
    try {
      const count = Number((dbAfter.prepare(
        'SELECT COUNT(*) AS count FROM project_workspaces WHERE project_id=?',
      ).get(targetProjectId) as { count: number }).count);
      assert.equal(count, 1);
    } finally {
      dbAfter.close();
    }
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('project identity merge consolidates multiple source workspace duplicates and retires source fencing tokens', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-multiple-source-workspaces-'));
  const sourceIdentityRoot = path.join(runtimeHome, 'source-identity');
  const sourceProjectId = 'path-multi-workspace-source';
  const targetProjectId = 'legacy-multi-workspace-target';
  const primaryWorkspaceId = 'workspace-multi-primary';
  const duplicateWorkspaceId = 'workspace-multi-duplicate';
  const primaryRoot = '/srv/multiple-source-workspace';
  const duplicateRoot = '/srv/multiple-source-workspace/../multiple-source-workspace';
  await mkdir(sourceIdentityRoot, { recursive: true });

  let store = await openKernelStateStore({ runtimeHome });
  try {
    store.registerProjectIdentity({
      projectId: sourceProjectId,
      canonicalRoot: sourceIdentityRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-multi-source',
    });
    store.registerProjectWorkspace({
      workspaceId: primaryWorkspaceId,
      canonicalRoot: primaryRoot,
      gitCommonDir: null,
      gitWorktreeDir: null,
      identity: { projectId: sourceProjectId, canonicalRoot: primaryRoot },
    });
    store.createRun({
      runId: 'run-multi-primary',
      objective: 'primary workspace',
      sourceIdentity: 'sha256:' + '9'.repeat(64),
      projectId: sourceProjectId,
      workspaceId: primaryWorkspaceId,
    });
    store.createRun({
      runId: 'run-multi-target-data',
      objective: 'target namespace data without identity row',
      sourceIdentity: 'sha256:' + 'a'.repeat(64),
      projectId: targetProjectId,
    });
  } finally {
    store.close();
  }

  const db = new DatabaseSync(kernelDbPath(runtimeHome));
  try {
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO project_workspaces(
        workspace_id, project_id, canonical_root, git_common_dir,
        git_worktree_dir, identity_json, created_at, last_seen_at,
        worktree_id, mutation_epoch
      )
      VALUES(?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)
    `).run(
      duplicateWorkspaceId,
      sourceProjectId,
      duplicateRoot,
      JSON.stringify({
        projectId: sourceProjectId,
        canonicalRoot: duplicateRoot,
        worktreeId: 'worktree-multi-duplicate-legacy',
      }),
      timestamp,
      timestamp,
      'worktree-multi-duplicate-legacy',
      7,
    );
  } finally {
    db.close();
  }

  store = await openKernelStateStore({ runtimeHome });
  try {
    store.createRun({
      runId: 'run-multi-duplicate',
      objective: 'duplicate workspace authority',
      sourceIdentity: 'sha256:' + 'b'.repeat(64),
      projectId: sourceProjectId,
      workspaceId: duplicateWorkspaceId,
    });
    const sourceLock = store.acquireWorkspaceMutationLockV2({
      workspaceId: duplicateWorkspaceId,
      projectId: sourceProjectId,
      runId: 'run-multi-duplicate',
      sessionToken: 'source-fencing-token',
    });
    assert.equal(sourceLock.acquired, true);
    const retiredToken = assertTestPresent(sourceLock.lock).fencingToken;
    assert.ok(retiredToken > 7);

    store.mergeProjectIdentity({
      sourceProjectId,
      targetProjectId,
      canonicalRoot: sourceIdentityRoot,
      approvedTargetIdentity: {
        projectId: targetProjectId,
        canonicalRoot: sourceIdentityRoot,
        identitySource: 'operator_approved_legacy',
        identityDigest: 'digest-multi-target',
      },
    });

    const primary = assertTestPresent(store.getProjectWorkspace(primaryWorkspaceId));
    assert.equal(primary.projectId, targetProjectId);
    assert.equal(store.getProjectWorkspace(duplicateWorkspaceId), null);
    assert.equal(assertTestPresent(store.getRun('run-multi-duplicate')).workspaceId, primaryWorkspaceId);
    assert.equal(store.getWorkspaceMutationLockV2(duplicateWorkspaceId), null);
    assert.equal(store.getWorkspaceMutationLockV2(primaryWorkspaceId), null);

    const dbAfter = new DatabaseSync(kernelDbPath(runtimeHome), { readOnly: true });
    try {
      const count = Number((dbAfter.prepare(
        'SELECT COUNT(*) AS count FROM project_workspaces WHERE project_id=?',
      ).get(targetProjectId) as { count: number }).count);
      const epoch = Number((dbAfter.prepare(
        'SELECT mutation_epoch AS epoch FROM project_workspaces WHERE workspace_id=?',
      ).get(primaryWorkspaceId) as { epoch: number }).epoch);
      assert.equal(count, 1);
      assert.ok(epoch >= retiredToken);
    } finally {
      dbAfter.close();
    }

    const reacquired = store.acquireWorkspaceMutationLockV2({
      workspaceId: primaryWorkspaceId,
      projectId: targetProjectId,
      runId: 'run-multi-duplicate',
      sessionToken: 'reacquired-fencing-token',
    });
    assert.equal(reacquired.acquired, true);
    assert.ok(assertTestPresent(reacquired.lock).fencingToken > retiredToken);
    const staleRenewal = store.renewWorkspaceMutationLockV2({
      workspaceId: primaryWorkspaceId,
      projectId: targetProjectId,
      runId: 'run-multi-duplicate',
      sessionToken: 'source-fencing-token',
      fencingToken: retiredToken,
    });
    assert.equal(staleRenewal.renewed, false);
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('project identity migration collapses a transitive three-surface workspace component to one deterministic survivor', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-three-surface-component-'));
  const identityRoot = path.join(runtimeHome, 'identity-root');
  const sourceProjectId = 'path-three-surface-source';
  const targetProjectId = 'legacy-three-surface-target';
  const roots = [
    ['workspace-a-windows', 'C:\\Dev\\ThreeSurface', 'C:\\Dev\\ThreeSurface\\.git'],
    ['workspace-b-c-mount', '/c/dev/threesurface', '/c/dev/threesurface/.git'],
    ['workspace-c-mnt-mount', '/mnt/c/dev/threesurface', '/mnt/c/dev/threesurface/.git'],
  ] as const;
  await mkdir(identityRoot, { recursive: true });

  let store = await openKernelStateStore({ runtimeHome });
  try {
    store.registerProjectIdentity({
      projectId: sourceProjectId,
      canonicalRoot: identityRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-three-surface-source',
    });
    store.createRun({
      runId: 'run-three-surface-target-data',
      objective: 'target namespace data without identity row',
      sourceIdentity: 'sha256:' + '4'.repeat(64),
      projectId: targetProjectId,
    });
  } finally {
    store.close();
  }

  const db = new DatabaseSync(kernelDbPath(runtimeHome));
  try {
    const timestamp = '2026-01-01T00:00:00.000Z';
    for (const [workspaceId, canonicalRoot, gitCommonDir] of roots) {
      db.prepare(`
        INSERT INTO project_workspaces(
          workspace_id, project_id, canonical_root, git_common_dir,
          git_worktree_dir, identity_json, created_at, last_seen_at,
          worktree_id, mutation_epoch
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(
        workspaceId,
        sourceProjectId,
        canonicalRoot,
        gitCommonDir,
        gitCommonDir,
        JSON.stringify({ projectId: sourceProjectId, canonicalRoot }),
        timestamp,
        timestamp,
        `legacy-${workspaceId}`,
      );
    }
  } finally {
    db.close();
  }

  store = await openKernelStateStore({ runtimeHome });
  try {
    for (const [workspaceId] of roots) {
      store.createRun({
        runId: `run-${workspaceId}`,
        objective: workspaceId,
        sourceIdentity: 'sha256:' + workspaceId.charCodeAt(workspaceId.length - 1).toString(16).padStart(2, '0').repeat(32),
        projectId: sourceProjectId,
        workspaceId,
      });
    }

    store.mergeProjectIdentity({
      sourceProjectId,
      targetProjectId,
      canonicalRoot: identityRoot,
      approvedTargetIdentity: {
        projectId: targetProjectId,
        canonicalRoot: identityRoot,
        identitySource: 'operator_approved_legacy',
        identityDigest: 'digest-three-surface-target',
      },
    });

    const survivor = assertTestPresent(store.getProjectWorkspace('workspace-a-windows'));
    assert.equal(survivor.projectId, targetProjectId);
    assert.equal(store.getProjectWorkspace('workspace-b-c-mount'), null);
    assert.equal(store.getProjectWorkspace('workspace-c-mnt-mount'), null);
    for (const [workspaceId] of roots) {
      assert.equal(assertTestPresent(store.getRun(`run-${workspaceId}`)).workspaceId, 'workspace-a-windows');
    }

    const dbAfter = new DatabaseSync(kernelDbPath(runtimeHome), { readOnly: true });
    try {
      const count = Number((dbAfter.prepare(
        'SELECT COUNT(*) AS count FROM project_workspaces WHERE project_id=?',
      ).get(targetProjectId) as { count: number }).count);
      assert.equal(count, 1);
    } finally {
      dbAfter.close();
    }
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('same-project workspace re-registration consolidates non-null Run worktree IDs and leases', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-workspace-reregister-consolidation-'));
  const projectRoot = path.join(runtimeHome, 'identity-root');
  const windowsRoot = 'C:\\Dev\\ReregisterConsolidation';
  const mountedRoot = '/c/dev/reregisterconsolidation';
  const windowsGitCommonDir = 'C:\\Dev\\ReregisterConsolidation\\.git';
  const mountedGitCommonDir = '/c/dev/reregisterconsolidation/.git';
  const projectId = 'path-reregister-consolidation';
  const targetWorkspaceId = 'workspace-reregister-target';
  const sourceWorkspaceId = 'workspace-reregister-source';
  const legacySourceWorktreeId = 'worktree-legacy-reregister-source';
  await mkdir(projectRoot, { recursive: true });

  let store = await openKernelStateStore({ runtimeHome });
  let targetWorktreeId: string;
  try {
    store.registerProjectIdentity({
      projectId,
      canonicalRoot: projectRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-reregister-consolidation',
    });
    const targetWorkspace = store.registerProjectWorkspace({
      workspaceId: targetWorkspaceId,
      canonicalRoot: windowsRoot,
      gitCommonDir: windowsGitCommonDir,
      gitWorktreeDir: windowsGitCommonDir,
      identity: { projectId, canonicalRoot: windowsRoot },
    });
    targetWorktreeId = assertTestString(targetWorkspace.worktreeId);
    store.createRun({
      runId: 'run-reregister-target',
      objective: 'retain one worktree authority after re-registration',
      sourceIdentity: 'sha256:' + '1'.repeat(64),
      projectId,
      workspaceId: targetWorkspaceId,
    });
    assert.equal(
      assertTestPresent(store.getWorktreeMutationLease(targetWorktreeId)).holderRunId,
      'run-reregister-target',
    );
  } finally {
    store.close();
  }

  const db = new DatabaseSync(kernelDbPath(runtimeHome));
  try {
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO project_workspaces(
        workspace_id, project_id, canonical_root, git_common_dir,
        git_worktree_dir, identity_json, created_at, last_seen_at,
        worktree_id, mutation_epoch
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      sourceWorkspaceId,
      projectId,
      mountedRoot,
      mountedGitCommonDir,
      mountedGitCommonDir,
      JSON.stringify({
        projectId,
        canonicalRoot: mountedRoot,
        worktreeId: legacySourceWorktreeId,
      }),
      timestamp,
      timestamp,
      legacySourceWorktreeId,
    );
  } finally {
    db.close();
  }

  store = await openKernelStateStore({ runtimeHome });
  try {
    const sourceWorktreeId = assertTestString(
      assertTestPresent(store.getProjectWorkspace(sourceWorkspaceId)).worktreeId,
    );
    assert.notEqual(sourceWorktreeId, targetWorktreeId);
    store.createRun({
      runId: 'run-reregister-source',
      objective: 'legacy duplicate worktree authority before re-registration',
      sourceIdentity: 'sha256:' + '2'.repeat(64),
      projectId,
      workspaceId: sourceWorkspaceId,
    });
    assert.equal(
      assertTestPresent(store.getWorktreeMutationLease(sourceWorktreeId)).holderRunId,
      'run-reregister-source',
    );

    const consolidated = store.registerProjectWorkspace({
      workspaceId: 'workspace-reregister-observation',
      canonicalRoot: windowsRoot,
      gitCommonDir: windowsGitCommonDir,
      gitWorktreeDir: windowsGitCommonDir,
      identity: { projectId, canonicalRoot: windowsRoot },
    });
    const survivingWorkspaceId = consolidated.workspaceId;
    const survivingWorktreeId = assertTestString(consolidated.worktreeId);
    const removedWorkspaceId = survivingWorkspaceId === targetWorkspaceId
      ? sourceWorkspaceId
      : targetWorkspaceId;
    const removedWorktreeId = survivingWorktreeId === targetWorktreeId
      ? sourceWorktreeId
      : targetWorktreeId;

    assert.equal(store.getProjectWorkspace(removedWorkspaceId), null);
    for (const runId of ['run-reregister-target', 'run-reregister-source']) {
      const run = assertTestPresent(store.getRun(runId));
      assert.equal(run.workspaceId, survivingWorkspaceId);
      assert.equal(run.worktreeId, survivingWorktreeId);
    }
    const survivingLease = assertTestPresent(store.getWorktreeMutationLease(survivingWorktreeId));
    assert.equal(survivingLease.projectId, projectId);
    assert.equal(store.getWorktreeMutationLease(removedWorktreeId), null);
    assert.equal(store.acquireWorktreeMutationLease({
      worktreeId: survivingWorktreeId,
      projectId,
      runId: survivingLease.holderRunId === 'run-reregister-target'
        ? 'run-reregister-source'
        : 'run-reregister-target',
    }).acquired, false);
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});



test('same-project consolidation preserves legacy Git proof when an exact-root observation reports a different repository location', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-workspace-prospective-anchor-'));
  const projectRoot = path.join(runtimeHome, 'identity-root');
  const projectId = 'path-prospective-anchor';
  const windowsWorkspaceId = 'workspace-prospective-anchor-windows';
  const mountedWorkspaceId = 'workspace-prospective-anchor-mounted';
  const windowsRoot = 'C:\\Dev\\ProspectiveAnchor';
  const mountedRoot = '/c/dev/prospectiveanchor';
  const mountedOldGit = '/c/dev/prospectiveanchor/.git';
  const windowsNewGit = 'C:\\Elsewhere\\ProspectiveAnchor\\.git';
  await mkdir(projectRoot, { recursive: true });

  const store = await openKernelStateStore({ runtimeHome });
  try {
    store.registerProjectIdentity({
      projectId,
      canonicalRoot: projectRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-prospective-anchor',
    });

    const observedAt = '2026-01-01T00:00:00.000Z';
    const db = new DatabaseSync(kernelDbPath(runtimeHome));
    try {
      const insertWorkspace = db.prepare(
        'INSERT INTO project_workspaces('
        + 'workspace_id, project_id, canonical_root, git_common_dir, '
        + 'git_worktree_dir, identity_json, created_at, last_seen_at, '
        + 'worktree_id, mutation_epoch) '
        + 'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0)',
      );
      for (const [workspaceId, canonicalRoot, gitCommonDir, worktreeId] of [
        [windowsWorkspaceId, 'c:/dev/prospectiveanchor', 'c:/dev/prospectiveanchor/.git', 'legacy-prospective-windows'],
        [mountedWorkspaceId, mountedRoot, mountedOldGit, 'legacy-prospective-mounted'],
      ] as const) {
        insertWorkspace.run(
          workspaceId,
          projectId,
          canonicalRoot,
          gitCommonDir,
          gitCommonDir,
          JSON.stringify({ projectId, canonicalRoot, worktreeId }),
          observedAt,
          observedAt,
          worktreeId,
        );
      }
    } finally {
      db.close();
    }

    const consolidated = store.registerProjectWorkspace({
      workspaceId: 'workspace-prospective-anchor-observation',
      canonicalRoot: windowsRoot,
      gitCommonDir: windowsNewGit,
      gitWorktreeDir: windowsNewGit,
      identity: { projectId, canonicalRoot: windowsRoot },
    });
    const survivorWorktreeId = assertTestString(consolidated.worktreeId);
    assert.equal(consolidated.workspaceId, windowsWorkspaceId);
    assert.equal(consolidated.gitCommonDir, 'c:/dev/prospectiveanchor/.git');
    assert.equal(consolidated.gitWorktreeDir, 'c:/dev/prospectiveanchor/.git');
    assert.equal(store.getProjectWorkspace(mountedWorkspaceId), null);

    const repeatedDifferentGit = store.registerProjectWorkspace({
      workspaceId: 'workspace-prospective-anchor-repeat-different-git',
      canonicalRoot: windowsRoot,
      gitCommonDir: windowsNewGit,
      gitWorktreeDir: windowsNewGit,
      identity: { projectId, canonicalRoot: windowsRoot },
    });
    assert.equal(repeatedDifferentGit.workspaceId, windowsWorkspaceId);
    assert.equal(repeatedDifferentGit.worktreeId, survivorWorktreeId);
    assert.equal(repeatedDifferentGit.gitCommonDir, 'c:/dev/prospectiveanchor/.git');
    assert.equal(repeatedDifferentGit.gitWorktreeDir, 'c:/dev/prospectiveanchor/.git');
    assert.equal(
      store.getProjectWorkspace('workspace-prospective-anchor-repeat-different-git'),
      null,
    );

    const reobservedMounted = store.registerProjectWorkspace({
      workspaceId: 'workspace-prospective-anchor-mounted-reobserved',
      canonicalRoot: mountedRoot,
      gitCommonDir: mountedOldGit,
      gitWorktreeDir: mountedOldGit,
      identity: { projectId, canonicalRoot: mountedRoot },
    });
    assert.equal(reobservedMounted.workspaceId, windowsWorkspaceId);
    assert.equal(reobservedMounted.worktreeId, survivorWorktreeId);
    assert.equal(reobservedMounted.gitCommonDir, 'c:/dev/prospectiveanchor/.git');
    assert.equal(store.getProjectWorkspace('workspace-prospective-anchor-mounted-reobserved'), null);

    const dbAfter = new DatabaseSync(kernelDbPath(runtimeHome), { readOnly: true });
    try {
      const count = Number((dbAfter.prepare(
        'SELECT COUNT(*) AS count FROM project_workspaces WHERE project_id=?',
      ).get(projectId) as { count: number }).count);
      assert.equal(count, 1);
    } finally {
      dbAfter.close();
    }
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});


test('same workspace re-observation cannot bridge repository components by rewriting persisted Git proof', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-workspace-monotonic-observation-'));
  const projectRoot = path.join(runtimeHome, 'identity-root');
  const projectId = 'path-monotonic-observation';
  const windowsWorkspaceId = 'workspace-monotonic-observation-windows';
  const mountedWorkspaceId = 'workspace-monotonic-observation-mounted';
  const windowsRoot = 'C:\\Dev\\MonotonicObservation';
  const mountedRoot = '/c/dev/monotonicobservation';
  const windowsOldGit = 'c:/old/monotonicobservation/.git';
  const windowsNewGit = 'C:\\New\\MonotonicObservation\\.git';
  const mountedNewGit = '/c/new/monotonicobservation/.git';
  await mkdir(projectRoot, { recursive: true });

  const store = await openKernelStateStore({ runtimeHome });
  try {
    store.registerProjectIdentity({
      projectId,
      canonicalRoot: projectRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-monotonic-observation',
    });

    const observedAt = '2026-01-01T00:00:00.000Z';
    const db = new DatabaseSync(kernelDbPath(runtimeHome));
    try {
      const insertWorkspace = db.prepare(
        'INSERT INTO project_workspaces('
        + 'workspace_id, project_id, canonical_root, git_common_dir, '
        + 'git_worktree_dir, identity_json, created_at, last_seen_at, '
        + 'worktree_id, mutation_epoch) '
        + 'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0)',
      );
      insertWorkspace.run(
        windowsWorkspaceId,
        projectId,
        'c:/dev/monotonicobservation',
        windowsOldGit,
        windowsOldGit,
        JSON.stringify({
          projectId,
          canonicalRoot: 'c:/dev/monotonicobservation',
          worktreeId: 'legacy-monotonic-windows',
        }),
        observedAt,
        observedAt,
        'legacy-monotonic-windows',
      );
      insertWorkspace.run(
        mountedWorkspaceId,
        projectId,
        mountedRoot,
        mountedNewGit,
        mountedNewGit,
        JSON.stringify({
          projectId,
          canonicalRoot: mountedRoot,
          worktreeId: 'legacy-monotonic-mounted',
        }),
        observedAt,
        observedAt,
        'legacy-monotonic-mounted',
      );
    } finally {
      db.close();
    }

    const reobserved = store.registerProjectWorkspace({
      workspaceId: windowsWorkspaceId,
      canonicalRoot: windowsRoot,
      gitCommonDir: windowsNewGit,
      gitWorktreeDir: windowsNewGit,
      identity: { projectId, canonicalRoot: windowsRoot },
    });

    assert.equal(reobserved.workspaceId, windowsWorkspaceId);
    assert.equal(reobserved.gitCommonDir, windowsOldGit);
    assert.equal(reobserved.gitWorktreeDir, windowsOldGit);
    assert.equal(
      assertTestPresent(store.getProjectWorkspace(mountedWorkspaceId)).gitCommonDir,
      mountedNewGit,
    );

    const dbAfter = new DatabaseSync(kernelDbPath(runtimeHome), { readOnly: true });
    try {
      const count = Number((dbAfter.prepare(
        'SELECT COUNT(*) AS count FROM project_workspaces WHERE project_id=?',
      ).get(projectId) as { count: number }).count);
      assert.equal(count, 2);
    } finally {
      dbAfter.close();
    }
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});


test('same workspace ID rejects a non-equivalent root before worktree authority can drift', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-workspace-root-reuse-rejected-'));
  const projectRoot = path.join(runtimeHome, 'identity-root');
  const projectId = 'path-workspace-root-reuse-rejected';
  const workspaceId = 'workspace-root-reuse-rejected';
  const originalRoot = 'C:\\Dev\\WorkspaceRootReuse';
  const originalGit = 'C:\\Dev\\WorkspaceRootReuse\\.git';
  const replacementRoot = 'D:\\Other\\WorkspaceRootReuse';
  const replacementGit = 'D:\\Other\\WorkspaceRootReuse\\.git';
  const runId = 'run-workspace-root-reuse-rejected';
  await mkdir(projectRoot, { recursive: true });

  const store = await openKernelStateStore({ runtimeHome });
  try {
    store.registerProjectIdentity({
      projectId,
      canonicalRoot: projectRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-workspace-root-reuse-rejected',
    });
    const registered = store.registerProjectWorkspace({
      workspaceId,
      canonicalRoot: originalRoot,
      gitCommonDir: originalGit,
      gitWorktreeDir: originalGit,
      identity: { projectId, canonicalRoot: originalRoot },
    });
    const originalWorktreeId = assertTestString(registered.worktreeId);

    store.createRun({
      runId,
      objective: 'keep one durable workspace and worktree authority',
      sourceIdentity: 'sha256:' + '9'.repeat(64),
      projectId,
      workspaceId,
    });
    assert.equal(
      assertTestPresent(store.getWorktreeMutationLease(originalWorktreeId)).holderRunId,
      runId,
    );

    assert.throws(
      () => store.registerProjectWorkspace({
        workspaceId,
        canonicalRoot: replacementRoot,
        gitCommonDir: replacementGit,
        gitWorktreeDir: replacementGit,
        identity: { projectId, canonicalRoot: replacementRoot },
      }),
      (error) => assertTestRecord(error).code === 'project_worktree_identity_mismatch',
    );

    const persisted = assertTestPresent(store.getProjectWorkspace(workspaceId));
    assert.equal(persisted.canonicalRoot, 'c:/dev/workspacerootreuse');
    assert.equal(persisted.gitCommonDir, 'c:/dev/workspacerootreuse/.git');
    assert.equal(persisted.gitWorktreeDir, 'c:/dev/workspacerootreuse/.git');
    assert.equal(persisted.worktreeId, originalWorktreeId);
    assert.equal(assertTestPresent(store.getRun(runId)).worktreeId, originalWorktreeId);
    assert.equal(
      assertTestPresent(store.getWorktreeMutationLease(originalWorktreeId)).holderRunId,
      runId,
    );
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});


test('concurrent workspace registration serializes ownership before any persisted read', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-workspace-concurrent-owner-'));
  const barrierPath = path.join(runtimeHome, 'start-barrier');
  const workspaceId = 'workspace-concurrent-owner-fixed';

  const seed = await openKernelStateStore({ runtimeHome });
  seed.close();

  const childSource = [
    "import { existsSync } from 'node:fs';",
    "import { setTimeout as sleep } from 'node:timers/promises';",
    "import { openKernelStateStore } from './scripts/kernel/state-store.js';",
    "const [runtimeHome, barrierPath, workspaceId, projectId, canonicalRoot, gitCommonDir] = process.argv.slice(1);",
    "while (!existsSync(barrierPath)) await sleep(2);",
    "for (let attempt = 0; attempt < 20; attempt += 1) {",
    "  const store = await openKernelStateStore({ runtimeHome });",
    "  try {",
    "    const row = store.registerProjectWorkspace({ workspaceId, canonicalRoot, gitCommonDir, gitWorktreeDir: gitCommonDir, identity: { projectId, canonicalRoot } });",
    "    process.stdout.write(JSON.stringify({ status: 'registered', projectId: row.projectId }));",
    "    process.exit(0);",
    "  } catch (error) {",
    "    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';",
    "    if (code === 'SQLITE_BUSY' || /database is (?:locked|busy)/i.test(String(error))) { store.close(); await sleep(10); continue; }",
    "    process.stdout.write(JSON.stringify({ status: 'rejected', code }));",
    "    process.exit(0);",
    "  } finally { try { store.close(); } catch {} }",
    "}",
    "process.stdout.write(JSON.stringify({ status: 'busy-exhausted' }));",
    "process.exit(0);",
  ].join('\n');

  const launch = (projectId: string, canonicalRoot: string, gitCommonDir: string) => {
    const child = spawn(process.execPath, [
      '--input-type=module', '-e', childSource,
      runtimeHome, barrierPath, workspaceId, projectId, canonicalRoot, gitCommonDir,
    ], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
  };

  try {
    const left = launch('path-concurrent-owner-left', 'C:\\\\Dev\\\\ConcurrentOwner', 'C:\\\\Dev\\\\ConcurrentOwner\\\\.git');
    const right = launch('path-concurrent-owner-right', 'D:\\\\Other\\\\ConcurrentOwner', 'D:\\\\Other\\\\ConcurrentOwner\\\\.git');
    await writeFile(barrierPath, 'start');

    const results = await Promise.all([left, right]);
    for (const result of results) assert.equal(result.code, 0, result.stderr || result.stdout);
    const outcomes = results.map((result) => JSON.parse(result.stdout) as { status: string; projectId?: string; code?: string });
    assert.equal(outcomes.filter(({ status }) => status === 'registered').length, 1);
    assert.equal(outcomes.filter(({ status }) => status === 'rejected').length, 1);
    assert.equal(outcomes.find(({ status }) => status === 'rejected')?.code, 'workspace_project_identity_mismatch');

    const inspect = await openKernelStateStore({ runtimeHome });
    try {
      const persisted = assertTestPresent(inspect.getProjectWorkspace(workspaceId));
      const winner = assertTestPresent(outcomes.find(({ status }) => status === 'registered')?.projectId);
      assert.equal(persisted.projectId, winner);
      assert.ok(['c:/dev/concurrentowner/.git', 'd:/other/concurrentowner/.git'].includes(assertTestString(persisted.gitCommonDir)));
    } finally {
      inspect.close();
    }
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
  }
});


test('stable workspace IDs cannot collide across different project or root ownership', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'kernel-stable-workspace-ownership-'));
  try {
    const rootA = path.join(parent, 'workspace-a');
    const rootB = path.join(parent, 'workspace-b');
    const projectA = resolveStableWorkspaceIdentity({
      projectId: 'stable-owner-project-a',
      workspaceRoot: rootA,
    });
    const projectB = resolveStableWorkspaceIdentity({
      projectId: 'stable-owner-project-b',
      workspaceRoot: rootA,
    });
    const rootBObservation = resolveStableWorkspaceIdentity({
      projectId: 'stable-owner-project-a',
      workspaceRoot: rootB,
    });

    assert.notEqual(projectA.workspaceId, projectB.workspaceId);
    assert.notEqual(projectA.workspaceId, rootBObservation.workspaceId);
    assert.notEqual(projectB.workspaceId, rootBObservation.workspaceId);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});


test('stable workspace identity preserves literal POSIX backslashes', async () => {
  if (process.platform === 'win32') return;
  const parent = await mkdtemp(path.join(os.tmpdir(), 'kernel-stable-workspace-posix-backslash-'));
  try {
    const literalBackslashRoot = path.join(parent, ['repo', 'part'].join(String.fromCharCode(92)));
    const separatorRoot = path.join(parent, 'repo', 'part');
    await mkdir(literalBackslashRoot, { recursive: true });
    await mkdir(separatorRoot, { recursive: true });

    const literalBackslash = resolveStableWorkspaceIdentity({
      projectId: 'stable-posix-backslash-project',
      workspaceRoot: literalBackslashRoot,
    });
    const separator = resolveStableWorkspaceIdentity({
      projectId: 'stable-posix-backslash-project',
      workspaceRoot: separatorRoot,
    });

    assert.notEqual(literalBackslash.identity.canonicalRoot, separator.identity.canonicalRoot);
    assert.notEqual(literalBackslash.workspaceId, separator.workspaceId);
    assert.ok(literalBackslash.identity.canonicalRoot.includes(String.fromCharCode(92)));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('same workspace ID cannot be reassigned to another project authority', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-workspace-project-reassignment-rejected-'));
  const projectRootA = path.join(runtimeHome, 'identity-root-a');
  const projectRootB = path.join(runtimeHome, 'identity-root-b');
  const projectA = 'path-workspace-project-owner-a';
  const projectB = 'path-workspace-project-owner-b';
  const workspaceId = 'workspace-project-owner-fixed';
  const originalRoot = 'C:\\Dev\\ProjectOwnerFixed';
  const originalGit = 'C:\\Dev\\ProjectOwnerFixed\\.git';
  const replacementRoot = 'D:\\Other\\ProjectOwnerFixed';
  const replacementGit = 'D:\\Other\\ProjectOwnerFixed\\.git';
  const runId = 'run-workspace-project-owner-fixed';
  await mkdir(projectRootA, { recursive: true });
  await mkdir(projectRootB, { recursive: true });

  const store = await openKernelStateStore({ runtimeHome });
  try {
    store.registerProjectIdentity({
      projectId: projectA,
      canonicalRoot: projectRootA,
      identitySource: 'workspace_root',
      identityDigest: 'digest-workspace-project-owner-a',
    });
    store.registerProjectIdentity({
      projectId: projectB,
      canonicalRoot: projectRootB,
      identitySource: 'workspace_root',
      identityDigest: 'digest-workspace-project-owner-b',
    });
    const registered = store.registerProjectWorkspace({
      workspaceId,
      canonicalRoot: originalRoot,
      gitCommonDir: originalGit,
      gitWorktreeDir: originalGit,
      identity: { projectId: projectA, canonicalRoot: originalRoot },
    });
    const originalWorktreeId = assertTestString(registered.worktreeId);

    store.createRun({
      runId,
      objective: 'workspace id keeps one project authority',
      sourceIdentity: 'sha256:' + 'a'.repeat(64),
      projectId: projectA,
      workspaceId,
    });
    assert.equal(
      assertTestPresent(store.getWorktreeMutationLease(originalWorktreeId)).holderRunId,
      runId,
    );

    assert.throws(
      () => store.registerProjectWorkspace({
        workspaceId,
        canonicalRoot: replacementRoot,
        gitCommonDir: replacementGit,
        gitWorktreeDir: replacementGit,
        identity: { projectId: projectB, canonicalRoot: replacementRoot },
      }),
      (error) => assertTestRecord(error).code === 'workspace_project_identity_mismatch',
    );

    const persisted = assertTestPresent(store.getProjectWorkspace(workspaceId));
    assert.equal(persisted.projectId, projectA);
    assert.equal(persisted.canonicalRoot, 'c:/dev/projectownerfixed');
    assert.equal(persisted.gitCommonDir, 'c:/dev/projectownerfixed/.git');
    assert.equal(persisted.worktreeId, originalWorktreeId);
    assert.equal(assertTestPresent(store.getRun(runId)).worktreeId, originalWorktreeId);
    assert.equal(
      assertTestPresent(store.getWorktreeMutationLease(originalWorktreeId)).holderRunId,
      runId,
    );
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('fresh workspace bridge cannot replace conflicting persisted Git ownership evidence', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-workspace-conflicting-git-bridge-'));
  const projectRoot = path.join(runtimeHome, 'identity-root');
  const projectId = 'path-conflicting-git-bridge';
  const windowsWorkspaceId = 'workspace-conflicting-git-windows';
  const mountedWorkspaceId = 'workspace-conflicting-git-mounted';
  const freshWorkspaceId = 'workspace-conflicting-git-fresh';
  const windowsRoot = 'C:\\Dev\\ConflictingGitBridge';
  const mountedRoot = '/c/dev/conflictinggitbridge';
  const oldWindowsGit = 'C:\\Old\\ConflictingGitBridge\\.git';
  const newMountedGit = '/c/new/conflictinggitbridge/.git';
  const newWindowsGit = 'C:\\New\\ConflictingGitBridge\\.git';
  await mkdir(projectRoot, { recursive: true });

  const store = await openKernelStateStore({ runtimeHome });
  try {
    store.registerProjectIdentity({
      projectId,
      canonicalRoot: projectRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-conflicting-git-bridge',
    });
    const windowsWorkspace = store.registerProjectWorkspace({
      workspaceId: windowsWorkspaceId,
      canonicalRoot: windowsRoot,
      gitCommonDir: oldWindowsGit,
      gitWorktreeDir: oldWindowsGit,
      identity: { projectId, canonicalRoot: windowsRoot },
    });
    const mountedWorkspace = store.registerProjectWorkspace({
      workspaceId: mountedWorkspaceId,
      canonicalRoot: mountedRoot,
      gitCommonDir: newMountedGit,
      gitWorktreeDir: newMountedGit,
      identity: { projectId, canonicalRoot: mountedRoot },
    });
    const windowsWorktreeId = assertTestString(windowsWorkspace.worktreeId);
    const mountedWorktreeId = assertTestString(mountedWorkspace.worktreeId);
    assert.notEqual(windowsWorktreeId, mountedWorktreeId);

    assert.throws(
      () => store.registerProjectWorkspace({
        workspaceId: freshWorkspaceId,
        canonicalRoot: windowsRoot,
        gitCommonDir: newWindowsGit,
        gitWorktreeDir: newWindowsGit,
        identity: { projectId, canonicalRoot: windowsRoot },
      }),
      (error) => assertTestRecord(error).code === 'project_workspace_repository_component_unanchored',
    );

    const persistedWindows = assertTestPresent(store.getProjectWorkspace(windowsWorkspaceId));
    const persistedMounted = assertTestPresent(store.getProjectWorkspace(mountedWorkspaceId));
    assert.equal(persistedWindows.gitCommonDir, 'c:/old/conflictinggitbridge/.git');
    assert.equal(persistedWindows.worktreeId, windowsWorktreeId);
    assert.equal(persistedMounted.gitCommonDir, '/c/new/conflictinggitbridge/.git');
    assert.equal(persistedMounted.worktreeId, mountedWorktreeId);
    assert.equal(store.getProjectWorkspace(freshWorkspaceId), null);
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});


test('fresh workspace bridge cannot replace conflicting persisted Git worktree evidence', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-workspace-conflicting-worktree-bridge-'));
  const projectRoot = path.join(runtimeHome, 'identity-root');
  const projectId = 'path-conflicting-worktree-bridge';
  const workspaceAId = 'workspace-conflicting-worktree-a';
  const workspaceBId = 'workspace-conflicting-worktree-b';
  const freshWorkspaceId = 'workspace-conflicting-worktree-fresh';
  const rootA = '/c/dev/conflictingworktree';
  const rootB = '/mnt/c/dev/conflictingworktree';
  const windowsRoot = 'C:\\Dev\\ConflictingWorktree';
  const commonA = '/c/dev/conflictingworktree/.git';
  const commonB = '/mnt/c/dev/conflictingworktree/.git';
  const windowsCommon = 'C:\\Dev\\ConflictingWorktree\\.git';
  const worktreeA = '/c/dev/conflictingworktree/.git/worktrees/a';
  const worktreeB = '/mnt/c/dev/conflictingworktree/.git/worktrees/b';
  const windowsWorktreeA = 'C:\\Dev\\ConflictingWorktree\\.git\\worktrees\\a';
  await mkdir(projectRoot, { recursive: true });

  const store = await openKernelStateStore({ runtimeHome });
  try {
    store.registerProjectIdentity({
      projectId,
      canonicalRoot: projectRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-conflicting-worktree-bridge',
    });
    const workspaceA = store.registerProjectWorkspace({
      workspaceId: workspaceAId,
      canonicalRoot: rootA,
      gitCommonDir: commonA,
      gitWorktreeDir: worktreeA,
      identity: { projectId, canonicalRoot: rootA },
    });
    const workspaceB = store.registerProjectWorkspace({
      workspaceId: workspaceBId,
      canonicalRoot: rootB,
      gitCommonDir: commonB,
      gitWorktreeDir: worktreeB,
      identity: { projectId, canonicalRoot: rootB },
    });
    assert.notEqual(workspaceA.worktreeId, workspaceB.worktreeId);

    assert.throws(
      () => store.registerProjectWorkspace({
        workspaceId: freshWorkspaceId,
        canonicalRoot: windowsRoot,
        gitCommonDir: windowsCommon,
        gitWorktreeDir: windowsWorktreeA,
        identity: { projectId, canonicalRoot: windowsRoot },
      }),
      (error) => assertTestRecord(error).code === 'project_workspace_repository_component_unanchored',
    );

    assert.equal(
      assertTestPresent(store.getProjectWorkspace(workspaceAId)).gitWorktreeDir,
      worktreeA,
    );
    assert.equal(
      assertTestPresent(store.getProjectWorkspace(workspaceBId)).gitWorktreeDir,
      worktreeB,
    );
    assert.equal(store.getProjectWorkspace(freshWorkspaceId), null);
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});


test('public worktree registration accepts the registry survivor for a proven cross-surface duplicate', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-worktree-public-cross-surface-'));
  const projectRoot = path.join(runtimeHome, 'identity-root');
  const projectId = 'path-public-cross-surface-survivor';
  const windowsRoot = 'C:\\Dev\\PublicCrossSurface';
  const mountedRoot = '/c/dev/publiccrosssurface';
  const windowsCommon = 'C:\\Dev\\PublicCrossSurface\\.git';
  const mountedCommon = '/c/dev/publiccrosssurface/.git';
  const windowsWorktree = 'C:\\Dev\\PublicCrossSurface\\.git';
  const mountedWorktree = '/c/dev/publiccrosssurface/.git';
  await mkdir(projectRoot, { recursive: true });

  const store = await openKernelStateStore({ runtimeHome });
  try {
    store.registerProjectIdentity({
      projectId,
      canonicalRoot: projectRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-public-cross-surface-survivor',
    });

    const first = registerWorktreeObservation({
      stateStore: store,
      projectId,
      workspace: {
        workspaceId: 'workspace-public-cross-surface-windows',
        canonicalRoot: windowsRoot,
        gitCommonDir: windowsCommon,
        gitWorktreeDir: windowsWorktree,
        identity: {
          projectId,
          canonicalRoot: windowsRoot,
          gitCommonDir: windowsCommon,
          gitWorktreeDir: windowsWorktree,
        },
      },
    });

    const rebound = registerWorktreeObservation({
      stateStore: store,
      projectId,
      workspace: {
        workspaceId: 'workspace-public-cross-surface-mounted',
        canonicalRoot: mountedRoot,
        gitCommonDir: mountedCommon,
        gitWorktreeDir: mountedWorktree,
        identity: {
          projectId,
          canonicalRoot: mountedRoot,
          gitCommonDir: mountedCommon,
          gitWorktreeDir: mountedWorktree,
        },
      },
    });

    assert.equal(rebound.workspaceId, first.workspaceId);
    assert.equal(rebound.worktreeId, first.worktreeId);
    assert.equal(store.getProjectWorkspace('workspace-public-cross-surface-mounted'), null);
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('same-project Windows bridge becomes the durable anchor for mounted surface re-observation', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-workspace-durable-bridge-anchor-'));
  const projectRoot = path.join(runtimeHome, 'identity-root');
  const projectId = 'path-durable-bridge-anchor';
  const cWorkspaceId = 'workspace-durable-bridge-c';
  const mntWorkspaceId = 'workspace-durable-bridge-mnt';
  const windowsWorkspaceId = 'workspace-durable-bridge-windows';
  const cRoot = '/c/dev/durablebridge';
  const mntRoot = '/mnt/c/dev/durablebridge';
  const windowsRoot = 'C:\\Dev\\DurableBridge';
  const cGit = '/c/dev/durablebridge/.git';
  const mntGit = '/mnt/c/dev/durablebridge/.git';
  const windowsGit = 'C:\\Dev\\DurableBridge\\.git';
  await mkdir(projectRoot, { recursive: true });

  const store = await openKernelStateStore({ runtimeHome });
  try {
    store.registerProjectIdentity({
      projectId,
      canonicalRoot: projectRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-durable-bridge-anchor',
    });
    const cWorkspace = store.registerProjectWorkspace({
      workspaceId: cWorkspaceId,
      canonicalRoot: cRoot,
      gitCommonDir: cGit,
      gitWorktreeDir: cGit,
      identity: { projectId, canonicalRoot: cRoot },
    });
    const mntWorkspace = store.registerProjectWorkspace({
      workspaceId: mntWorkspaceId,
      canonicalRoot: mntRoot,
      gitCommonDir: mntGit,
      gitWorktreeDir: mntGit,
      identity: { projectId, canonicalRoot: mntRoot },
    });
    const cWorktreeId = assertTestString(cWorkspace.worktreeId);
    const mntWorktreeId = assertTestString(mntWorkspace.worktreeId);
    assert.notEqual(cWorktreeId, mntWorktreeId);

    store.createRun({
      runId: 'run-durable-bridge-c',
      objective: 'mounted c authority before bridge',
      sourceIdentity: 'sha256:' + '6'.repeat(64),
      projectId,
      workspaceId: cWorkspaceId,
    });
    store.createRun({
      runId: 'run-durable-bridge-mnt',
      objective: 'mounted mnt authority before bridge',
      sourceIdentity: 'sha256:' + '7'.repeat(64),
      projectId,
      workspaceId: mntWorkspaceId,
    });

    const consolidated = store.registerProjectWorkspace({
      workspaceId: windowsWorkspaceId,
      canonicalRoot: windowsRoot,
      gitCommonDir: windowsGit,
      gitWorktreeDir: windowsGit,
      identity: { projectId, canonicalRoot: windowsRoot },
    });
    const survivorWorktreeId = assertTestString(consolidated.worktreeId);
    assert.equal(consolidated.workspaceId, windowsWorkspaceId);
    assert.equal(consolidated.canonicalRoot, 'c:/dev/durablebridge');
    assert.equal(store.getProjectWorkspace(cWorkspaceId), null);
    assert.equal(store.getProjectWorkspace(mntWorkspaceId), null);
    assert.equal(store.getWorktreeMutationLease(cWorktreeId), null);
    assert.equal(store.getWorktreeMutationLease(mntWorktreeId), null);
    for (const runId of ['run-durable-bridge-c', 'run-durable-bridge-mnt']) {
      const run = assertTestPresent(store.getRun(runId));
      assert.equal(run.workspaceId, windowsWorkspaceId);
      assert.equal(run.worktreeId, survivorWorktreeId);
    }
    assert.ok(store.getWorktreeMutationLease(survivorWorktreeId));

    const exactRootWithoutGit = store.registerProjectWorkspace({
      workspaceId: 'workspace-durable-bridge-windows-no-git',
      canonicalRoot: windowsRoot,
      gitCommonDir: null,
      gitWorktreeDir: null,
      identity: { projectId, canonicalRoot: windowsRoot },
    });
    assert.equal(exactRootWithoutGit.workspaceId, windowsWorkspaceId);
    assert.equal(exactRootWithoutGit.worktreeId, survivorWorktreeId);
    assert.equal(exactRootWithoutGit.gitCommonDir, 'c:/dev/durablebridge/.git');
    assert.equal(store.getProjectWorkspace('workspace-durable-bridge-windows-no-git'), null);

    const exactRootWithMountedGit = store.registerProjectWorkspace({
      workspaceId: 'workspace-durable-bridge-windows-mounted-git',
      canonicalRoot: windowsRoot,
      gitCommonDir: cGit,
      gitWorktreeDir: cGit,
      identity: { projectId, canonicalRoot: windowsRoot },
    });
    assert.equal(exactRootWithMountedGit.workspaceId, windowsWorkspaceId);
    assert.equal(exactRootWithMountedGit.worktreeId, survivorWorktreeId);
    assert.equal(exactRootWithMountedGit.gitCommonDir, 'c:/dev/durablebridge/.git');
    assert.equal(store.getProjectWorkspace('workspace-durable-bridge-windows-mounted-git'), null);

    for (const [workspaceId, canonicalRoot, gitCommonDir] of [
      ['workspace-durable-bridge-c-reobserved', cRoot, cGit],
      ['workspace-durable-bridge-mnt-reobserved', mntRoot, mntGit],
    ] as const) {
      const reobserved = store.registerProjectWorkspace({
        workspaceId,
        canonicalRoot,
        gitCommonDir,
        gitWorktreeDir: gitCommonDir,
        identity: { projectId, canonicalRoot },
      });
      assert.equal(reobserved.workspaceId, windowsWorkspaceId);
      assert.equal(reobserved.worktreeId, survivorWorktreeId);
      assert.equal(reobserved.canonicalRoot, 'c:/dev/durablebridge');
      assert.equal(store.getProjectWorkspace(workspaceId), null);
    }

    const dbAfter = new DatabaseSync(kernelDbPath(runtimeHome), { readOnly: true });
    try {
      const count = Number((dbAfter.prepare(
        'SELECT COUNT(*) AS count FROM project_workspaces WHERE project_id=?',
      ).get(projectId) as { count: number }).count);
      assert.equal(count, 1);
    } finally {
      dbAfter.close();
    }
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('same-project cross-surface workspace spelling without Git evidence remains distinct', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-workspace-cross-surface-unproven-'));
  const projectRoot = path.join(runtimeHome, 'identity-root');
  const projectId = 'path-workspace-cross-surface-unproven';
  const windowsRoot = 'C:\\Dev\\WorkspaceUnproven';
  const mountedRoot = '/c/dev/workspaceunproven';
  await mkdir(projectRoot, { recursive: true });
  const store = await openKernelStateStore({ runtimeHome });
  try {
    store.registerProjectIdentity({
      projectId,
      canonicalRoot: projectRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-workspace-cross-surface-unproven',
    });
    const windows = store.registerProjectWorkspace({
      workspaceId: 'workspace-unproven-windows',
      canonicalRoot: windowsRoot,
      gitCommonDir: null,
      gitWorktreeDir: null,
      identity: { projectId, canonicalRoot: windowsRoot },
    });
    const mounted = store.registerProjectWorkspace({
      workspaceId: 'workspace-unproven-mounted',
      canonicalRoot: mountedRoot,
      gitCommonDir: null,
      gitWorktreeDir: null,
      identity: { projectId, canonicalRoot: mountedRoot },
    });

    assert.notEqual(windows.workspaceId, mounted.workspaceId);
    assert.ok(store.getProjectWorkspace('workspace-unproven-windows'));
    assert.ok(store.getProjectWorkspace('workspace-unproven-mounted'));

    const reobservedWindows = store.registerProjectWorkspace({
      workspaceId: 'workspace-unproven-observation',
      canonicalRoot: windowsRoot,
      gitCommonDir: null,
      gitWorktreeDir: null,
      identity: { projectId, canonicalRoot: windowsRoot },
    });
    assert.equal(reobservedWindows.workspaceId, 'workspace-unproven-windows');
    assert.ok(store.getProjectWorkspace('workspace-unproven-mounted'));
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('cross-surface Git common-dir spelling alone cannot bind an unrelated root', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-git-only-cross-surface-'));
  const projectId = 'path-git-only-cross-surface';
  const windowsRoot = 'C:\\Dev\\GitOnlyRepository';
  const windowsGitCommonDir = 'C:\\Dev\\GitOnlyRepository\\.git';
  const unrelatedRoot = '/srv/unrelated-checkout';
  const mountedGitCommonDir = '/c/dev/gitonlyrepository/.git';
  const store = await openKernelStateStore({ runtimeHome });
  try {
    store.registerProjectIdentity({
      projectId,
      canonicalRoot: windowsRoot,
      identitySource: 'workspace_root',
      identityDigest: 'digest-git-only-cross-surface',
    });
    store.registerProjectWorkspace({
      workspaceId: 'workspace-git-only-cross-surface',
      canonicalRoot: windowsRoot,
      gitCommonDir: windowsGitCommonDir,
      gitWorktreeDir: windowsGitCommonDir,
      identity: { projectId, canonicalRoot: windowsRoot },
    });

    assert.throws(() => store.registerProjectIdentity({
      projectId,
      canonicalRoot: unrelatedRoot,
      identitySource: 'local_identity_file',
      identityDigest: 'digest-unrelated-cross-surface',
      gitCommonDir: mountedGitCommonDir,
    }), (error: unknown) => (
      assertTestRecord(error).code === 'project_identity_git_common_dir_unverified'
    ));

    const inspected = store.inspectProjectIdentity({
      projectId,
      canonicalRoot: unrelatedRoot,
      gitCommonDir: mountedGitCommonDir,
    });
    assert.equal(inspected.currentIdentity, null);
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('cross-surface canonical-root spelling alone is not surfaced as repository ownership evidence', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-canonical-split-'));
  const currentProjectId = 'path-current-canonical-split';
  const legacyProjectId = 'path-legacy-canonical-split';
  let store = await openKernelStateStore({ runtimeHome });
  try {
    store.registerProjectIdentity({
      projectId: currentProjectId,
      canonicalRoot: 'C:\\Dev\\CanonicalSplit',
      identitySource: 'workspace_root',
      identityDigest: 'digest-current-canonical-split',
    });
  } finally {
    store.close();
  }

  const db = new DatabaseSync(kernelDbPath(runtimeHome));
  try {
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO project_identities(
        project_id, canonical_root, identity_source,
        identity_digest, aliases_json, created_at, updated_at
      )
      VALUES(?, ?, ?, ?, '[]', ?, ?)
    `).run(
      legacyProjectId,
      '/c/dev/canonicalsplit',
      'workspace_root',
      'digest-legacy-canonical-split',
      timestamp,
      timestamp,
    );
  } finally {
    db.close();
  }

  store = await openKernelStateStore({ runtimeHome });
  try {
    const inspected = store.inspectProjectIdentity({
      projectId: currentProjectId,
      canonicalRoot: 'C:\\Dev\\CanonicalSplit',
      gitCommonDir: null,
      legacyCandidates: [],
    });
    assert.equal(assertTestPresent(inspected.currentIdentity).projectId, currentProjectId);
    assert.equal(
      inspected.legacyCandidates.some((item) => item.projectId === legacyProjectId),
      false,
    );
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('identity-only canonical-root split remains operator-gated and approvable', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-only-split-'));
  const projectRoot = path.join(tmp, 'repository');
  const runtimeHome = path.join(tmp, 'runtime');
  const legacyProjectId = 'path-identity-only-legacy';
  try {
    await mkdir(projectRoot, { recursive: true });
    const currentIdentity = resolveKernelProjectIdentity({
      cwd: projectRoot,
      env: { MOON_RELAY_KERNEL_HOME: runtimeHome },
    });
    const store = await openKernelStateStore({ runtimeHome });
    try {
      store.registerProjectIdentity(currentIdentity);
    } finally {
      store.close();
    }

    const db = new DatabaseSync(kernelDbPath(runtimeHome));
    try {
      const timestamp = new Date().toISOString();
      db.prepare(`
        INSERT INTO project_identities(
          project_id, canonical_root, identity_source,
          identity_digest, aliases_json, created_at, updated_at
        )
        VALUES(?, ?, ?, ?, '[]', ?, ?)
      `).run(
        legacyProjectId,
        process.platform === 'win32'
          ? currentIdentity.canonicalRoot.toUpperCase()
          : `${currentIdentity.canonicalRoot}/identity-only/..`,
        'workspace_root',
        'digest-identity-only-legacy',
        timestamp,
        timestamp,
      );
    } finally {
      db.close();
    }

    const before = await inspectKernelProjectIdentity({ projectRoot, runtimeHome });
    assert.equal(before.status, 'repair_required');
    const candidate = assertTestPresent(
      before.unresolvedLegacyCandidates.find((item) => item.projectId === legacyProjectId),
    );
    assert.equal(candidate.hasData, false);
    assert.equal(candidate.hasPersistedIdentity, true);
    assert.equal(candidate.sameRootEvidence, true);

    const approval = await approveKernelProjectIdentityRepair({
      projectRoot,
      runtimeHome,
      legacyProjectId,
      approvalRef: 'operator:identity-only-split',
      approvedBy: os.userInfo().username,
    });
    assert.equal(approval.status, 'approved');
    assert.equal(approval.legacyProjectId, legacyProjectId);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('persisted same-repository identity splits become operator-gated repair candidates and merge through existing migration authority', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-split-repair-'));
  const repository = path.join(tmp, 'repository');
  const legacyRoot = path.join(tmp, 'legacy-surface');
  const runtimeHome = path.join(tmp, 'runtime');
  try {
    await mkdir(repository, { recursive: true });
    await writeFile(path.join(repository, 'tracked.txt'), 'fixture\n');
    runGit(repository, ['init']);
    runGit(repository, ['config', 'user.email', 'kernel-test@example.invalid']);
    runGit(repository, ['config', 'user.name', 'Kernel Test']);
    runGit(repository, ['add', '.']);
    runGit(repository, ['commit', '-m', 'fixture']);
    await mkdir(legacyRoot, { recursive: true });

    const currentIdentity = resolveKernelProjectIdentity({ cwd: repository, env: { MOON_RELAY_KERNEL_HOME: runtimeHome } });
    const currentWorkspace = resolveStableWorkspaceIdentity({ projectId: currentIdentity.projectId, workspaceRoot: repository });
    const legacyProjectId = 'path-legacy-surface';
    let currentWorktreeIdBefore = '';
    const store = await openKernelStateStore({ runtimeHome });
    try {
      store.registerProjectIdentity(currentIdentity);
      const registeredCurrentWorkspace = store.registerProjectWorkspace(currentWorkspace);
      currentWorktreeIdBefore = assertTestString(registeredCurrentWorkspace.worktreeId);
      store.createRun({
        runId: 'current-surface-run',
        objective: 'current surface state',
        sourceIdentity: 'sha256:' + 'd'.repeat(64),
        projectId: currentIdentity.projectId,
        workspaceId: currentWorkspace.workspaceId,
      });
      store.registerProjectIdentity({
        projectId: legacyProjectId,
        canonicalRoot: legacyRoot,
        identitySource: 'workspace_root',
        identityDigest: 'digest-legacy-surface',
      });
      store.registerProjectWorkspace({
        workspaceId: 'workspace-legacy-surface',
        canonicalRoot: legacyRoot,
        gitCommonDir: currentWorkspace.gitCommonDir,
        gitWorktreeDir: currentWorkspace.gitWorktreeDir,
        identity: { projectId: legacyProjectId, canonicalRoot: legacyRoot },
      });
      store.createRun({
        runId: 'legacy-surface-run',
        objective: 'legacy surface state',
        sourceIdentity: 'sha256:' + 'e'.repeat(64),
        projectId: legacyProjectId,
        workspaceId: 'workspace-legacy-surface',
      });
      assert.equal(
        assertTestPresent(store.getWorktreeMutationLease(currentWorktreeIdBefore)).holderRunId,
        'current-surface-run',
      );
    } finally {
      store.close();
    }

    const before = await inspectKernelProjectIdentity({ projectRoot: repository, runtimeHome });
    assert.equal(before.status, 'repair_required');
    assert.equal(before.unresolvedLegacyCandidates.length, 1);
    assert.equal(before.unresolvedLegacyCandidates[0].projectId, legacyProjectId);
    assert.equal(before.unresolvedLegacyCandidates[0].sameRootEvidence, true);

    await approveKernelProjectIdentityRepair({
      projectRoot: repository,
      runtimeHome,
      legacyProjectId,
      approvalRef: 'operator:cross-surface-split',
      approvedBy: os.userInfo().username,
    });
    const repaired = await repairKernelProjectIdentity({
      projectRoot: repository,
      runtimeHome,
      legacyProjectId,
      approvalRef: 'operator:cross-surface-split',
    });
    assert.equal(repaired.projectId, legacyProjectId);
    assert.equal(repaired.mutation, 'identity-adopted-with-current-state-merge');

    const afterStore = await openKernelStateStore({ runtimeHome });
    try {
      assert.equal(afterStore.getProjectIdentity({ projectId: currentIdentity.projectId }), null);
      assert.equal(assertTestPresent(afterStore.getProjectIdentity({ projectId: legacyProjectId })).projectId, legacyProjectId);
      assert.equal(assertTestPresent(afterStore.getProjectIdentity({ alias: 'project-id:' + currentIdentity.projectId })).projectId, legacyProjectId);
      const migratedCurrentRun = assertTestPresent(afterStore.getRun('current-surface-run'));
      const migratedCurrentWorkspace = assertTestPresent(afterStore.getProjectWorkspace(currentWorkspace.workspaceId));
      assert.equal(migratedCurrentRun.projectId, legacyProjectId);
      assert.equal(migratedCurrentWorkspace.projectId, legacyProjectId);
      assert.equal(migratedCurrentRun.worktreeId, migratedCurrentWorkspace.worktreeId);
      assert.notEqual(migratedCurrentRun.worktreeId, currentWorktreeIdBefore);
      assert.equal(afterStore.getWorktreeMutationLease(currentWorktreeIdBefore), null);
      const migratedLease = assertTestPresent(
        afterStore.getWorktreeMutationLease(assertTestString(migratedCurrentRun.worktreeId)),
      );
      assert.equal(migratedLease.projectId, legacyProjectId);
      assert.equal(migratedLease.holderRunId, 'current-surface-run');
      const reboundWorkspace = afterStore.registerProjectWorkspace(resolveStableWorkspaceIdentity({
        projectId: legacyProjectId,
        workspaceRoot: repository,
      }));
      assert.equal(reboundWorkspace.workspaceId, currentWorkspace.workspaceId);
      assert.equal(reboundWorkspace.worktreeId, migratedCurrentRun.worktreeId);
      assert.equal(afterStore.acquireWorktreeMutationLease({
        worktreeId: assertTestString(migratedCurrentRun.worktreeId),
        projectId: legacyProjectId,
        runId: 'current-surface-run',
      }).acquired, true);
      assert.equal(assertTestPresent(afterStore.getRun('legacy-surface-run')).projectId, legacyProjectId);
    } finally {
      afterStore.close();
    }

    const after = await inspectKernelProjectIdentity({ projectRoot: repository, runtimeHome });
    assert.equal(after.status, 'ready');
    assert.equal(after.projectId, legacyProjectId);
    assert.equal(after.unresolvedLegacyCandidates.length, 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

type TestControlPlane = Awaited<ReturnType<typeof import('../src/host/kernel/control-plane-runtime.js').createKernelControlPlane>>;
type TestStateStore = Awaited<ReturnType<typeof import('../src/kernel/state-store.js').openKernelStateStore>>;

test('an existing exact-root identity resumes across a conflicting remote without adopting another checkout', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-identity-shared-remote-restart-'));
  const runtimeHome = path.join(tmp, 'runtime');
  const firstRoot = path.join(tmp, 'first');
  const secondRoot = path.join(tmp, 'second');
  const newRoot = path.join(tmp, 'new');
  const remote = 'https://example.invalid/shared-origin/repository.git';
  const open = async (projectRoot: string) => {
    const cp = await createKernelControlPlane({ runtimeHome, projectRoot, requireHostBinding: false });
    await cp.close();
  };
  try {
    for (const root of [firstRoot, secondRoot, newRoot]) {
      await mkdir(root, { recursive: true });
      runGit(root, ['init', '-q']);
    }
    // The first root was registered before it discovered the shared origin.
    await open(firstRoot);
    runGit(secondRoot, ['remote', 'add', 'origin', remote]);
    await open(secondRoot);

    const storeBefore = await openKernelStateStore({ runtimeHome });
    const first = assertTestPresent(storeBefore.getProjectIdentity({ canonicalRoot: firstRoot }));
    const second = assertTestPresent(storeBefore.getProjectIdentity({ canonicalRoot: secondRoot }));
    storeBefore.close();
    assert.notEqual(first.projectId, second.projectId);

    runGit(firstRoot, ['remote', 'add', 'origin', remote]);
    await open(firstRoot);
    const after = await openKernelStateStore({ runtimeHome });
    try {
      assert.equal(assertTestPresent(after.getProjectIdentity({ canonicalRoot: firstRoot })).projectId, first.projectId);
      assert.equal(assertTestPresent(after.getProjectIdentity({ canonicalRoot: secondRoot })).projectId, second.projectId);
      assert.equal(assertTestPresent(after.getProjectIdentity({ alias: remote.replace(/\.git$/, '') })).projectId, second.projectId);
    } finally {
      after.close();
    }

    // A new root with that remote has no exact-root proof and must still fail.
    runGit(newRoot, ['remote', 'add', 'origin', remote]);
    await assert.rejects(open(newRoot), (error: unknown) => (
      ['project_identity_alias_ownership_unproven', 'project_identity_git_common_dir_unverified', 'project_identity_alias_conflict']
        .includes(String(assertTestRecord(error).code))
    ));
    const finalStore = await openKernelStateStore({ runtimeHome });
    try {
      assert.equal(finalStore.getProjectIdentity({ canonicalRoot: newRoot }), null);
      assert.equal(assertTestPresent(finalStore.getProjectIdentity({ alias: remote.replace(/\.git$/, '') })).projectId, second.projectId);
    } finally {
      finalStore.close();
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
