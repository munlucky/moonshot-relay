import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildKernelProfile, inspectKernelProfile } from '../src/kernel/profile-build.js';

test('Codex profile materializes Kernel marker without Relay catalog and configures executable PATH launcher hook', async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'krn-profile-'));
  const sourceRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  await buildKernelProfile({ sourceRoot, runtime: 'codex', targetRoot: d });

  const marker = await inspectKernelProfile(d);
  assert.equal(marker.track, 'kernel');

  const agents = await readFile(path.join(d, 'AGENTS.override.md'), 'utf8');
  assert.doesNotMatch(agents, /moonshot-orchestrator/);

  const hooksText = await readFile(path.join(d, '.codex', 'hooks.json'), 'utf8');
  const hooks = JSON.parse(hooksText);
  assert.ok(Array.isArray(hooks.hooks.SessionStart));
  const hookCmd = hooks.hooks.SessionStart[0].hooks[0].command;
  assert.match(hookCmd, /^moon-relay-kernel\s+assert-track/);

  // Setup temporary launcher bin directory and register on PATH
  const tempBinDir = await mkdtemp(path.join(os.tmpdir(), 'krn-bin-launcher-'));
  const binSource = path.join(sourceRoot, 'bin', 'moon-relay-kernel.mjs');
  const isWin = process.platform === 'win32';

  if (isWin) {
    const cmdContent = `@echo off\r\nnode "${binSource}" %*\r\n`;
    await writeFile(path.join(tempBinDir, 'moon-relay-kernel.cmd'), cmdContent);
  } else {
    const shContent = `#!/bin/sh\nnode "${binSource}" "$@"\n`;
    const shPath = path.join(tempBinDir, 'moon-relay-kernel');
    await writeFile(shPath, shContent);
    await chmod(shPath, 0o755);
  }

  const customEnv = {
    ...process.env,
    MOON_RELAY_TRACK: '',
    MOON_RELAY_KERNEL_HOME: path.join(d, 'non-kernel-runtime'),
    CODEX_THREAD_ID: '',
    MOON_RELAY_KERNEL_SESSION_ID: '',
    MOON_RELAY_KERNEL_RUN_ID: '',
    PATH: `${tempBinDir}${path.delimiter}${process.env.PATH || ''}`,
  };

  // Execute the exact hook command string in non-repo directory via PATH resolution (expects exit code 1)
  try {
    execSync(hookCmd, { cwd: d, env: customEnv, encoding: 'utf8' });
    assert.fail('Expected assert-track hook command to exit with code 1 in non-kernel directory');
  } catch (err) {
    assert.ok(err && typeof err === 'object' && 'status' in err && 'stdout' in err);
    assert.equal(err.status, 1);
    const parsed = JSON.parse(String(err.stdout));
    assert.equal(parsed.status, 'wrong_harness');
  }
});
