import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToolManifest, applyToolPermissions, digestToolSchema, canonicalizeToolSchema } from '../src/host/kernel/tool-manifest.js';

const TOOLS = [
  { name: 'search', description: 'Search the workspace', inputSchema: { type: 'object', properties: { pattern: { type: 'string' } } } },
  { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'edit_file', description: 'Edit a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
];

test('tools are ordered by name regardless of assembly order', () => {
  const forward = buildToolManifest(TOOLS);
  const reversed = buildToolManifest([...TOOLS].reverse());
  assert.deepEqual(forward.tools.map((t) => t.name), ['edit_file', 'read_file', 'search']);
  assert.equal(forward.toolSchemaDigest, reversed.toolSchemaDigest);
});

test('schema key order does not change a tool digest', () => {
  const a = digestToolSchema({ name: 't', description: 'd', inputSchema: { type: 'object', properties: { b: {}, a: {} } } });
  const b = digestToolSchema({ name: 't', description: 'd', inputSchema: { properties: { a: {}, b: {} }, type: 'object' } });
  assert.equal(a, b);
  const canonical = canonicalizeToolSchema({ z: 1, a: 2 });
  assert.ok(canonical && typeof canonical === 'object');
  assert.deepEqual(Object.keys(canonical), ['a', 'z']);
});

test('a changed description changes the manifest digest', () => {
  const before = buildToolManifest(TOOLS);
  const after = buildToolManifest(TOOLS.map((t) => (t.name === 'search' ? { ...t, description: 'Search everything' } : t)));
  assert.notEqual(before.toolSchemaDigest, after.toolSchemaDigest);
});

test('a permission change does not move a single byte of the manifest', () => {
  // Removing a forbidden tool from the array would invalidate every cached
  // segment behind it; permission is reported instead.
  const manifest = buildToolManifest(TOOLS);
  const restricted = applyToolPermissions(manifest, { allowed: ['read_file'] });
  const unrestricted = applyToolPermissions(manifest, { allowed: null });
  assert.equal(restricted.toolSchemaDigest, unrestricted.toolSchemaDigest);
  assert.deepEqual(restricted.tools.map((t) => t.name), unrestricted.tools.map((t) => t.name));
  assert.equal(restricted.permissions.read_file, true);
  assert.equal(restricted.permissions.edit_file, false);
  assert.equal(unrestricted.permissions.edit_file, true);
});

test('a nameless tool is refused rather than silently dropped', () => {
  assert.throws(() => buildToolManifest([{ description: 'anonymous' }]), /requires a name/);
});
