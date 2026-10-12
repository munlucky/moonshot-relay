import { loadLegacyAsyncRecordFunction, loadLegacyRecordFunction } from './helpers/legacy-module-boundary.js';
import { assertTestRecord } from './helpers/assert-value.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
const buildLaunchSpec = await loadLegacyRecordFunction('scripts/switcher/launch-adapter.mjs', 'buildLaunchSpec');
const nativeProviderDescriptor = await loadLegacyRecordFunction('scripts/switcher/native-provider.mjs', 'nativeProviderDescriptor');
const resolveNativeProvider = await loadLegacyAsyncRecordFunction('scripts/switcher/native-provider.mjs', 'resolveNativeProvider');

test('Kernel launch delegates to the native provider and keeps managed runtime Node-only', async () => {
  const runtimeHome = path.join(os.tmpdir(), 'kernel-native-provider');
  const spec = buildLaunchSpec({
    surface: 'codex_cli',
    sourceRoot: process.cwd(),
    roots: { runtimeHome, providerHome: path.join(os.homedir(), '.codex') },
  });
  assert.equal(spec.command, 'codex');
  assert.ok(spec && typeof spec === 'object' && 'providerRuntime' in spec);
  assert.ok(spec.providerRuntime && typeof spec.providerRuntime === 'object');
  assert.ok(spec.providerRuntime && typeof spec.providerRuntime === 'object' && 'mode' in spec.providerRuntime);
  assert.equal(spec.providerRuntime.mode, 'native-provider');
  assert.ok(spec.providerRuntime && typeof spec.providerRuntime === 'object' && 'managedRuntime' in spec.providerRuntime);
  assert.equal(spec.providerRuntime.managedRuntime, 'kernel-node-only');
  assert.ok(spec.providerRuntime && typeof spec.providerRuntime === 'object' && 'executionLayer' in spec.providerRuntime);
  assert.equal(spec.providerRuntime.executionLayer, 'native-surface');
  assert.ok(spec.providerRuntime && typeof spec.providerRuntime === 'object' && 'runtimeIsolation' in spec.providerRuntime);
  assert.equal(spec.providerRuntime.runtimeIsolation, 'kernel-state-only');
  assert.ok(spec.providerRuntime && typeof spec.providerRuntime === 'object' && 'completionAuthority' in spec.providerRuntime);
  assert.equal(spec.providerRuntime.completionAuthority, 'kernel');
  const resolved = await resolveNativeProvider({ surface: 'codex_cli', commandResolver: async (name: string) => `C:/native/${name}.exe` });
  assert.equal(resolved.status, 'resolved');
  assert.ok(typeof resolved.resolvedCommand === 'string');
  assert.match(resolved.resolvedCommand, /native/);
});

test('Kernel refuses a provider binary copied under its managed runtime', () => {
  assert.throws(
    () => nativeProviderDescriptor({ surface: 'claude_cli', command: path.join(os.tmpdir(), 'kernel-native-provider', 'bin', 'claude.exe'), runtimeHome: path.join(os.tmpdir(), 'kernel-native-provider') }),
    /managed_provider_runtime_forbidden/,
  );
});

test('account-root setup routes installation through Kernel-only integration', async t => {
  const launcher = await readFile(path.join(process.cwd(), 'bin', 'moonshot-relay.mjs'), 'utf8');
  assert.doesNotMatch(launcher, /install-account-root-harness|install-project-runtime-bridge|relaySetupEnvironment|MOONSHOT_RELAY_HOME/);
  const home = await mkdtemp(path.join(os.tmpdir(), 'kernel-setup-policy-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const runtimeHome = path.join(home, 'kernel');
  const result = spawnSync(process.execPath, [path.join(process.cwd(), 'bin', 'moonshot-relay.mjs'), 'install', '--runtime', 'codex', '--codex-home', path.join(home, 'codex'), '--dry-run', '--json'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 120000,
    env: { ...process.env, HOME: home, USERPROFILE: home, MOON_RELAY_KERNEL_HOME: runtimeHome },
  });
  assert.equal(result.status, 0, result.stderr);
  const receipt = assertTestRecord(JSON.parse(result.stdout));
  assert.equal(receipt.productId, 'moon-relay-kernel');
  assert.equal(receipt.runtime, 'moon-relay-kernel');
  assert.equal(receipt.dryRun, true);
  assert.deepEqual(receipt.profileRuntimes, ['codex']);
  assert.deepEqual(receipt.manifests, []);
  await assert.rejects(access(path.join(runtimeHome, '.moon-relay', 'kernel-payload')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(home, 'codex', 'AGENTS.md')), { code: 'ENOENT' });
});

test('retired Relay options are rejected in both separated and equals forms', () => {
  const wrapper = path.join(process.cwd(), 'bin', 'moonshot-relay.mjs');
  const optionArgs = [
    ['--moonshot-home', 'C:/tmp/legacy'],
    ['--moonshot-home=C:/tmp/legacy'],
    ['--no-backup'],
    ['--no-backup=true'],
    ['--clean-overlay'],
    ['--clean-overlay=true'],
  ];
  for (const args of optionArgs) {
    const result = spawnSync(process.execPath, [wrapper, 'install', ...args, '--dry-run', '--json'], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, `${args.join(' ')} must be rejected`);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.errorCode, 'relay_track_retired');
    assert.equal(receipt.sensitiveContentRead, false);
  }
});
