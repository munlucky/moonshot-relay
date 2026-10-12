import crypto from 'node:crypto';

type UnknownRecord = Record<string, unknown>;

export interface KnowledgePromptEntry extends UnknownRecord {
  statement?: string | null;
  title?: string | null;
  severity?: string | null;
  from?: string | null;
  relation?: string | null;
  to?: string | null;
  practiceJson?: unknown;
}

export interface RenderPromptBlockInput {
  stage: string;
  policyAnchors?: KnowledgePromptEntry[];
  semanticFacts?: KnowledgePromptEntry[];
  graphSynopsis?: KnowledgePromptEntry[];
  ontologyConstraints?: KnowledgePromptEntry[];
}

export interface ContextDigestInput {
  projectId?: unknown;
  knowledgeRevision?: unknown;
  stage?: unknown;
  strictness?: unknown;
  promptBlock?: unknown;
}

export function redactSecrets(text: string): string;
export function redactSecrets(text: null | undefined): null | undefined;
export function redactSecrets(text: string | null | undefined): string | null | undefined {
  if (!text || typeof text !== 'string') return text;
  let str = text;
  str = str.replace(
    /(api[_-]?key|secret|token|password|auth_header)\s*[:=]\s*["']?([a-zA-Z0-9_\-.]{16,})["']?/gi,
    '$1: "[REDACTED]"',
  );
  str = str.replace(/\b(sk-[a-zA-Z0-9]{20,})\b/g, '[REDACTED_KEY]');
  str = str.replace(/\b(ghp_[a-zA-Z0-9]{20,})\b/g, '[REDACTED_TOKEN]');
  str = str.replace(
    /\bBearer\s+[a-zA-Z0-9_\-.=]{16,}\b/gi,
    'Bearer [REDACTED_TOKEN]',
  );
  str = str.replace(
    /-----BEGIN (?:RSA|EC|PGP|OPENSSH) PRIVATE KEY-----[\s\S]*?-----END (?:RSA|EC|PGP|OPENSSH) PRIVATE KEY-----/g,
    '[REDACTED_PRIVATE_KEY]',
  );
  str = str.replace(
    /\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g,
    '[REDACTED_JWT]',
  );
  str = str.replace(
    /\b(mongodb|postgres|mysql|redis):\/\/[^\s"']+/gi,
    '$1://[REDACTED_CONNECTION_STRING]',
  );
  return str;
}

export function deepRedact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => deepRedact(item));
  if (typeof value !== 'object') return value;

  const result: UnknownRecord = {};
  for (const [key, nested] of Object.entries(value as UnknownRecord)) {
    result[key] = deepRedact(nested);
  }
  return result;
}

const asRecord = (value: unknown): UnknownRecord | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
);

const stringList = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.map(String).map((item) => item.trim()).filter(Boolean)
    : []
);

const renderProcedureEntry = (entry: KnowledgePromptEntry): string | null => {
  const practice = asRecord(entry.practiceJson);
  if (practice?.kind !== 'procedure') return null;
  const metadata = asRecord(practice.metadata);
  const body = asRecord(practice.body);
  if (!body) return entry.statement || null;

  const sections: string[] = [];
  const title = metadata?.title ? String(metadata.title).trim() : '';
  const summary = entry.statement || (metadata?.summary ? String(metadata.summary).trim() : '');
  if (title) sections.push(`Procedure: ${title}`);
  if (summary) sections.push(summary);

  for (const [label, field] of [
    ['Prerequisites', 'prerequisites'],
    ['Steps', 'steps'],
    ['Verification', 'verification'],
    ['Prohibitions', 'prohibitions'],
  ] as const) {
    const values = stringList(body[field]);
    if (values.length > 0) sections.push(`${label}: ${values.join(' -> ')}`);
  }

  return sections.length > 0 ? sections.join(' | ') : null;
};

export const renderKnowledgePromptEntry = (
  entry: KnowledgePromptEntry,
): string => (
  renderProcedureEntry(entry)
  || entry.statement
  || JSON.stringify(entry)
);

export function renderPromptBlock({
  stage,
  policyAnchors = [],
  semanticFacts = [],
  graphSynopsis = [],
  ontologyConstraints = [],
}: RenderPromptBlockInput): string {
  const lines = [`[Project Knowledge Context - Stage: ${stage}]`];

  if (policyAnchors.length > 0) {
    lines.push('\n### Policy Anchors:');
    for (const anchor of policyAnchors) {
      lines.push(`- ${redactSecrets(
        anchor.statement || anchor.title || JSON.stringify(anchor),
      )}`);
    }
  }

  if (semanticFacts.length > 0) {
    lines.push('\n### Verified Facts:');
    for (const fact of semanticFacts) {
      lines.push(`- ${redactSecrets(renderKnowledgePromptEntry(fact))}`);
    }
  }

  if (ontologyConstraints.length > 0) {
    lines.push('\n### Ontology Constraints:');
    for (const constraint of ontologyConstraints) {
      lines.push(
        `- [${constraint.severity || 'invariant'}] ${redactSecrets(
          renderKnowledgePromptEntry(constraint),
        )}`,
      );
    }
  }

  if (graphSynopsis.length > 0) {
    lines.push('\n### Architectural Relations:');
    for (const relation of graphSynopsis) {
      const fallback = `${String(relation.from || '')} -> ${String(
        relation.relation || '',
      )} -> ${String(relation.to || '')}`;
      lines.push(`- ${redactSecrets(relation.statement || fallback)}`);
    }
  }

  return lines.join('\n');
}

export function computeContextDigest(contextPayload: ContextDigestInput): string {
  const normalized = JSON.stringify({
    projectId: contextPayload.projectId,
    knowledgeRevision: contextPayload.knowledgeRevision,
    stage: contextPayload.stage,
    strictness: contextPayload.strictness,
    promptBlock: contextPayload.promptBlock,
  });
  return crypto.createHash('sha256').update(normalized).digest('hex');
}
