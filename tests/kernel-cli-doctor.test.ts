import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installKernel } from '../src/kernel/installer.js';
import { openKernelStateStore } from '../src/kernel/state-store.js';

const cliPath = fileURLToPath(new URL('../bin/moon-relay-kernel.mjs', import.meta.url));
const canonical = (value: string) => {
  const normalized = realpathSync(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};
const cleanTrackEnv = () => ({
  ...process.env,
  MOON_RELAY_TRACK: '',
  CODEX_THREAD_ID: '',
  MOON_RELAY_KERNEL_SESSION_ID: '',
  MOON_RELAY_KERNEL_RUN_ID: '',
  MOON_RELAY_KERNEL_HOME: path.join(os.tmpdir(), `krn-cli-no-runtime-${process.pid}`),
});

test('doctor reports wrong_harness with exit code 0 outside a Kernel project', async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'krn-cli-'));
  const r = spawnSync(process.execPath, [cliPath, 'doctor', '--json'], { cwd: d, env: cleanTrackEnv(), encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).status, 'wrong_harness');
});

test('assert-track reports wrong_harness with exit code 1 outside a Kernel project', async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'krn-cli-assert-'));
  const r = spawnSync(process.execPath, [cliPath, 'assert-track', '--json'], { cwd: d, env: cleanTrackEnv(), encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).status, 'wrong_harness');
});

test('doctor and assert-track are ready in a Kernel project, including nested subdirectories', async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'krn-cli2-'));
  const sub = path.join(d, 'nested', 'sub', 'dir');
  await mkdir(path.join(d, '.moon-relay'), { recursive: true });
  await mkdir(sub, { recursive: true });
  await writeFile(path.join(d, '.moon-relay', 'track.yaml'), 'track: kernel\nproduct: moon-relay-kernel\n');

  const rDoc = spawnSync(process.execPath, [cliPath, 'doctor', '--json'], { cwd: sub, env: cleanTrackEnv(), encoding: 'utf8' });
  assert.equal(rDoc.status, 0);
  assert.equal(JSON.parse(rDoc.stdout).status, 'ready');

  const rAssert = spawnSync(process.execPath, [cliPath, 'assert-track', '--json'], { cwd: sub, env: cleanTrackEnv(), encoding: 'utf8' });
  assert.equal(rAssert.status, 0);
  assert.equal(JSON.parse(rAssert.stdout).status, 'ready');
});

test('account-root runtime track admits an unmarked project and records only the exact workspace scope', async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'krn-cli-account-project-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-cli-account-runtime-'));
  try {
    await mkdir(path.join(runtimeHome, '.moon-relay'), { recursive: true });
    await writeFile(path.join(runtimeHome, '.moon-relay', 'track.yaml'), 'schemaVersion: 1\ntrack: kernel\nproduct: moon-relay-kernel\n');

    const result = spawnSync(process.execPath, [
      cliPath,
      'identity',
      'status',
      '--project-root',
      project,
      '--runtime-home',
      runtimeHome,
      '--json',
    ], { cwd: project, env: cleanTrackEnv(), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'bootstrap_required');
    const reportedRuntimeHome = path.resolve(payload.runtimeHome).replaceAll('\\', '/');
    assert.equal(process.platform === 'win32' ? reportedRuntimeHome.toLowerCase() : reportedRuntimeHome, canonical(runtimeHome));
    assert.equal((await import('../src/kernel/runtime-home.js')).resolveProjectTrackSync(project, {
      env: { ...cleanTrackEnv(), MOON_RELAY_KERNEL_HOME: runtimeHome },
    }).source, 'account_root_scope');
    assert.equal(existsSync(path.join(project, '.moon-relay', 'track.yaml')), false);
    assert.equal(existsSync(path.join(runtimeHome, 'state', 'track-scopes')), true);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('identity status and bootstrap establish a persisted root/workspace receipt', async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'krn-cli-identity-'));
  const runtimeHome = path.join(d, 'runtime');
  try {
    await mkdir(path.join(d, '.moon-relay'), { recursive: true });
    await writeFile(path.join(d, '.moon-relay', 'track.yaml'), 'track: kernel\nproduct: moon-relay-kernel\n');

    const status = spawnSync(process.execPath, [cliPath, 'identity', 'status', '--project-root', d, '--runtime-home', runtimeHome, '--json'], { cwd: d, encoding: 'utf8' });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).status, 'bootstrap_required');

    const bootstrap = spawnSync(process.execPath, [cliPath, 'identity', 'bootstrap', '--project-root', d, '--runtime-home', runtimeHome, '--policy', 'isolate', '--json'], { cwd: d, encoding: 'utf8' });
    assert.equal(bootstrap.status, 0, bootstrap.stderr);
    const bootstrapped = JSON.parse(bootstrap.stdout);
    assert.equal(bootstrapped.status, 'ready');
    assert.equal(bootstrapped.legacyState, 'preserved-unimported');
    assert.ok(bootstrapped.receipt.path);

    const doctor = spawnSync(process.execPath, [cliPath, 'doctor', '--project-root', d, '--runtime-home', runtimeHome, '--json'], { cwd: d, encoding: 'utf8' });
    assert.equal(doctor.status, 0, doctor.stderr);
    const diagnosed = JSON.parse(doctor.stdout);
    assert.equal(diagnosed.projectIdentity.status, 'ready');
    assert.equal(diagnosed.projectIdentity.canonicalRoot, canonical(d));
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test('doctor exposes unowned legacy identity and actionable remediation', async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'krn-cli-legacy-'));
  const runtimeHome = path.join(d, 'runtime');
  const legacyProjectId = 'github-com-example-legacy-cli-project';
  try {
    await mkdir(path.join(d, '.moon-relay'), { recursive: true });
    await writeFile(path.join(d, '.moon-relay', 'track.yaml'), 'track: kernel\nproduct: moon-relay-kernel\n');
    await mkdir(path.join(d, '.git'), { recursive: true });
    await writeFile(path.join(d, '.git', 'config'), '[remote "origin"]\n  url = https://github.com/example/legacy-cli-project.git\n');
    const store = await openKernelStateStore({ runtimeHome });
    store.createRun({
      runId: 'legacy-cli-run',
      objective: 'legacy identity diagnosis',
      sourceIdentity: `sha256:${'d'.repeat(64)}`,
      projectId: legacyProjectId,
    });
    store.close();

    const doctor = spawnSync(process.execPath, [cliPath, 'doctor', '--project-root', d, '--runtime-home', runtimeHome, '--json'], { cwd: d, encoding: 'utf8' });
    assert.equal(doctor.status, 0, doctor.stderr);
    const diagnosed = JSON.parse(doctor.stdout);
    assert.equal(diagnosed.projectIdentity.status, 'repair_required');
    assert.equal(diagnosed.projectIdentity.canonicalRoot, canonical(d));
    assert.equal(diagnosed.projectIdentity.unresolvedLegacyCandidates[0].projectId, legacyProjectId);
    assert.equal(diagnosed.diagnostics.findings.some((finding: unknown) => { assert.ok(finding && typeof finding === 'object' && 'code' in finding); return finding.code === 'project_identity_preflight_required'; }), true);
    assert.match(diagnosed.projectIdentity.remediation.adoptCommand, /--legacy-project-id/);
    assert.match(diagnosed.projectIdentity.remediation.isolateCommand, /identity bootstrap/);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test('next returns structured identity remediation before creating a Run', async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'krn-cli-next-legacy-'));
  const runtimeHome = path.join(d, 'runtime');
  const legacyProjectId = 'github-com-example-next-legacy-project';
  try {
    await mkdir(path.join(d, '.moon-relay'), { recursive: true });
    await writeFile(path.join(d, '.moon-relay', 'track.yaml'), 'track: kernel\nproduct: moon-relay-kernel\n');
    await mkdir(path.join(d, '.git'), { recursive: true });
    await writeFile(path.join(d, '.git', 'config'), '[remote "origin"]\n  url = https://github.com/example/next-legacy-project.git\n');
    const store = await openKernelStateStore({ runtimeHome });
    store.createRun({
      runId: 'legacy-next-run',
      objective: 'legacy identity diagnosis',
      sourceIdentity: `sha256:${'e'.repeat(64)}`,
      projectId: legacyProjectId,
    });
    store.close();

    const next = spawnSync(process.execPath, [
      cliPath,
      'next',
      '--run-id',
      'fresh-next-run',
      '--session-id',
      'codex:identity-preflight-test',
      '--provider',
      'codex',
      '--project-root',
      d,
      '--runtime-home',
      runtimeHome,
      '--json',
    ], {
      cwd: d,
      env: { ...cleanTrackEnv(), MOON_RELAY_KERNEL_HOME: runtimeHome },
      encoding: 'utf8',
    });
    assert.equal(next.status, 1);
    const jsonLine = next.stderr.split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith('{') && line.endsWith('}'));
    assert.ok(jsonLine, next.stderr);
    const payload = JSON.parse(jsonLine);
    assert.equal(payload.status, 'error');
    assert.equal(payload.errorCode, 'project_identity_preflight_required');
    assert.equal(payload.diagnostics.legacyProjectId, legacyProjectId);
    assert.match(payload.nextAction, /identity repair/);

    const after = await openKernelStateStore({ runtimeHome });
    try {
      assert.equal(after.getRun('fresh-next-run'), null);
      const observedValue3 = after.getRun('legacy-next-run');
    assert.ok(observedValue3);
    assert.equal(observedValue3.projectId, legacyProjectId);
    } finally {
      after.close();
    }
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test('uninstall validates the target project track when invoked from another directory', async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), 'krn-cli-target-'));
  const caller = await mkdtemp(path.join(os.tmpdir(), 'krn-cli-caller-'));
  await installKernel({ targetRoot: target, sourceRoot: process.cwd() });
  const result = spawnSync(process.execPath, [cliPath, 'uninstall', '--target-root', target, '--project-root', target, '--json'], {
    cwd: caller,
    env: { ...cleanTrackEnv(), MOON_RELAY_KERNEL_HOME: path.join(caller, 'runtime') },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'uninstalled');
  await rm(caller, { recursive: true, force: true });
  await rm(target, { recursive: true, force: true });
});
