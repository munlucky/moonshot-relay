// Deterministic context segments (Wave 2). The existing context builder emits a
// single `promptBlock`; a provider can only reuse a cached prefix when the bytes
// in front of the change are identical, so the same state must render the same
// bytes no matter which order SQLite handed the rows back or what time it is.
//
// The split is by rate of change, not by topic:
//
//   host-stable     Kernel execution rules and the fixed tool manifest
//   project-stable  global knowledge that outlives a single run
//   run-stable      the task contract, fixed for the whole run
//   volatile        the current step, evidence, and tool results
//
// `composeLegacyPromptBlock` rebuilds the flat block so callers that have not
// moved to segments keep working; the segmentation is additive.

import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-digest.mjs';
import { makeContextReceipt } from './context-receipt.mjs';
import { sanitizeText, redactSecretsInObject } from './context-build.mjs';

export const SEGMENT_KINDS = Object.freeze(['host-stable', 'project-stable', 'run-stable', 'volatile']);

const SEGMENT_TITLE = Object.freeze({
  'host-stable': 'Host Stable',
  'project-stable': 'Project Stable',
  'run-stable': 'Run Stable',
  volatile: 'Volatile',
});

const estimateTokens = (text) => Math.ceil(String(text ?? '').length / 4);

const digestText = (text) => `sha256:${createHash('sha256').update(String(text ?? '')).digest('hex')}`;

// Paths are compared as normalized POSIX strings so a Windows-shaped record and
// a POSIX-shaped record of the same file sort — and digest — identically.
export const normalizeContextPath = (value) =>
  String(value ?? '')
    .replaceAll('\\', '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/$/, '');

const str = (value) => (value === null || value === undefined ? '' : String(value));

// Comparing on a canonical tuple rather than a score keeps ordering total: two
// records that tie on every declared key are genuinely interchangeable.
const byKeys = (keys) => (a, b) => {
  for (const key of keys) {
    const left = str(typeof key === 'function' ? key(a) : a?.[key]);
    const right = str(typeof key === 'function' ? key(b) : b?.[key]);
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
};

// The sort key per record family (§9). Anything not listed falls back to a
// canonical-JSON comparison, which is stable but says nothing about intent.
export const CONTEXT_SORT_KEYS = Object.freeze({
  principles: ['id', 'revision'],
  acceptance: ['id', 'statement'],
  obligations: ['obligationId'],
  paths: [(record) => normalizeContextPath(typeof record === 'string' ? record : record?.path)],
  knowledge: ['type', 'id', 'revision', 'contentDigest'],
  graph: ['from', 'relation', 'to'],
  evidence: ['obligationId', 'evidenceDigest', 'status'],
  tools: ['name', 'schemaDigest'],
});

export const sortContextRecords = (records = [], family = null) => {
  const list = Array.isArray(records) ? [...records] : [];
  const keys = family && CONTEXT_SORT_KEYS[family];
  const comparator = keys ? byKeys(keys) : byKeys([(record) => canonicalJson(record)]);
  // A tie on the declared keys still has to be resolved deterministically, or
  // insertion order would leak into the digest through the sort's stability.
  return list.sort((a, b) => comparator(a, b) || byKeys([(record) => canonicalJson(record)])(a, b));
};

// Fields that describe *when* or *where* a record was observed rather than what
// it says. They are dropped before rendering: a re-read of the same knowledge
// must not invalidate a cached prefix just because `observedAt` moved.
const VOLATILE_RECORD_FIELDS = Object.freeze([
  'observedAt', 'createdAt', 'updatedAt', 'timestamp', 'insertedAt', 'lastSeenAt',
  'rowid', 'rowId', 'seq', 'sequence', 'score', 'relevanceScore', 'workspaceIdentity',
]);

export const canonicalizeRecord = (record) => {
  if (record === null || record === undefined) return null;
  if (typeof record !== 'object') return sanitizeText(record);
  if (Array.isArray(record)) return record.map(canonicalizeRecord);
  const redacted = redactSecretsInObject(record);
  const out = {};
  for (const key of Object.keys(redacted).sort()) {
    if (VOLATILE_RECORD_FIELDS.includes(key)) continue;
    const value = redacted[key];
    if (value === undefined) continue;
    out[key] = typeof value === 'string' ? sanitizeText(value) : canonicalizeRecord(value);
  }
  return out;
};

const bullet = (text) => `- ${sanitizeText(text)}`;

const renderList = (title, items) => (items.length ? [`### ${title}`, ...items, ''] : []);

const statementOf = (record) => {
  if (record === null || record === undefined) return '';
  if (typeof record === 'string') return record;
  return record.statement || record.guidance || record.title || record.content || canonicalJson(canonicalizeRecord(record));
};

const renderHostStable = (payload = {}) => {
  const lines = [];
  const principles = sortContextRecords(payload.principles || [], 'principles');
  lines.push(...renderList('Kernel Principles', principles.map((p) => (typeof p === 'object'
    ? bullet(`${p.id}: ${p.guidance}`)
    : bullet(p)))));
  if (payload.executionPrompt) lines.push(sanitizeText(payload.executionPrompt), '');
  const tools = sortContextRecords(payload.tools || [], 'tools');
  lines.push(...renderList('Tool Manifest', tools.map((t) => bullet(`${t.name} (${t.schemaDigest || 'no-digest'})`))));
  return lines;
};

const renderProjectStable = (payload = {}) => {
  const lines = [];
  const knowledge = (family) => sortContextRecords(payload[family] || [], 'knowledge');
  lines.push(...renderList('Policy Anchors', knowledge('policyAnchors').map((r) => bullet(statementOf(r)))));
  lines.push(...renderList('Architecture Decisions', knowledge('architectureRecords').map((r) => bullet(statementOf(r)))));
  lines.push(...renderList('Ontology Constraints', knowledge('ontologyConstraints').map((r) => bullet(`[${r.severity || 'invariant'}] ${statementOf(r)}`))));
  lines.push(...renderList('Domain Terms', knowledge('domainTerms').map((r) => bullet(statementOf(r)))));
  const graph = sortContextRecords(payload.graphSynopsis || [], 'graph');
  lines.push(...renderList('Architectural Relations', graph.map((r) => bullet(r.statement || `${r.from} -> ${r.relation} -> ${r.to}`))));
  return lines;
};

const renderRunStable = (payload = {}) => {
  const lines = [];
  if (payload.objective) lines.push('### Objective', sanitizeText(payload.objective), '');
  const acceptance = sortContextRecords(
    (payload.acceptance || []).map((item, index) => (typeof item === 'string' ? { id: `AC-${index + 1}`, statement: item } : item)),
    'acceptance',
  );
  lines.push(...renderList('Acceptance', acceptance.map((a) => bullet(`${a.id}: ${a.statement}`))));
  lines.push(...renderList('Constraints', [...(payload.constraints || [])].sort().map(bullet)));
  lines.push(...renderList('Non-goals', [...(payload.nonGoals || [])].sort().map(bullet)));
  const obligations = sortContextRecords(payload.obligations || [], 'obligations');
  lines.push(...renderList('Required Obligations', obligations.map((o) => bullet(`${o.obligationId} (${o.evidenceClass || 'hard'})`))));
  return lines;
};

const renderVolatile = (payload = {}) => {
  const lines = [];
  if (payload.action) lines.push('### Current Action', bullet(`${payload.action.type}: ${payload.action.guidance || ''}`), '');
  if (payload.step) lines.push('### Current Step', bullet(`${payload.step.stepId}: ${payload.step.objective || ''}`), '');
  const paths = (family) => sortContextRecords(payload[family] || [], 'paths').map((p) => normalizeContextPath(typeof p === 'string' ? p : p.path));
  lines.push(...renderList('Allowed Paths', paths('allowedPaths').map(bullet)));
  lines.push(...renderList('Forbidden Paths', paths('forbiddenPaths').map(bullet)));
  const taskKnowledge = sortContextRecords(payload.taskKnowledge || [], 'knowledge');
  lines.push(...renderList('Task Knowledge', taskKnowledge.map((r) => bullet(statementOf(r)))));
  const evidence = sortContextRecords(payload.evidence || [], 'evidence');
  lines.push(...renderList('Evidence', evidence.map((e) => bullet(`${e.obligationId}: ${e.status} (${e.evidenceDigest || 'no-digest'})`))));
  // The outstanding subset shrinks as obligations pass and disappears on a
  // fix action, so it belongs here rather than in Run Stable's declared
  // obligation set.
  const outstandingObligations = sortContextRecords(payload.outstandingObligations || [], 'obligations');
  lines.push(...renderList('Outstanding Obligations', outstandingObligations.map((o) => bullet(`${o.obligationId} (${o.evidenceClass || 'hard'})`))));
  const toolResults = sortContextRecords(payload.toolResults || []);
  // Full tool output belongs in the evidence store; the model gets the summary
  // and the digest that points back at it.
  lines.push(...renderList('Tool Results', toolResults.map((t) => bullet(`${t.name || t.commandRef || 'tool'}: ${t.summary || ''} (${t.digest || 'no-digest'})`))));
  if (payload.failure) lines.push('### Failure', bullet(statementOf(payload.failure)), '');
  return lines;
};

const RENDERERS = Object.freeze({
  'host-stable': renderHostStable,
  'project-stable': renderProjectStable,
  'run-stable': renderRunStable,
  volatile: renderVolatile,
});

export const renderContextSegment = (kind, payload = {}) => {
  const render = RENDERERS[kind];
  if (!render) throw new Error(`Unknown context segment kind: ${kind}`);
  const body = render(payload).join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  return body ? `## ${SEGMENT_TITLE[kind]}\n${body}` : '';
};

export const digestContextSegment = (segment) => digestText(typeof segment === 'string' ? segment : segment?.content);

const makeSegment = (kind, payload) => {
  const content = renderContextSegment(kind, payload);
  return Object.freeze({ kind, content, digest: digestContextSegment(content), tokenEstimate: estimateTokens(content) });
};

// Segment order is the cache order: everything a provider can reuse comes
// before anything that changes this turn.
export const SEGMENT_ORDER = Object.freeze(['hostStable', 'projectStable', 'runStable', 'volatile']);

export const composeLegacyPromptBlock = (segments = {}) =>
  SEGMENT_ORDER.map((name) => segments[name]?.content).filter(Boolean).join('\n\n');

export const buildKernelContextSegments = ({
  stage = 'EXECUTE',
  hostStable = {},
  projectStable = {},
  runStable = {},
  volatile = {},
  policyRevision = 'kernel-context.v1',
  policyDigest = null,
} = {}) => {
  const segments = {
    hostStable: makeSegment('host-stable', hostStable),
    projectStable: makeSegment('project-stable', projectStable),
    runStable: makeSegment('run-stable', runStable),
    volatile: makeSegment('volatile', volatile),
  };
  const promptBlock = composeLegacyPromptBlock(segments);
  const included = SEGMENT_ORDER
    .filter((name) => segments[name].content)
    .map((name) => ({ id: segments[name].kind, layer: 'context-segment', revision: policyRevision, contentDigest: segments[name].digest }));
  return {
    promptBlock,
    segments,
    receipt: makeContextReceipt({
      stage,
      policyRevision,
      policyDigest,
      included,
      omitted: [],
      tokenEstimate: estimateTokens(promptBlock),
    }),
  };
};
