import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { access, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { hydrateKernelProject } from '../src/kernel/project-hydrate.js';
import { cleanupLegacyKernelHydration } from '../src/kernel/legacy-hydration-cleanup.js';

const sourceRoot = path.resolve(process.cwd());
const makeTempDir = () => mkdtemp(path.join(os.tmpdir(), 'kernel-legacy-hydration-'));

test('legacy cleanup removes only checksum-matched untracked Kernel files', async () => {
  const projectRoot = await makeTempDir();
  try {
    await hydrateKernelProject({ projectRoot, sourceRoot });
    await writeFile(path.join(projectRoot, 'user-file.txt'), 'hello');
    const result = await cleanupLegacyKernelHydration({ projectRoot, profileReady: true });
    assert.equal(result.status, 'cleaned');
    assert.equal(await readFile(path.join(projectRoot, 'user-file.txt'), 'utf8'), 'hello');
    assert.ok(result.removed);
  assert.ok(result.removed.includes('.moon-relay/kernel-profile-manifest.json'));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('legacy cleanup preserves modified files and reports checksum conflicts', async () => {
  const projectRoot = await makeTempDir();
  try {
    await hydrateKernelProject({ projectRoot, sourceRoot });
    const modified = path.join(projectRoot, 'AGENTS.override.md');
    await writeFile(modified, '# user modified\n');
    const result = await cleanupLegacyKernelHydration({ projectRoot, profileReady: true });
    assert.equal(result.status, 'collision');
    assert.equal(await readFile(modified, 'utf8'), '# user modified\n');
    assert.ok(result.conflicts);
  assert.ok(result.conflicts.some((entry) => entry.path === 'AGENTS.override.md'));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('legacy cleanup preserves tracked files even when checksum matches', async () => {
  const projectRoot = await makeTempDir();
  try {
    await hydrateKernelProject({ projectRoot, sourceRoot });
    spawnSync('git', ['init'], { cwd: projectRoot });
    spawnSync('git', ['add', 'AGENTS.override.md'], { cwd: projectRoot });
    const result = await cleanupLegacyKernelHydration({ projectRoot, profileReady: true });
    assert.equal(result.status, 'cleaned');
    assert.ok(result.preserved);
  assert.ok(result.preserved.some((entry) => entry.path === 'AGENTS.override.md' && entry.reason === 'tracked'));
    assert.equal(typeof await readFile(path.join(projectRoot, 'AGENTS.override.md'), 'utf8'), 'string');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('legacy cleanup refuses to run before account provider profile readiness', async () => {
  const projectRoot = await makeTempDir();
  try {
    await mkdir(projectRoot, { recursive: true });
    const result = await cleanupLegacyKernelHydration({ projectRoot, profileReady: false });
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'account_profile_not_ready');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('legacy cleanup refuses junction or symlink traversal outside the project', async () => {
  const projectRoot = await makeTempDir();
  const externalRoot = await makeTempDir();
  try {
    await hydrateKernelProject({ projectRoot, sourceRoot });
    await rename(path.join(projectRoot, '.agents'), path.join(externalRoot, '.agents'));
    await symlink(
      path.join(externalRoot, '.agents'),
      path.join(projectRoot, '.agents'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = await cleanupLegacyKernelHydration({ projectRoot, profileReady: true });

    assert.equal(result.status, 'collision');
    assert.ok(result.conflicts);
  assert.ok(result.conflicts.some((entry) => entry.path.startsWith('.agents/') && entry.reason === 'link_or_path_escape'));
    await access(path.join(externalRoot, '.agents', 'skills', 'moon-relay-kernel', 'SKILL.md'));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});
