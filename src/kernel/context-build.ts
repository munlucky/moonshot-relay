import { requiredIndex } from '../shared/required-index.js';
import { createHash } from 'node:crypto';
import { makeContextReceipt } from '../contracts/context-receipt.js';
import {
  redactSecretsInObject,
  sanitizeText,
  wrapUntrustedDataFence,
} from '../shared/context-sanitization.js';
import { KERNEL_POLICY } from './policy.js';

type UnknownRecord = Record<string, unknown>;

interface ContextPolicyLike {
  revision: string;
  stableTokenBudget: number;
  stageTokenBudget: number;
  forbiddenContent: readonly string[];
  sourceDigest: string;
}

interface ContextRecordLike extends UnknownRecord {
  id: string;
  type: string;
  content: unknown;
  revision?: string;
  sourceRef?: string;
  trust?: unknown;
}

interface PrincipleSourceLike {
  revision?: string;
  sourceRef?: string;
  sourceDigest?: string;
}

interface ContextReceiptEntry extends UnknownRecord {
  id: string;
  layer: string;
  revision: string;
  contentDigest: string;
  sourceRef?: string;
  sourceDigest?: string;
  trust?: unknown;
  truncated?: boolean;
}

interface OmittedContextEntry {
  id: string;
  reason: string;
}

interface ContextBlock {
  text: string;
  entries: ContextReceiptEntry[];
}

export interface BuildKernelContextInput {
  stage?: string;
  principles?: unknown[];
  taskContract?: unknown;
  stageRecords?: unknown[];
  references?: unknown[];
  evidence?: unknown[];
  policyRevision?: string | null;
  principleSource?: PrincipleSourceLike | null;
  contextPolicy?: ContextPolicyLike;
}

const forbiddenTypeAliases = new Set([
  'raw-log',
  'runtime-log',
  'knowledge-graph',
  'full-knowledge-graph',
]);

const estimateTokens = (text: unknown): number => (
  Math.ceil(String(text).length / 4)
);

const isRecord = (value: unknown): value is UnknownRecord => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

export class KernelContextRecordError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'KernelContextRecordError';
    this.code = code;
  }
}

const normalizeRecord = (
  record: unknown,
  index: number,
  layer: string,
): ContextRecordLike => {
  if (!isRecord(record)) {
    throw new KernelContextRecordError(
      'kernel_context_record_invalid',
      `${layer}[${index}] must be an object record`,
    );
  }
  if (
    !record.id
    || typeof record.id !== 'string'
    || !record.type
    || typeof record.type !== 'string'
    || record.content === undefined
  ) {
    throw new KernelContextRecordError(
      'kernel_context_record_invalid',
      `${layer}[${index}] requires id, type, and content`,
    );
  }
  if (record.revision !== undefined && typeof record.revision !== 'string') {
    throw new KernelContextRecordError(
      'kernel_context_record_revision_invalid',
      `${layer}[${index}].revision must be a string`,
    );
  }
  if (record.sourceRef !== undefined && typeof record.sourceRef !== 'string') {
    throw new KernelContextRecordError(
      'kernel_context_record_source_invalid',
      `${layer}[${index}].sourceRef must be a string`,
    );
  }
  return record as ContextRecordLike;
};

export const MAX_PROMPT_TOKENS = 600;
export const MAX_CONTEXT_TOKENS = 1800;

export const buildKernelContext = ({
  stage = '',
  principles = [],
  taskContract = null,
  stageRecords = [],
  references = [],
  evidence = [],
  policyRevision = null,
  principleSource = null,
  contextPolicy = KERNEL_POLICY.context as ContextPolicyLike,
}: BuildKernelContextInput = {}) => {
  const effectivePolicyRevision = policyRevision || contextPolicy.revision;
  const included: ContextReceiptEntry[] = [];
  const omitted: OmittedContextEntry[] = [];

  const accept = (record: ContextRecordLike, layer: string): string | null => {
    const forbiddenType = new Set(contextPolicy.forbiddenContent);
    if (
      forbiddenType.has(record.type)
      || forbiddenTypeAliases.has(record.type)
      || /(?:raw|full)[-_ ]?(?:runtime[-_ ]?)?log|transcript|knowledge[-_ ]?graph/i.test(
        record.type,
      )
    ) {
      omitted.push({ id: record.id, reason: 'forbidden-type' });
      return null;
    }

    const rawContent = isRecord(record.content) || Array.isArray(record.content)
      ? JSON.stringify(redactSecretsInObject(record.content))
      : record.content;
    const content = wrapUntrustedDataFence(
      rawContent,
      `untrusted_${layer.replaceAll('-', '_')}`,
    );
    const contentDigest = createHash('sha256').update(content).digest('hex');
    included.push({
      id: record.id,
      layer,
      revision: record.revision || 'unknown',
      contentDigest,
      ...(record.sourceRef ? { sourceRef: record.sourceRef } : {}),
      ...(record.trust ? { trust: record.trust } : {}),
    });
    return content;
  };

  const blocks: ContextBlock[] = [];
  const addBlock = (
    text: string,
    entries: ContextReceiptEntry[] = [],
  ): void => {
    const maxChars = contextPolicy.stableTokenBudget * 4;
    if (estimateTokens(text) <= contextPolicy.stableTokenBudget) {
      blocks.push({ text, entries });
      return;
    }

    const truncatedEntries = entries.map((entry) => ({
      ...entry,
      truncated: true,
    }));
    blocks.push({
      text: `${text.slice(0, maxChars - 24)}\n[TRUNCATED]`,
      entries: truncatedEntries,
    });
  };

  if (principles.length) {
    const sanitizedPrinciples = principles.map((principle) => {
      if (isRecord(principle)) {
        return `- ${sanitizeText(principle.id)}: ${sanitizeText(principle.guidance)} (Reason: ${sanitizeText(principle.rationale)})`;
      }
      return `- ${sanitizeText(principle)}`;
    }).join('\n');
    const principlesDigest = createHash('sha256')
      .update(sanitizedPrinciples)
      .digest('hex');

    addBlock(`## Stable Principles\n${sanitizedPrinciples}`, [{
      id: 'stable-principles',
      layer: 'stable-principles',
      revision: principleSource?.revision || effectivePolicyRevision,
      contentDigest: principlesDigest,
      ...(principleSource?.sourceRef
        ? { sourceRef: principleSource.sourceRef }
        : {}),
      ...(principleSource?.sourceDigest
        ? { sourceDigest: principleSource.sourceDigest }
        : {}),
    }]);
  }

  if (taskContract) {
    const redactedContract = redactSecretsInObject(taskContract);
    const contractJson = sanitizeText(JSON.stringify(redactedContract, null, 2));
    const contractDigest = createHash('sha256')
      .update(contractJson)
      .digest('hex');
    addBlock(`## Task Contract\n${contractJson}`, [{
      id: 'task-contract',
      layer: 'task-contract',
      revision: effectivePolicyRevision,
      contentDigest: contractDigest,
    }]);
  }

  const stageEntries: ContextReceiptEntry[] = [];
  const stageContent = stageRecords
    .map((candidate, index) => {
      const record = normalizeRecord(candidate, index, 'stageRecords');
      const before = included.length;
      const content = accept(record, 'stage-context');
      if (content) stageEntries.push(requiredIndex(included, before));
      return content;
    })
    .filter((value): value is string => Boolean(value));

  if (stageContent.length) {
    addBlock(`## Stage Context\n${stageContent.join('\n\n')}`, stageEntries);
  }

  const referenceEntries: ContextReceiptEntry[] = [];
  const refs = references
    .map((candidate, index) => {
      const record = normalizeRecord(candidate, index, 'references');
      const before = included.length;
      const content = accept(record, 'on-demand-reference');
      if (content) referenceEntries.push(requiredIndex(included, before));
      return content;
    })
    .filter((value): value is string => Boolean(value));

  if (refs.length) {
    addBlock(`## On-demand References\n${refs.join('\n')}`, referenceEntries);
  }

  const evidenceEntries: ContextReceiptEntry[] = [];
  const evidenceContent = evidence
    .map((candidate, index) => {
      const record = normalizeRecord(candidate, index, 'evidence');
      const before = included.length;
      const content = accept(record, 'evidence-digest');
      if (content) evidenceEntries.push(requiredIndex(included, before));
      return content;
    })
    .filter((value): value is string => Boolean(value));

  if (evidenceContent.length) {
    addBlock(
      `## Evidence Digest\n${evidenceContent.join('\n')}`,
      evidenceEntries,
    );
  }

  let promptBlock = blocks.map((block) => block.text).join('\n\n');
  let currentTokens = estimateTokens(promptBlock);

  // Deterministic Truncation Enforcement (KRN-AUD-P1-01).
  if (currentTokens > contextPolicy.stageTokenBudget) {
    while (blocks.length > 2 && currentTokens > contextPolicy.stageTokenBudget) {
      const removedBlock = blocks.pop();
      if (!removedBlock) break;
      omitted.push(
        ...removedBlock.entries.map((entry) => ({
          id: entry.id,
          reason: 'context-budget',
        })),
      );
      promptBlock = blocks.map((block) => block.text).join('\n\n');
      currentTokens = estimateTokens(promptBlock);
    }
  }

  // Even the two authoritative blocks must honor the declared prompt budget.
  if (currentTokens > contextPolicy.stageTokenBudget) {
    const maxChars = contextPolicy.stageTokenBudget * 4;
    promptBlock = `${promptBlock.slice(0, Math.max(0, maxChars - 24))}\n[TRUNCATED]`;
    currentTokens = estimateTokens(promptBlock);
  }

  const retainedIds = new Set(
    blocks.flatMap((block) => block.entries.map((entry) => entry.id)),
  );
  const retainedEntries = blocks.flatMap((block) => block.entries);
  const seenIds = new Set<string>();
  included.splice(
    0,
    included.length,
    ...retainedEntries.filter((entry) => {
      if (!retainedIds.has(entry.id) || seenIds.has(entry.id)) return false;
      seenIds.add(entry.id);
      return true;
    }),
  );

  return {
    promptBlock,
    receipt: makeContextReceipt({
      stage,
      policyRevision: effectivePolicyRevision,
      policyDigest: contextPolicy.sourceDigest,
      included,
      omitted,
      tokenEstimate: currentTokens,
    }),
  };
};

export const buildContextReceipt = async (
  options: BuildKernelContextInput,
) => {
  const result = buildKernelContext(options);
  return { ...result, ...result.receipt };
};
