import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { SURFACES } from '../scripts/switcher/constants.mjs';
import { resolveApplication } from '../scripts/switcher/app-resolver/index.mjs';

const RECEIPT_SCHEMA = 'moon-relay-kernel.native-smoke.v1';

const emitReceipt = (t, receipt) => {
  assert.equal(receipt.schemaVersion, RECEIPT_SCHEMA);
  assert.match(receipt.status, /^(PASS|SKIP|FAIL)$/);
  t.diagnostic(JSON.stringify(receipt));
};

test('Native Smoke: All 7 surfaces resolve into typed native receipts', async (t) => {
  const probes = [];

  for (const surface of SURFACES) {
    let result;
    try {
      result = await resolveApplication(surface);
    } catch (err) {
      const receipt = {
        schemaVersion: RECEIPT_SCHEMA,
        surface,
        status: 'FAIL',
        reason: 'resolver-threw',
        error: err.message,
      };
      probes.push(receipt);
      emitReceipt(t, receipt);
      assert.fail(`resolveApplication threw unexpected error for surface ${surface}: ${err.message}`);
    }

    assert.ok(result && typeof result === 'object');
    if (result.executable) {
      assert.equal(typeof result.executable, 'string');
    } else {
      assert.ok(result.warnings || result.status === 'not_required' || result.executable === null || result.status === 'not_found');
    }

    const receipt = {
      schemaVersion: RECEIPT_SCHEMA,
      surface,
      status: result.executable ? 'PASS' : 'SKIP',
      reason: result.executable ? 'resolved' : (result.status || 'not-installed'),
      executable: result.executable || null,
      resolverStatus: result.status || null,
    };
    probes.push(receipt);
    emitReceipt(t, receipt);
  }

  t.diagnostic(JSON.stringify({
    schemaVersion: RECEIPT_SCHEMA,
    kind: 'surface-resolution-summary',
    platform: process.platform,
    status: 'PASS',
    probes,
  }));
});

test('Native Smoke: Native CLI binaries report version; missing is SKIP and installed failure is FAIL', async (t) => {
  const cliCommands = [
    { name: process.platform === 'win32' ? 'claude.cmd' : 'claude', surface: 'claude_cli' },
    { name: process.platform === 'win32' ? 'codex.cmd' : 'codex', surface: 'codex_cli' },
    { name: process.platform === 'win32' ? 'qwen.cmd' : 'qwen', surface: 'qwen_cli' },
    { name: process.platform === 'win32' ? 'ade.cmd' : 'ade', surface: 'ade_cli' },
  ];

  for (const { name, surface } of cliCommands) {
    const lookup = process.platform === 'win32'
      ? spawnSync('where.exe', [name], { encoding: 'utf8', windowsHide: true })
      : null;
    const lookupUnavailable = Boolean(lookup?.error && lookup.error.code !== 'ENOENT');
    const missing = process.platform === 'win32'
      ? !lookupUnavailable && lookup.status !== 0 && !lookup.stdout?.trim()
      : false;
    const res = missing
      ? { status: null, error: Object.assign(new Error(`${name} is not installed`), { code: 'ENOENT' }), stdout: '', stderr: '' }
      : process.platform === 'win32'
        ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', name, '--version'], { encoding: 'utf8', windowsHide: true })
        : spawnSync(name, ['--version'], { encoding: 'utf8' });
    const providerMissing = missing || res.error?.code === 'ENOENT';
    const output = `${res.stdout || ''}${res.stderr || ''}`.trim();
    const installedFailure = !providerMissing && (Boolean(res.error) || res.status !== 0 || output.length === 0);
    const receipt = {
      schemaVersion: RECEIPT_SCHEMA,
      surface,
      provider: name,
      status: providerMissing ? 'SKIP' : installedFailure ? 'FAIL' : 'PASS',
      reason: providerMissing ? 'provider-not-installed' : installedFailure ? 'version-command-failed' : 'version-command-passed',
      command: `${name} --version`,
      exitCode: res.status ?? null,
      outputPresent: output.length > 0,
    };
    emitReceipt(t, receipt);

    await t.test(name, { skip: providerMissing ? 'SKIPPED_PROVIDER_NOT_INSTALLED' : false }, () => {
      if (providerMissing) return;
      if (res.error) throw res.error;
      assert.equal(res.status, 0, `${name} --version failed: ${res.stderr || res.stdout || res.signal || 'unknown error'}`);
      assert.ok(output.length > 0, `${name} --version returned no output`);
    });
  }
});
