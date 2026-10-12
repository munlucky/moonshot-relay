import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { prepareTransaction, advanceTransaction, recoverTransaction } from '../scripts/switcher/transaction.mjs';
import { readJournal } from '../scripts/switcher/state-store.mjs';
import { switchDoctor, launchSwitch } from '../scripts/switcher/operations.mjs';
import { buildLaunchSpec, buildProcessEnvironment, spawnNativeSurface } from '../scripts/switcher/launch-adapter.mjs';
import { resolveSurfaceRoots } from '../scripts/switcher/paths.mjs';

test('native root resolution fails closed when a Provider HOME points inside Kernel runtime', () => {
  const root = path.join(os.tmpdir(), 'native-root-boundary-' + Date.now());
  assert.throws(
    () => resolveSurfaceRoots({
      surface: 'codex_cli',
      kernelHome: root,
      baseEnv: { USERPROFILE: root, CODEX_HOME: path.join(root, 'provider') },
    }),
    (error) => error.code === 'unsafe_target',
  );
});

test('Kernel launch environment preserves every user Provider HOME binding', () => {
  const workspaceRoot = path.resolve('test-project');
  const baseEnv = {
    PATH: 'C:\\Windows\\System32',
    Path: 'C:\\Windows\\System32',
    CLAUDE_HOME: 'C:\\Users\\moon\\.claude',
    CLAUDE_CONFIG_DIR: 'C:\\Users\\moon\\.claude',
    CODEX_HOME: 'C:\\Users\\moon\\.codex',
    QWEN_HOME: 'C:\\Users\\moon\\.qwen',
    GEMINI_HOME: 'C:\\Users\\moon\\.gemini',
    ANTIGRAVITY_HOME: 'C:\\Users\\moon\\.gemini\\antigravity',
    ANTIGRAVITY_SKILLS_HOME: 'C:\\Users\\moon\\.gemini\\config',
    MOON_RELAY_TRACK: 'obsolete',
  };
  const env = buildProcessEnvironment({
    surface: 'codex_cli',
    roots: { runtimeHome: 'C:\\Users\\moon\\.moon-relay-kernel', providerHome: 'C:\\Users\\moon\\.codex' },
    workspaceRoot,
    baseEnv,
  });
  for (const key of ['CLAUDE_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'QWEN_HOME', 'GEMINI_HOME', 'ANTIGRAVITY_HOME', 'ANTIGRAVITY_SKILLS_HOME']) {
    assert.equal(env[key], baseEnv[key], key);
  }
  assert.equal(env.MOON_RELAY_KERNEL_RUNTIME, 'moon-relay-kernel');
  assert.equal(env.MOON_RELAY_WORKSPACE_ROOT, workspaceRoot);
  assert.equal(env.MOON_RELAY_TRACK, undefined);
  assert.equal(env.Path, undefined);
});

test('Kernel task binding is process-scoped in native launch specs', () => {
  const spec = buildLaunchSpec({
    surface: 'codex_cli',
    sourceRoot: process.cwd(),
    workspaceRoot: process.cwd(),
    workspaceId: 'workspace-1',
    runId: 'run-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    roots: { runtimeHome: 'C:\\kernel', providerHome: 'C:\\Users\\moon\\.codex' },
  });
  assert.equal(spec.runtime, 'moon-relay-kernel');
  assert.equal(spec.env.MOON_RELAY_KERNEL_RUN_ID, 'run-1');
  assert.equal(spec.env.MOON_RELAY_KERNEL_PROJECT_ID, 'project-1');
  assert.equal(spec.env.MOON_RELAY_KERNEL_SESSION_ID, 'codex-cli:session-1');
  assert.equal(spec.env.MOON_RELAY_KERNEL_PROVIDER, 'codex-cli');
  assert.equal(spec.env.MOON_RELAY_KERNEL_WORKSPACE_ID, 'workspace-1');
  assert.equal(spec.providerRuntime.completionAuthority, 'kernel');
});

test('transaction journal follows Kernel runtime lifecycle and recovery states', async () => {
  const home = path.join(os.tmpdir(), 'switcher-state-' + Date.now());
  process.env.MOON_HARNESS_SWITCHER_HOME = home;
  try {
    const journal = await prepareTransaction({ surface: 'codex_cli', requestedRuntime: 'moon-relay-kernel', roots: { runtimeHome: path.join(home, 'kernel') } });
    assert.equal(journal.state, 'prepared');
    assert.equal(journal.requestedRuntime, 'moon-relay-kernel');
    const stopped = await advanceTransaction(journal, 'old_app_stopped');
    assert.equal(stopped.state, 'old_app_stopped');
    const recovery = await recoverTransaction();
    assert.equal(recovery.status, 'recovery_required');
    assert.equal((await readJournal()).state, 'recovery_required');
  } finally {
    delete process.env.MOON_HARNESS_SWITCHER_HOME;
    await rm(home, { recursive: true, force: true });
  }
});

test('active GUI process refuses a new Kernel launch without explicit close approval', async () => {
  const home = path.join(os.tmpdir(), 'switcher-active-' + Date.now());
  process.env.MOON_HARNESS_SWITCHER_HOME = home;
  try {
    const receipt = await launchSwitch({
      surface: 'codex_desktop',
      sourceRoot: process.cwd(),
      processProvider: async () => [{ pid: 99, name: 'ChatGPT' }],
      dryRun: true,
    });
    assert.equal(receipt.status, 'close_incomplete');
    assert.equal(receipt.errorCode, 'operator_approval_missing');
    const doctor = await switchDoctor({ surface: 'codex_desktop', processProvider: async () => [{ pid: 99, name: 'ChatGPT' }] });
    assert.equal(doctor.reports.codex_desktop.status, 'process_active');
  } finally {
    delete process.env.MOON_HARNESS_SWITCHER_HOME;
    await rm(home, { recursive: true, force: true });
  }
});

test('native Claude Desktop launch uses the platform-native activation path', () => {
  const roots = { runtimeHome: 'C:\\Users\\moon\\.moon-relay-kernel', providerHome: 'C:\\Users\\moon\\.claude' };
  const spec = buildLaunchSpec({ surface: 'claude_desktop', sourceRoot: process.cwd(), roots, args: ['--resume'] });
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return { pid: 123, on() {}, unref() {} };
  };
  const windows = spawnNativeSurface(spec, { platform: 'win32', spawnImpl, execFileSyncImpl: () => 'ClaudeFamily' });
  assert.equal(windows.launcher, 'cmd_shell_activation');
  assert.equal(calls[0].args[0], '/c');
  assert.equal(calls[0].args[2], 'shell:AppsFolder\\ClaudeFamily!Claude');
  calls.length = 0;
  const mac = spawnNativeSurface(spec, { platform: 'darwin', spawnImpl });
  assert.equal(mac.launcher, 'macos_open');
  assert.equal(calls[0].command, 'open');
  assert.deepEqual(calls[0].args.slice(0, 2), ['-a', 'Claude']);
});

test('native surface launcher tolerates a missing CLI executable without an unhandled error event', () => {
  const spec = buildLaunchSpec({
    surface: 'qwen_cli',
    sourceRoot: process.cwd(),
    roots: { runtimeHome: 'C:\\Users\\moon\\.moon-relay-kernel', providerHome: 'C:\\Users\\moon\\.qwen' },
    command: 'nonexistent-qwen-test-binary',
  });
  const result = spawnNativeSurface(spec, { platform: 'linux' });
  assert.equal(result.status, 'launch_requested');
  assert.equal(result.launcher, 'direct');
});

test('Antigravity desktop launch detaches on Windows', () => {
  let launchOptions = null;
  const spec = buildLaunchSpec({
    surface: 'antigravity_desktop',
    sourceRoot: process.cwd(),
    command: 'Antigravity.exe',
    roots: {
      runtimeHome: 'C:\\Users\\moon\\.moon-relay-kernel',
      providerHome: 'C:\\Users\\moon\\.gemini\\antigravity',
      appDataRoot: 'C:\\Users\\moon\\AppData\\Roaming\\Antigravity',
    },
  });
  const result = spawnNativeSurface(spec, {
    platform: 'win32',
    spawnImpl: (_command, _args, options) => {
      launchOptions = options;
      return { pid: 1234, on() {}, unref() {} };
    },
  });
  assert.equal(result.launcher, 'direct');
  assert.equal(launchOptions.detached, true);
  assert.equal(launchOptions.windowsHide, false);
});
