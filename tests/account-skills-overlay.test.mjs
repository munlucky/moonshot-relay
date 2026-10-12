import assert from 'node:assert/strict';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { installKernelProfile, inspectProfile } from '../scripts/kernel/profile-install.js';
import { buildProcessEnvironment } from '../scripts/switcher/launch-adapter.mjs';

test('native provider profile projection is idempotent and has no restore phase', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kernel-profile-projection-'));
  const targetRoot = path.join(home, '.claude');
  try {
    const first = await installKernelProfile({ sourceRoot: process.cwd(), runtime: 'claude', targetRoot });
    const manifestStat = await stat(first.manifestPath);
    const second = await installKernelProfile({ sourceRoot: process.cwd(), runtime: 'claude', targetRoot });
    assert.equal(second.status, 'already_current');
    assert.equal((await stat(second.manifestPath)).mtimeMs, manifestStat.mtimeMs);
    assert.equal((await inspectProfile(targetRoot)).status, 'ready');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('native surface environment preserves user Provider HOME bindings', () => {
  const baseEnv = {
    PATH: 'C:\\Windows\\System32',
    CODEX_HOME: 'C:\\Users\\moon\\.codex',
    CLAUDE_CONFIG_DIR: 'C:\\Users\\moon\\.claude',
    QWEN_HOME: 'C:\\Users\\moon\\.qwen',
    GEMINI_HOME: 'C:\\Users\\moon\\.gemini',
  };
  const env = buildProcessEnvironment({
    surface: 'codex_cli',
    roots: {
      runtimeHome: 'C:\\Users\\moon\\.moon-relay-kernel',
      providerHome: 'C:\\Users\\moon\\.codex',
    },
    baseEnv,
  });
  assert.equal(env.CODEX_HOME, baseEnv.CODEX_HOME);
  assert.equal(env.CLAUDE_CONFIG_DIR, baseEnv.CLAUDE_CONFIG_DIR);
  assert.equal(env.QWEN_HOME, baseEnv.QWEN_HOME);
  assert.equal(env.GEMINI_HOME, baseEnv.GEMINI_HOME);
  assert.equal(env.MOON_RELAY_KERNEL_RUNTIME, 'moon-relay-kernel');
});
