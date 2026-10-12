import test from 'node:test';
import assert from 'node:assert/strict';
import { main as kernelMain } from '../src/cli/moon-relay-kernel.js';
import { main as standaloneMain } from '../src/cli/moon-relay-standalone.js';

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
