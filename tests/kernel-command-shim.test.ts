import { loadLegacyRecordFunction } from './helpers/legacy-module-boundary.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { materializeKernelCommandShim } from '../src/kernel/installer.js';
const buildProcessEnvironment = await loadLegacyRecordFunction('scripts/switcher/launch-adapter.mjs', 'buildProcessEnvironment');

test('process-scoped kernel shim executes without changing the parent PATH', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-shim-'));
  const entrypoint = path.join(runtimeHome, 'entrypoint.mjs');
  await writeFile(entrypoint, 'console.log(JSON.stringify({ argv: process.argv.slice(2) }))');
  const originalPath = process.env.PATH;
  const installed = await materializeKernelCommandShim({ runtimeHome, entrypoint });
  const env = buildProcessEnvironment({
    surface: 'codex_cli',
    track: 'kernel',
    roots: { runtimeHome, providerHome: path.join(os.homedir(), '.codex') },
    runId: 'run-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    baseEnv: { PATH: originalPath },
  });
  assert.equal(process.env.PATH, originalPath);
  assert.ok(env && typeof env === 'object' && 'PATH' in env);
  assert.ok(typeof env.PATH === 'string');
  assert.equal(env.PATH.split(path.delimiter)[0], path.join(runtimeHome, 'bin'));
  assert.equal(env.MOON_RELAY_KERNEL_RUN_ID, 'run-1');
  if (process.platform !== 'win32') {
    const shim = installed.written[0];
    await access(shim, constants.X_OK);
    assert.match(await readFile(shim, 'utf8'), /^#!\/bin\/sh/);
    const result = spawnSync(shim, ['next'], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(result.stdout).argv, ['next']);
  }
});

test('command shim reconciliation retires only the exact legacy Host shims', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-shim-retire-'));
  const binDir = path.join(runtimeHome, 'bin');
  const entrypoint = path.join(runtimeHome, 'payload', 'bin', 'moon-relay-kernel.mjs');
  const legacyHost = path.join(runtimeHome, 'payload', 'bin', 'moon-relay-kernel-host.mjs');
  await mkdir(binDir, { recursive: true });

  const legacy = process.platform === 'win32'
    ? [
      [path.join(binDir, 'kernel-host.cmd'), `@echo off\r\nnode "${legacyHost}" %*\r\n`],
      [path.join(binDir, 'kernel-host.ps1'), `& node "${legacyHost}" @args\r\n`],
    ]
    : [[path.join(binDir, 'kernel-host'), `#!/bin/sh\nexec node "${legacyHost}" "$@"\n`]];
  for (const [file, content] of legacy) await writeFile(file, content);

  const installed = await materializeKernelCommandShim({ runtimeHome, entrypoint });
  assert.deepEqual(installed.retired, legacy.map(([file]) => file));
  for (const [file] of legacy) await assert.rejects(access(file));
  assert.ok(installed.written.length >= 1);
});
