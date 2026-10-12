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
import { canonicalJson } from '../../shared/canonical-digest.js';
import { makeContextReceipt } from '../../contracts/context-receipt.js';
import { sanitizeText, redactSecretsInObject } from '../../shared/context-sanitization.js';

type UnknownRecord = Record<string, unknown>;
type SegmentKind = 'host-stable' | 'project-stable' | 'run-stable' | 'volatile';
type SegmentName = 'hostStable' | 'projectStable' | 'runStable' | 'volatile';
type ContextSortKey = string | ((record: unknown) => unknown);

interface ContextSegment {
  kind: SegmentKind;
  content: string;
  digest: string;
  tokenEstimate: number;
}

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);

const asArray = (value: unknown): unknown[] => (
  Array.isArray(value) ? value : []
);

export const SEGMENT_KINDS = Object.freeze(['host-stable', 'project-stable', 'run-stable', 'volatile'] as const);

const SEGMENT_TITLE = Object.freeze({
  'host-stable': 'Host Stable',
  'project-stable': 'Project Stable',
  'run-stable': 'Run Stable',
  volatile: 'Volatile',
});

const estimateTokens = (text: unknown): number => Math.ceil(String(text ?? '').length / 4);

const digestText = (text: unknown): string => `sha256:${createHash('sha256').update(String(text ?? '')).digest('hex')}`;

// Paths are compared as normalized POSIX strings so a Windows-shaped record and
// a POSIX-shaped record of the same file sort — and digest — identically.
export const normalizeContextPath = (value: unknown): string =>
  String(value ?? '')
    .replaceAll('\\', '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/$/, '');

const str = (value: unknown): string => (
  value === null || value === undefined ? '' : String(value)
);

// Comparing on a canonical tuple rather than a score keeps ordering total: two
// records that tie on every declared key are genuinely interchangeable.
const byKeys = (keys: readonly ContextSortKey[]) => (a: unknown, b: unknown): number => {
  const leftRecord = asRecord(a);
  const rightRecord = asRecord(b);
  for (const key of keys) {
    const left = str(typeof key === 'function' ? key(a) : leftRecord[key]);
    const right = str(typeof key === 'function' ? key(b) : rightRecord[key]);
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
  paths: [
    (record: unknown) => {
      if (typeof record === 'string') return normalizeContextPath(record);
      return normalizeContextPath(asRecord(record).path);
    },
  ],
  knowledge: ['type', 'id', 'revision', 'contentDigest'],
  graph: ['from', 'relation', 'to'],
  evidence: ['obligationId', 'evidenceDigest', 'status'],
  tools: ['name', 'schemaDigest'],
} satisfies Record<string, readonly ContextSortKey[]>);

type ContextSortFamily = keyof typeof CONTEXT_SORT_KEYS;

export function sortContextRecords<RecordType>(records: readonly RecordType[], family?: ContextSortFamily | null): RecordType[];
export function sortContextRecords(records?: unknown, family?: ContextSortFamily | null): unknown[];
export function sortContextRecords(
  records: unknown = [],
  family: ContextSortFamily | null = null,
): unknown[] {
  const list = Array.isArray(records) ? [...records] : [];
  const keys = family ? CONTEXT_SORT_KEYS[family] : null;
  const canonical = byKeys([(record: unknown) => canonicalJson(record)]);
  const comparator = keys ? byKeys(keys) : canonical;
  // A tie on the declared keys still has to be resolved deterministically, or
  // insertion order would leak into the digest through the sort's stability.
  return list.sort((a, b) => comparator(a, b) || canonical(a, b));
}

// Fields that describe *when* or *where* a record was observed rather than what
// it says. They are dropped before rendering: a re-read of the same knowledge
// must not invalidate a cached prefix just because `observedAt` moved.
const VOLATILE_RECORD_FIELDS = Object.freeze([
  'observedAt', 'createdAt', 'updatedAt', 'timestamp', 'insertedAt', 'lastSeenAt',
  'rowid', 'rowId', 'seq', 'sequence', 'score', 'relevanceScore', 'workspaceIdentity',
]);

export const canonicalizeRecord = (record: unknown): unknown => {
  if (record === null || record === undefined) return null;
  if (typeof record !== 'object') return sanitizeText(record);
  if (Array.isArray(record)) return record.map(canonicalizeRecord);
  const redacted = asRecord(redactSecretsInObject(record));
  const out: UnknownRecord = {};
  for (const key of Object.keys(redacted).sort()) {
    if (VOLATILE_RECORD_FIELDS.includes(key)) continue;
    const value = redacted[key];
    if (value === undefined) continue;
    out[key] = typeof value === 'string' ? sanitizeText(value) : canonicalizeRecord(value);
  }
  return out;
};

const bullet = (text: unknown): string => `- ${sanitizeText(text)}`;

const renderList = (title: string, items: string[]): string[] => (
  items.length ? [`### ${title}`, ...items, ''] : []
);

const statementOf = (record: unknown): string => {
  if (record === null || record === undefined) return '';
  if (typeof record === 'string') return record;
  const value = asRecord(record);
  return str(
    value.statement
    || value.guidance
    || value.title
    || value.content
    || canonicalJson(canonicalizeRecord(record)),
  );
};

const renderHostStable = (payload: UnknownRecord = {}): string[] => {
  const lines: string[] = [];
  const principles = sortContextRecords(payload.principles, 'principles');
  lines.push(...renderList(
    'Kernel Principles',
    principles.map((principle) => {
      if (!principle || typeof principle !== 'object' || Array.isArray(principle)) {
        return bullet(principle);
      }
      const record = asRecord(principle);
      return bullet(`${str(record.id)}: ${str(record.guidance)}`);
    }),
  ));
  if (payload.executionPrompt) lines.push(sanitizeText(payload.executionPrompt), '');
  const tools = sortContextRecords(payload.tools, 'tools');
  lines.push(...renderList(
    'Tool Manifest',
    tools.map((tool) => {
      const record = asRecord(tool);
      return bullet(`${str(record.name)} (${str(record.schemaDigest) || 'no-digest'})`);
    }),
  ));
  return lines;
};

const renderProjectStable = (payload: UnknownRecord = {}): string[] => {
  const lines: string[] = [];
  const knowledge = (family: string): unknown[] => sortContextRecords(payload[family], 'knowledge');
  lines.push(...renderList('Policy Anchors', knowledge('policyAnchors').map((record) => bullet(statementOf(record)))));
  lines.push(...renderList('Architecture Decisions', knowledge('architectureRecords').map((record) => bullet(statementOf(record)))));
  lines.push(...renderList(
    'Ontology Constraints',
    knowledge('ontologyConstraints').map((record) => {
      const value = asRecord(record);
      return bullet(`[${str(value.severity) || 'invariant'}] ${statementOf(record)}`);
    }),
  ));
  lines.push(...renderList('Domain Terms', knowledge('domainTerms').map((record) => bullet(statementOf(record)))));
  const graph = sortContextRecords(payload.graphSynopsis, 'graph');
  lines.push(...renderList(
    'Architectural Relations',
    graph.map((record) => {
      const value = asRecord(record);
      return bullet(
        value.statement
        || `${str(value.from)} -> ${str(value.relation)} -> ${str(value.to)}`,
      );
    }),
  ));
  return lines;
};

const renderRunStable = (payload: UnknownRecord = {}): string[] => {
  const lines: string[] = [];
  if (payload.objective) lines.push('### Objective', sanitizeText(payload.objective), '');
  const acceptance = sortContextRecords(
    asArray(payload.acceptance).map((item, index) => (
      typeof item === 'string'
        ? { id: `AC-${index + 1}`, statement: item }
        : item
    )),
    'acceptance',
  );
  lines.push(...renderList(
    'Acceptance',
    acceptance.map((item) => {
      const record = asRecord(item);
      return bullet(`${str(record.id)}: ${str(record.statement)}`);
    }),
  ));
  lines.push(...renderList(
    'Constraints',
    asArray(payload.constraints).map(str).sort().map(bullet),
  ));
  lines.push(...renderList(
    'Non-goals',
    asArray(payload.nonGoals).map(str).sort().map(bullet),
  ));
  const obligations = sortContextRecords(payload.obligations, 'obligations');
  lines.push(...renderList(
    'Required Obligations',
    obligations.map((item) => {
      const record = asRecord(item);
      return bullet(`${str(record.obligationId)} (${str(record.evidenceClass) || 'hard'})`);
    }),
  ));
  return lines;
};

const renderVolatile = (payload: UnknownRecord = {}): string[] => {
  const lines: string[] = [];
  if (payload.action) {
    const action = asRecord(payload.action);
    lines.push(
      '### Current Action',
      bullet(`${str(action.type)}: ${str(action.guidance)}`),
      '',
    );
  }
  if (payload.step) {
    const step = asRecord(payload.step);
    lines.push(
      '### Current Step',
      bullet(`${str(step.stepId)}: ${str(step.objective)}`),
      '',
    );
  }

  const paths = (family: string): string[] => sortContextRecords(
    payload[family],
    'paths',
  ).map((item) => (
    normalizeContextPath(
      typeof item === 'string'
        ? item
        : asRecord(item).path,
    )
  ));

  lines.push(...renderList('Allowed Paths', paths('allowedPaths').map(bullet)));
  lines.push(...renderList('Forbidden Paths', paths('forbiddenPaths').map(bullet)));

  const taskKnowledge = sortContextRecords(payload.taskKnowledge, 'knowledge');
  lines.push(...renderList(
    'Task Knowledge',
    taskKnowledge.map((record) => bullet(statementOf(record))),
  ));

  const evidence = sortContextRecords(payload.evidence, 'evidence');
  lines.push(...renderList(
    'Evidence',
    evidence.map((item) => {
      const record = asRecord(item);
      return bullet(
        `${str(record.obligationId)}: ${str(record.status)} (${str(record.evidenceDigest) || 'no-digest'})`,
      );
    }),
  ));

  // The outstanding subset shrinks as obligations pass and disappears on a
  // fix action, so it belongs here rather than in Run Stable's declared
  // obligation set.
  const outstandingObligations = sortContextRecords(
    payload.outstandingObligations,
    'obligations',
  );
  lines.push(...renderList(
    'Outstanding Obligations',
    outstandingObligations.map((item) => {
      const record = asRecord(item);
      return bullet(
        `${str(record.obligationId)} (${str(record.evidenceClass) || 'hard'})`,
      );
    }),
  ));

  const toolResults = sortContextRecords(payload.toolResults);
  // Full tool output belongs in the evidence store; the model gets the summary
  // and the digest that points back at it.
  lines.push(...renderList(
    'Tool Results',
    toolResults.map((item) => {
      const record = asRecord(item);
      return bullet(
        `${str(record.name || record.commandRef) || 'tool'}: ${str(record.summary)} (${str(record.digest) || 'no-digest'})`,
      );
    }),
  ));

  if (payload.failure) {
    lines.push('### Failure', bullet(statementOf(payload.failure)), '');
  }
  return lines;
};

const RENDERERS: Readonly<Record<SegmentKind, (payload: UnknownRecord) => string[]>> = Object.freeze({
  'host-stable': renderHostStable,
  'project-stable': renderProjectStable,
  'run-stable': renderRunStable,
  volatile: renderVolatile,
});

export const renderContextSegment = (
  kind: SegmentKind,
  payload: UnknownRecord = {},
): string => {
  const render = RENDERERS[kind];
  if (!render) throw new Error(`Unknown context segment kind: ${kind}`);
  const body = render(payload).join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  return body ? `## ${SEGMENT_TITLE[kind]}\n${body}` : '';
};

export const digestContextSegment = (
  segment: string | { content?: unknown },
): string => digestText(
  typeof segment === 'string' ? segment : segment.content,
);

const makeSegment = (
  kind: SegmentKind,
  payload: UnknownRecord,
): Readonly<ContextSegment> => {
  const content = renderContextSegment(kind, payload);
  return Object.freeze({
    kind,
    content,
    digest: digestContextSegment(content),
    tokenEstimate: estimateTokens(content),
  });
};

// Segment order is the cache order: everything a provider can reuse comes
// before anything that changes this turn.
export const SEGMENT_ORDER = Object.freeze([
  'hostStable',
  'projectStable',
  'runStable',
  'volatile',
] as const);

export const composeLegacyPromptBlock = (
  segments: Partial<Record<SegmentName, ContextSegment>> = {},
): string => (
  SEGMENT_ORDER
    .map((name) => segments[name]?.content)
    .filter(Boolean)
    .join('\n\n')
);

export const buildKernelContextSegments = ({
  stage = 'EXECUTE',
  hostStable = {},
  projectStable = {},
  runStable = {},
  volatile = {},
  policyRevision = 'kernel-context.v1',
  policyDigest = null,
}: {
  stage?: unknown;
  hostStable?: UnknownRecord;
  projectStable?: UnknownRecord;
  runStable?: UnknownRecord;
  volatile?: UnknownRecord;
  policyRevision?: string;
  policyDigest?: unknown;
} = {}) => {
  const segments: Record<SegmentName, Readonly<ContextSegment>> = {
    hostStable: makeSegment('host-stable', hostStable),
    projectStable: makeSegment('project-stable', projectStable),
    runStable: makeSegment('run-stable', runStable),
    volatile: makeSegment('volatile', volatile),
  };
  const promptBlock = composeLegacyPromptBlock(segments);
  const included = SEGMENT_ORDER
    .filter((name) => Boolean(segments[name].content))
    .map((name) => ({
      id: segments[name].kind,
      layer: 'context-segment',
      revision: policyRevision,
      contentDigest: segments[name].digest,
    }));
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
