import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { installKernelProfile, inspectProfile, uninstallKernelProfile } from '../scripts/kernel/profile-install.mjs';
import { doctorKernelProfile } from '../scripts/kernel/profile-doctor.mjs';

test('phase 02 installs all five Kernel profiles and preserves external files', async () => {
  const root = await mkdir(path.join(os.tmpdir(), `kernel-profiles-${Date.now()}`), { recursive: true });
  for (const runtime of ['claude', 'codex', 'qwen', 'ade', 'antigravity']) {
    const target = path.join(root, runtime);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'user-owned.txt'), 'preserve');
    const result = await installKernelProfile({ sourceRoot: process.cwd(), runtime, targetRoot: target });
    assert.match(result.status, /installed/);
    assert.equal((await doctorKernelProfile({ targetRoot: target, runtime })).status, 'ready');
    assert.equal(await readFile(path.join(target, 'user-owned.txt'), 'utf8'), 'preserve');
    const manifest = await inspectProfile(target);
    assert.equal(manifest.status, 'ready');
    assert.equal(manifest.manifest.runtime, 'moon-relay-kernel');
    assert.equal(manifest.manifest.provider, runtime);
    const uninstall = await uninstallKernelProfile({ targetRoot: target });
    assert.equal(uninstall.status, 'uninstalled');
    assert.equal(await readFile(path.join(target, 'user-owned.txt'), 'utf8'), 'preserve');
  }
});

test('phase 02 rejects unknown target collisions and modified owned files', async () => {
  const target = await mkdir(path.join(os.tmpdir(), `kernel-profile-collision-${Date.now()}`), { recursive: true });
  await writeFile(path.join(target, '.moon-relay-kernel-profile.json'), JSON.stringify({ schemaVersion: 1, productId: 'foreign' }));
  await assert.rejects(() => installKernelProfile({ sourceRoot: process.cwd(), runtime: 'codex', targetRoot: target }), /target_collision/);
});
