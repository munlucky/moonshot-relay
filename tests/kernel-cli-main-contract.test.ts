import test from 'node:test';
import assert from 'node:assert/strict';
import { main as kernelMain } from '../src/cli/moon-relay-kernel.js';
import { main as standaloneMain } from '../src/cli/moon-relay-standalone.js';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('kernel CLI main(argv, deps) is import-safe and writes help through injected output', async () => {
  const stdout: string[] = [];
  const stderr = [];
  const result = await kernelMain(['--help', '--json'], {
    cwd: process.cwd(),
    env: { ...process.env, MOON_RELAY_KERNEL_REEXEC: '1' },
    stdout: (value) => stdout.push(String(value)),
    stderr: (value) => stderr.push(String(value)),
    managedRuntimeHome: process.cwd(),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stderr.length, 0);
  assert.equal(stdout.length, 1);
  const help = JSON.parse(stdout[0]);
  assert.equal(help.usage, 'kernel <command> [options]');
  assert.ok(help.commands.next);
  assert.ok(help.commands['worker-host']);
  assert.match(help.commands['worker-host'], /--enable-io-writer/);
  assert.match(help.commands['mcp-bridge'], /--enable-io-writer/);
  assert.match(help.commands['worker-host'], /--enable-io-reader/);
  assert.match(help.commands['mcp-bridge'], /--enable-io-reader/);
});

test('CLI startup opt-in reaches local capabilities and the MCP tool schema', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-cli-io-'));
  const runtimeHome = path.join(root, 'runtime');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MOON_RELAY_KERNEL_|^CODEX_THREAD_ID$/.test(key)));
  env.MOON_RELAY_KERNEL_REEXEC = '1';
  try {
    await mkdir(path.join(root, '.moon-relay'));
    await mkdir(runtimeHome);
    await writeFile(path.join(root, '.moon-relay', 'track.yaml'), 'track: kernel\n');
    for (const command of ['worker-host', 'mcp-bridge']) for (const flags of [[], ['--enable-io-writer'], ['--enable-io-reader']]) {
      const request = command === 'worker-host' ? { id: 1, action: 'capabilities' }
        : { jsonrpc: '2.0', id: 1, method: 'tools/list' };
      const child = spawnSync(process.execPath, [path.resolve('bin/moon-relay-kernel.mjs'), command,
        '--project-root', root, '--runtime-home', runtimeHome, ...flags], {
        env, input: JSON.stringify(request) + '\n', encoding: 'utf8', timeout: 15000,
      });
      assert.equal(child.status, 0, child.stderr || child.stdout);
      const response = JSON.parse(child.stdout.trim());
      if (command === 'worker-host') {
        assert.equal(response.ioWriter.available, flags.includes('--enable-io-writer'));
        assert.equal(response.ioReader.available, flags.includes('--enable-io-reader'));
        assert.equal(response.writableStart, false);
      } else {
        const attach = response.result.tools.find((tool: { name: string }) => tool.name === 'kernel_attach');
        assert.equal(Object.hasOwn(attach.inputSchema.properties, 'ioWrite'), flags.includes('--enable-io-writer'));
        assert.equal(Object.hasOwn(attach.inputSchema.properties, 'ioRead'), flags.includes('--enable-io-reader'));
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('standalone CLI main(argv, deps) reports unknown utilities without process exit side effects', async () => {
  const outputs: unknown[] = [];
  const result = await standaloneMain(['--utility', 'missing-utility', '--json'], {
    cwd: process.cwd(),
    env: process.env,
    runtimeRoot: process.cwd(),
    invokedPath: 'moon-relay-standalone.mjs',
    output: (value) => outputs.push(value),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(outputs.length, 1);
  const output = outputs[0];
  assert.ok(output && typeof output === 'object' && 'status' in output && 'errorCode' in output);
  assert.equal(output.status, 'error');
  assert.equal(output.errorCode, 'UNKNOWN_STANDALONE');
});
