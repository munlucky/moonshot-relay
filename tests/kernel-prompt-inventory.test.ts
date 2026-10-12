import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const AUDIT = 'artifacts/kernel-prompt-audit';

const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const array = (value: unknown): unknown[] => { assert.ok(Array.isArray(value)); return value; };
const readInventory = async () => {
  const value = object(JSON.parse(await readFile(`${AUDIT}/prompt-inventory.json`, 'utf8')));
  const surfaces = array(value.surfaces).map(entry => {
    const surface = object(entry);
    assert.equal(typeof surface.path, 'string');
    assert.equal(typeof surface.bytes, 'number');
    return { path: String(surface.path), bytes: Number(surface.bytes) };
  });
  return { schemaVersion: value.schemaVersion, surfaces };
};
const readClassification = async () => {
  const value = object(JSON.parse(await readFile(`${AUDIT}/instruction-classification.json`, 'utf8')));
  const classes = object(value.classes);
  return { classes: {
    A_kernel_authority_kept: array(classes.A_kernel_authority_kept).map(entry => {
      const value = object(entry); assert.equal(typeof value.reason, 'string'); return { reason: String(value.reason) };
    }),
    B_common_stable_behavior_consolidated: array(classes.B_common_stable_behavior_consolidated).map(entry => {
      const value = object(entry); assert.equal(typeof value.movedTo, 'string'); return { movedTo: String(value.movedTo) };
    }),
    C_duplicate_legacy_removed: array(classes.C_duplicate_legacy_removed),
  } };
};

test('the prompt audit enumerates every Kernel prompt surface it inspected', async () => {
  const inventory = await readInventory();
  assert.equal(inventory.schemaVersion, 1);
  assert.ok(inventory.surfaces.length >= 8, 'the audit must cover the skill, the Claude agents, the Codex contract, and the provider prompts');
  for (const surface of inventory.surfaces) {
    assert.ok(existsSync(surface.path), `inventoried surface must exist: ${surface.path}`);
    assert.ok(surface.bytes > 0);
  }
  const paths = inventory.surfaces.map((s) => s.path);
  for (const required of [
    'skills/moon-relay-kernel/SKILL.md',
    'scripts/host/kernel/prompts/common-execution.js',
    'scripts/host/kernel/prompts/claude-opus-5.js',
    'scripts/host/kernel/prompts/codex-gpt-5p6.js',
  ]) assert.ok(paths.includes(required), `audit must inventory ${required}`);
});

test('classification keeps Kernel authority and records where common rules now live', async () => {
  const classification = await readClassification();
  const reasons = classification.classes.A_kernel_authority_kept.map((entry) => entry.reason);
  for (const authority of ['Capsule scope enforcement', 'Evidence authority', 'Review receipt independence', 'Completion authority']) {
    assert.ok(reasons.includes(authority), `Kernel authority must be classified as kept: ${authority}`);
  }
  for (const entry of classification.classes.B_common_stable_behavior_consolidated) {
    assert.match(entry.movedTo, /common-execution\.js$/, 'common behavior consolidates into exactly one file');
  }
});

test('the audit records that nothing was removed on suspicion', async () => {
  const classification = await readClassification();
  const report = await readFile(`${AUDIT}/removed-instructions.md`, 'utf8');
  // The investigation found no legacy instruction on a Kernel-loaded surface.
  // A future removal must be listed here with its replacement authority.
  assert.equal(classification.classes.C_duplicate_legacy_removed.length, 0);
  assert.match(report, /nothing was removed/i);
});
