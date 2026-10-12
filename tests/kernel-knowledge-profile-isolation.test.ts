import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Kernel catalog exposes moon-relay-kernel as singular public entrypoint', async () => {
  const catalog = JSON.parse(await readFile('catalog/kernel-skills.json', 'utf8'));
  assert.equal(catalog.publicEntrypoints.length, 1);
  assert.equal(catalog.publicEntrypoints[0].name, 'moon-relay-kernel');
  assert.ok(catalog.internalSkillClusters[0].skills.includes('kernel-commit-closeout'));
});
