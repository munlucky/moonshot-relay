// Stable tool manifest (Wave 4.5). Tool definitions sit at the very front of
// the prompt, so a manifest that changes shape between turns invalidates every
// cached segment behind it — including the ones that did not change.
//
// The rule is: the manifest is fixed, permission is dynamic. A tool the current
// role may not call still appears in the manifest with the same bytes; the call
// itself is refused by Route Admission and the tool interceptor. Dropping the
// definition to express "not allowed" would trade a real permission check for a
// guaranteed cache miss.

import { createHash } from 'node:crypto';
import { canonicalJson } from '../../kernel/canonical-digest.mjs';

export const canonicalizeToolSchema = (schema) => {
  if (schema === null || typeof schema !== 'object') return schema ?? null;
  if (Array.isArray(schema)) return schema.map(canonicalizeToolSchema);
  const out = {};
  for (const key of Object.keys(schema).sort()) {
    if (schema[key] === undefined) continue;
    out[key] = canonicalizeToolSchema(schema[key]);
  }
  return out;
};

export const digestToolSchema = (tool) =>
  `sha256:${createHash('sha256').update(canonicalJson({
    name: tool?.name ?? '',
    description: tool?.description ?? '',
    inputSchema: canonicalizeToolSchema(tool?.inputSchema ?? null),
  })).digest('hex')}`;

export const normalizeTool = (tool = {}) => {
  if (!tool.name) throw new Error('a tool manifest entry requires a name');
  return Object.freeze({
    name: String(tool.name),
    description: String(tool.description ?? ''),
    inputSchema: canonicalizeToolSchema(tool.inputSchema ?? null),
    schemaDigest: digestToolSchema(tool),
  });
};

// Sorted by name so two Hosts that assembled the same tools in a different
// order still produce the same prefix.
export const buildToolManifest = (tools = []) => {
  const entries = tools.map(normalizeTool).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const manifestDigest = `sha256:${createHash('sha256').update(canonicalJson(entries.map((t) => [t.name, t.schemaDigest]))).digest('hex')}`;
  return Object.freeze({ schemaVersion: 1, tools: Object.freeze(entries), toolSchemaDigest: manifestDigest });
};

// Permission is reported alongside the manifest instead of being encoded by
// omission, so the Host can still refuse the call without moving any bytes.
export const applyToolPermissions = (manifest, { allowed = null } = {}) => {
  const allowSet = allowed === null ? null : new Set(allowed);
  return Object.freeze({
    ...manifest,
    permissions: Object.freeze(Object.fromEntries(manifest.tools.map((tool) => [tool.name, allowSet === null || allowSet.has(tool.name)]))),
  });
};

export const renderToolManifestSegment = (manifest) =>
  manifest.tools.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n');
