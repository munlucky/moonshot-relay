import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Kernel package manifest includes knowledge schemas, skills, and modules', async () => {
  const manifest = JSON.parse(await readFile('package/kernel/manifest.json', 'utf8'));
  assert.equal(manifest.productId, 'moon-relay-kernel');
  assert.ok(manifest.include.includes('schemas/kernel.*'));
  assert.ok(manifest.include.includes('skills/kernel-*'));
  assert.ok(manifest.exclude.includes('.moonshot-relay'));
});
