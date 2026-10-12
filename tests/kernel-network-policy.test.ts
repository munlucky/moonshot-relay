import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { probeNetworkEnforcement, resolveNetworkExecution, NetworkPolicyUnenforceableError } from '../src/host/kernel/proof/network-policy.js';
import { executeTrustedProof } from '../src/host/kernel/proof/proof-executor.js';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';

test('inherited policy honestly records no isolation', () => {
  const resolved = resolveNetworkExecution({ policy: 'inherited', env: {} });
  assert.equal(resolved.networkIsolation, 'none');
  assert.equal(resolved.enforced, false);
});

test('blocked/required refuse to claim isolation when no sandbox is available', () => {
  assert.equal(probeNetworkEnforcement({ env: {} }).enforceable, false);
  assert.throws(() => resolveNetworkExecution({ policy: 'blocked', env: {} }), NetworkPolicyUnenforceableError);
  assert.throws(() => resolveNetworkExecution({ policy: 'required', env: {} }), NetworkPolicyUnenforceableError);
});

test('declaring a mechanism is not enforcement: unknown or absent wrappers stay unenforceable', () => {
  // An arbitrary string is a declaration, not a mechanism the Kernel can apply.
  const bogus = probeNetworkEnforcement({ env: { MOON_RELAY_KERNEL_NETWORK_SANDBOX: 'totally-made-up' }, platform: 'linux', binaryExists: () => true });
  assert.equal(bogus.enforceable, false);
  assert.ok(bogus.reason);
  assert.match(bogus.reason, /unsupported-mechanism/);

  // A known mechanism whose binary is missing cannot isolate anything.
  const missing = probeNetworkEnforcement({ env: { MOON_RELAY_KERNEL_NETWORK_SANDBOX: 'firejail' }, platform: 'linux', binaryExists: () => false });
  assert.equal(missing.enforceable, false);
  assert.ok(missing.reason);
  assert.match(missing.reason, /binary-not-found/);

  // A known mechanism on an unsupported platform likewise cannot.
  const wrongPlatform = probeNetworkEnforcement({ env: { MOON_RELAY_KERNEL_NETWORK_SANDBOX: 'firejail' }, platform: 'win32', binaryExists: () => true });
  assert.equal(wrongPlatform.enforceable, false);
});

test('blocked is honored only when a real wrapper is applied to the child argv', () => {
  const env = { MOON_RELAY_KERNEL_NETWORK_SANDBOX: 'firejail' };
  const probe = probeNetworkEnforcement({ env, platform: 'linux', binaryExists: () => true });
  assert.equal(probe.enforceable, true);

  const resolved = resolveNetworkExecution({ policy: 'blocked', env, platform: 'linux', binaryExists: () => true });
  assert.equal(resolved.networkIsolation, 'blocked');
  assert.equal(resolved.enforced, true);
  assert.equal(resolved.mechanism, 'firejail');

  // The isolation claim is only honest because the argv is actually wrapped.
  const wrapped = resolved.wrapArgv('npm', ['run', 'test']);
  assert.equal(wrapped.command, 'firejail');
  assert.deepEqual(wrapped.args, ['--quiet', '--net=none', '--', 'npm', 'run', 'test']);
});

test('an unenforceable declaration blocks instead of recording false isolation', () => {
  assert.throws(
    () => resolveNetworkExecution({ policy: 'blocked', env: { MOON_RELAY_KERNEL_NETWORK_SANDBOX: 'firejail' }, platform: 'linux', binaryExists: () => false }),
    NetworkPolicyUnenforceableError,
  );
});

test('trusted proof records isolation none under inherited policy', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-net-'));
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'x', scripts: { 'test:ok': 'node -e "process.exit(0)"' } }));
  try {
    const execution = executeTrustedProof({ projectRoot, commandRef: 'test:ok', timeoutMs: 60000 });
    assert.equal(execution.networkIsolation, 'none');
    assert.equal(execution.networkPolicy, 'inherited');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('report blocks the run when a required network policy cannot be enforced', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-net-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-net-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'x', scripts: { 'test:ok': 'node -e "process.exit(0)"' } }));
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    await cp.startRun({ runId: 'r-net', objective: 'x' });
    const res = await cp.report('r-net', {
      summary: 'needs isolation',
      verifications: [{ obligationId: 'default', commandRef: 'test:ok', networkPolicy: 'required' }],
    });
    assert.ok(res && 'blockedReason' in res);
    assert.equal(res.status, 'blocked');
    assert.equal(res.blockedReason, 'network-policy');
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});
