import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalMutationPath, canonicalPathIdentity } from '../src/kernel/run/mutation-guard.js';
import { sameCrossSurfacePathIdentity } from '../src/shared/path-identity.js';
import { resolveMutationPath } from '../src/host/kernel/workspace/mutation-observation.js';
import { normalizeProviderMutationRequest } from '../src/host/kernel/provider-mutation-adapter.js';

test('mutation paths reject traversal and symlink escapes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-path-root-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'kernel-path-outside-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'app.mjs'), 'x');
  assert.equal(canonicalMutationPath({ workspaceRoot: root, targetPath: 'src/../src/app.mjs', resolveMutationPath }), 'src/app.mjs');
  assert.throws(() => canonicalMutationPath({ workspaceRoot: root, targetPath: '../escape', resolveMutationPath }), /mutation_outside_workspace/);
  await symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : undefined);
  assert.throws(() => canonicalMutationPath({ workspaceRoot: root, targetPath: 'link/file', resolveMutationPath }), /mutation_outside_workspace/);
});

test('path identity is deterministic for explicit Windows and POSIX semantics', () => {
  const value = './Src\\lib/../App.mjs';
  assert.equal(canonicalPathIdentity(value, { platform: 'win32' }), 'src/app.mjs');
  assert.equal(canonicalPathIdentity(value, { platform: 'linux' }), 'Src/App.mjs');
  assert.equal(canonicalPathIdentity('SRC\\App.mjs', { platform: 'win32' }), 'src/app.mjs');
  assert.equal(canonicalPathIdentity('SRC\\App.mjs', { platform: 'linux' }), 'SRC/App.mjs');
});

test('cross-surface path identity equates Windows drive paths with mounted drive forms only', () => {
  assert.equal(sameCrossSurfacePathIdentity('C:\\Dev\\Repo\\.git', '/c/dev/repo/.git'), true);
  assert.equal(sameCrossSurfacePathIdentity('c:/dev/repo/.git', '/mnt/c/DEV/REPO/.git'), true);
  assert.equal(sameCrossSurfacePathIdentity('/c/Dev/Repo/.git', '/mnt/c/Dev/Repo/.git'), false);
  assert.equal(sameCrossSurfacePathIdentity('/c/Dev/Repo/.git', '/mnt/c/dev/repo/.git'), false);
  assert.equal(sameCrossSurfacePathIdentity('/c/Repo/.git', '/c/repo/.git'), false);
  assert.equal(sameCrossSurfacePathIdentity('/mnt/C/Repo/.git', '/mnt/c/Repo/.git'), false);
  assert.equal(sameCrossSurfacePathIdentity('/C/Repo/.git', '/c/Repo/.git'), false);
  assert.equal(sameCrossSurfacePathIdentity('C:/repo/.git', '/mnt/C/REPO/.git'), false);
  assert.equal(sameCrossSurfacePathIdentity('C:', '/c'), false);
  assert.equal(sameCrossSurfacePathIdentity('C:', 'C:/'), false);
  assert.equal(sameCrossSurfacePathIdentity('C:/', '/c'), true);
  assert.equal(sameCrossSurfacePathIdentity('C:/dev/repo', '/c\\dev\\repo'), false);
  assert.equal(sameCrossSurfacePathIdentity('C:/dev/repo', '/mnt/c\\dev\\repo'), false);
  assert.equal(canonicalPathIdentity('/c\\dev\\repo', { platform: 'linux' }), '/c/dev/repo');
  assert.equal(sameCrossSurfacePathIdentity('C:/repo?/child', '/c/repo?/child'), false);
  assert.equal(sameCrossSurfacePathIdentity('C:/CON', '/c/CON'), false);
  assert.equal(sameCrossSurfacePathIdentity('C:/repo.', '/c/repo.'), false);
  assert.equal(sameCrossSurfacePathIdentity('C:/repo', '/c/repo '), false);
  assert.equal(sameCrossSurfacePathIdentity('C:/repo', ' /c/repo'), false);
  assert.equal(sameCrossSurfacePathIdentity('/c/repo ', '/c/repo'), false);
  assert.equal(sameCrossSurfacePathIdentity('/c/repo ', '/c/repo '), true);
  assert.equal(sameCrossSurfacePathIdentity('C:/foo:bar', '/c/foo:bar'), false);
  assert.equal(sameCrossSurfacePathIdentity('d:/dev/repo/.git', '/c/dev/repo/.git'), false);
  assert.equal(sameCrossSurfacePathIdentity('/srv/Repo/.git', '/srv/repo/.git'), false);
  assert.equal(sameCrossSurfacePathIdentity('dir\\file', 'dir/file'), false);
  assert.equal(sameCrossSurfacePathIdentity('dir/./file', 'dir/file'), true);
});

test('provider adapters only normalize mutation payloads', () => {
  assert.deepEqual(normalizeProviderMutationRequest({
    provider: 'claude',
    payload: { tool_name: 'Write', tool_input: { file_path: 'src/a.mjs', path: 'src/a.mjs' } },
    context: { runId: 'r', stepId: 's', capsuleId: 'c', fencingToken: 2, sessionToken: 'h' },
  }), {
    provider: 'claude',
    runId: 'r',
    stepId: 's',
    capsuleId: 'c',
    fencingToken: 2,
    sessionToken: 'h',
    operation: 'file_write',
    targetPaths: ['src/a.mjs'],
  });
});
