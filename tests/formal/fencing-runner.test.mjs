import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyTlc, fingerprintFiles, assertSourceBinding } from '../../tools/formal/fencing.mjs';

test('TLC needs completed exploration or a named invariant trace; failures stay incomplete', () => {
  const complete = 'Model checking completed. No error has been found.';
  const trace = 'Error: Invariant Safety4A is violated.\nThe behavior up to this point is:';
  assert.equal(classifyTlc({ status: 0, stdout: complete }, ['Safety1']).status, 'PASS');
  assert.deepEqual(classifyTlc({ status: 12, stdout: trace }, ['Safety4A']), { status: 'VIOLATION', violated: 'Safety4A' });
  for (const run of [
    { status: 0, stdout: '' },
    { status: 1, stdout: complete },
    { status: 12, stdout: trace },
    { status: 12, stdout: trace, error: { code: 'ETIMEDOUT' } },
    { status: null, stdout: complete, signal: 'SIGTERM' },
    { status: 255, stdout: 'Parsing failed' },
  ]) assert.equal(classifyTlc(run, ['Safety1']).status, 'INCOMPLETE');
});

test('missing TLC fails the actual CLI and cannot use an old report', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'formal-missing-'));
  try {
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ status: 'EXPECTATIONS_MET' }));
    const cli = fileURLToPath(new URL('../../tools/formal/fencing.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [cli], {
      encoding: 'utf8', env: { ...process.env, TLA2TOOLS_JAR: path.join(dir, 'absent.jar'), FORMAL_FENCING_OUT: dir }, windowsHide: true,
    });
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stderr.trim()).status, 'INCOMPLETE');
    assert.match(JSON.parse(result.stderr.trim()).error, /ENOENT/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('each source/model/config/runner/tool input and observed environment invalidates identity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'formal-inputs-'));
  try {
    const files = Object.fromEntries(['source', 'model', 'config', 'runner', 'tool'].map(name => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, name);
      return [name, file];
    }));
    const config = { property: 'Safety1', maxTime: 242 };
    const environment = { platform: 'fixture', javaVersion: 'fixture-java-1', javaSha256: 'fixture-binary-1' };
    const before = fingerprintFiles(files, config, environment).digest;
    for (const [name, file] of Object.entries(files)) {
      fs.writeFileSync(file, `${name}-changed`);
      assert.notEqual(fingerprintFiles(files, config, environment).digest, before, name);
      fs.writeFileSync(file, name);
    }
    assert.notEqual(fingerprintFiles(files, { ...config, maxTime: 243 }, environment).digest, before);
    assert.notEqual(fingerprintFiles(files, config, { ...environment, javaVersion: 'fixture-java-2' }).digest, before);
    assert.notEqual(fingerprintFiles(files, config, { ...environment, javaSha256: 'fixture-binary-2' }).digest, before);
    fs.unlinkSync(files.model);
    assert.throws(() => fingerprintFiles(files, config, environment), { code: 'ENOENT' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('source correspondence rejects drift until its source review is updated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'formal-correspondence-'));
  try {
    fs.writeFileSync(path.join(dir, 'owner.ts'), 'reviewed');
    const binding = { files: [{ file: 'owner.ts', sha256: crypto.createHash('sha256').update('reviewed').digest('hex') }] };
    assertSourceBinding(dir, binding);
    fs.writeFileSync(path.join(dir, 'owner.ts'), 'unreviewed');
    assert.throws(() => assertSourceBinding(dir, binding), /SOURCE_CORRESPONDENCE_STALE/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
