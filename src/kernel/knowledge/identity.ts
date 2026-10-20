import { createHash } from 'node:crypto';

type UnknownRecord = Record<string, unknown>;

export interface KnowledgeIdentityInput {
  recordType?: unknown;
  proposedType?: unknown;
  type?: unknown;
  statement?: unknown;
  scope?: unknown;
  practiceJson?: unknown;
  verification?: unknown;
  obligation?: unknown;
  obligationId?: unknown;
  obligationIds?: unknown;
}

const isRecord = (value: unknown): value is UnknownRecord => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const text = (value: unknown): string => (
  value === null || value === undefined ? '' : String(value).trim()
);

const list = (value: unknown): string[] => (
  Array.isArray(value) ? value : value ? [value] : []
).map(text).filter(Boolean);

const normalizedText = (value: unknown): string => (
  text(value).toLowerCase().replace(/\s+/g, ' ')
);

const normalizedList = (
  value: unknown,
  {
    sort = false,
    deduplicate = false,
  }: { sort?: boolean; deduplicate?: boolean } = {},
): string[] => {
  const values = list(value).map(normalizedText);
  const normalized = deduplicate ? [...new Set(values)] : values;
  return sort ? normalized.sort() : normalized;
};

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stable(value[key])}`
  )).join(',')}}`;
};

const digest = (value: unknown): string => `sha256:${createHash('sha256')
  .update(typeof value === 'string' ? value : stable(value))
  .digest('hex')}`;

export const canonicalKnowledgeType = (type: unknown): string => {
  const normalized = text(type).toLowerCase().replace(/[- ]/g, '_');
  if (normalized === 'policy' || normalized === 'policy_anchor') return 'policy_anchor';
  if (normalized === 'semantic' || normalized === 'semantic_fact') return 'semantic_fact';
  if (normalized === 'architecture' || normalized === 'architecture_record') return 'architecture_record';
  if (normalized === 'decision' || normalized === 'architecture_decision') return 'architecture_decision';
  if (normalized === 'observation' || normalized === 'episodic_observation') return 'episodic_observation';
  if (normalized === 'kg_relation' || normalized === 'relation') return 'kg_relation';
  if (normalized === 'constraint' || normalized === 'ontology_constraint') return 'ontology_constraint';
  return normalized || 'semantic_fact';
};

const procedureIdentity = (practiceJson: unknown): UnknownRecord | null => {
  if (!isRecord(practiceJson) || practiceJson.kind !== 'procedure') return null;
  const metadata = isRecord(practiceJson.metadata) ? practiceJson.metadata : {};
  const body = isRecord(practiceJson.body) ? practiceJson.body : {};
  return {
    title: normalizedText(metadata.title),
    summary: normalizedText(metadata.summary),
    prerequisites: normalizedList(body.prerequisites),
    steps: normalizedList(body.steps),
    verification: normalizedList(body.verification),
    prohibitions: normalizedList(body.prohibitions),
  };
};

const requiredVerificationIdentity = (
  verificationValue: unknown,
  input: KnowledgeIdentityInput,
): UnknownRecord => {
  const verification = isRecord(verificationValue) ? verificationValue : {};
  return {
    commandRefs: normalizedList([
      ...list(verification.commandRefs),
      ...list(verification.commandRef),
    ], { sort: true, deduplicate: true }),
    method: normalizedText(verification.method),
    evidenceLevel: normalizedText(verification.evidenceLevel),
    receiptContractRef: normalizedText(verification.receiptContractRef),
    freshnessInputs: normalizedList(verification.freshnessInputs, { sort: true, deduplicate: true }),
    verificationScope: normalizedList(verification.scope, { sort: true, deduplicate: true }),
    obligations: normalizedList([
      ...list(input.obligation),
      ...list(input.obligationId),
      ...list(input.obligationIds),
      ...list(verification.obligation),
      ...list(verification.obligationId),
      ...list(verification.obligationIds),
    ], { sort: true, deduplicate: true }),
  };
};

/**
 * Canonical Knowledge identity shared by capture, persistence, and context
 * selection. Base records preserve the existing type/statement/scope identity.
 * Structured procedure and required-verification records add only the semantic
 * fields needed to avoid collapsing distinct executable knowledge.
 */
export const canonicalKnowledgeIdentity = ({
  recordType,
  proposedType,
  type,
  statement,
  scope = [],
  practiceJson = null,
  verification = null,
  obligation = null,
  obligationId = null,
  obligationIds = null,
}: KnowledgeIdentityInput = {}): string => {
  const normType = canonicalKnowledgeType(recordType || proposedType || type);
  const base = {
    type: normType,
    statement: normalizedText(statement),
    scope: normalizedList(scope, { sort: true }),
  };

  const procedure = procedureIdentity(practiceJson);
  const requiredVerification = normType === 'required_verification'
    ? requiredVerificationIdentity(verification, {
        obligation,
        obligationId,
        obligationIds,
      })
    : null;

  if (!procedure && !requiredVerification) return digest(base);

  return digest({
    ...base,
    ...(procedure ? { procedure } : {}),
    ...(requiredVerification ? { requiredVerification } : {}),
  });
};
