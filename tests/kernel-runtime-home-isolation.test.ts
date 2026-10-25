import assert from 'node:assert/strict';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { resolveKernelRuntimeHome, assertIsolatedRuntimeHomes } from '../src/kernel/runtime-home.js';

test('Kernel runtime home defaults to an isolated account-root path', () => {
  const base = process.platform === 'win32' ? path.parse(os.tmpdir()).root : '/tmp';
  const requestedHome = path.join(base, 'alice');
  const home = resolveKernelRuntimeHome({ env: {}, home: requestedHome });
  assert.equal(home, path.join(realpathSync(base), 'alice', '.moon-relay-kernel'));
  assert.equal(assertIsolatedRuntimeHomes(home, path.join(requestedHome, '.moonshot-relay')), true);
});

test('shared or nested Relay home is rejected', () => {
  assert.throws(() => assertIsolatedRuntimeHomes('/tmp/x/.moonshot-relay', '/tmp/x/.moonshot-relay'));
});

test('runtime path aliases resolve to one canonical Kernel runtime identity', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-home-alias-'));
  const kernel = path.join(root, 'kernel');
  const alias = path.join(root, 'kernel-alias');
  try {
    await mkdir(kernel, { recursive: true });
    try {
      await symlink(kernel, alias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (process.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EPERM') {
        t.skip('Windows symlink/junction creation is unavailable in this account');
        return;
      }
      throw error;
    }
    const physical = resolveKernelRuntimeHome({
      env: { MOON_RELAY_KERNEL_HOME: kernel },
    });
    const aliased = resolveKernelRuntimeHome({
      env: { MOON_RELAY_KERNEL_HOME: alias },
    });
    assert.equal(aliased, physical);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime isolation follows symlinked homes before comparing ancestry', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-home-symlink-'));
  const kernel = path.join(root, 'kernel');
  const alias = path.join(root, 'kernel-alias');
  try {
    await mkdir(kernel, { recursive: true });
    try {
      await symlink(kernel, alias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (process.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EPERM') {
        t.skip('Windows symlink/junction creation is unavailable in this account');
        return;
      }
      throw error;
    }
    assert.throws(() => assertIsolatedRuntimeHomes(kernel, alias), /isolated/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
