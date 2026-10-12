import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installKernelProfile, profileManifestPath } from '../src/kernel/profile-install.js';

test('native profile sync excludes source Python cache and preserves unmanaged account cache', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kernel-profile-cache-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sourceRoot = path.join(home, 'source');
  const targetRoot = path.join(home, 'account');
  const runtimeHome = path.join(home, 'runtime');
  for (const relative of ['package/kernel/profiles/claude', 'skills', 'scripts/kernel/standalone', 'catalog/standalone-skills.json']) {
    await mkdir(path.dirname(path.join(sourceRoot, relative)), { recursive: true });
    await cp(path.join(process.cwd(), relative), path.join(sourceRoot, relative), { recursive: true });
  }
  const cachePaths = ['skills/moon-relay-kernel/scripts/__pycache__/kernel.pyc', 'skills/codebase-master-guide/scripts/__pycache__/render.pyc'];
  for (const relative of cachePaths) {
    await mkdir(path.dirname(path.join(sourceRoot, relative)), { recursive: true });
    await mkdir(path.dirname(path.join(targetRoot, relative)), { recursive: true });
    await writeFile(path.join(sourceRoot, relative), 'generated source cache');
    await writeFile(path.join(targetRoot, relative), 'unmanaged account cache');
  }
  const installed = await installKernelProfile({ sourceRoot, runtime: 'claude', targetRoot, runtimeHome });
  assert.equal(installed.status, 'installed');
  assert.equal((await installKernelProfile({ sourceRoot, runtime: 'claude', targetRoot, runtimeHome, force: true })).status, 'reinstalled');
  for (const relative of cachePaths) assert.equal(await readFile(path.join(targetRoot, relative), 'utf8'), 'unmanaged account cache');
  const manifest: unknown = JSON.parse(await readFile(profileManifestPath(targetRoot), 'utf8'));
  assert.ok(manifest && typeof manifest === 'object' && 'files' in manifest && Array.isArray(manifest.files));
  for (const entry of manifest.files as unknown[]) {
    assert.ok(entry && typeof entry === 'object' && 'path' in entry && typeof entry.path === 'string');
    assert.doesNotMatch(entry.path, /__pycache__|\.pyc$/);
  }
});
