import { matchCapture } from '../shared/match-capture.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolveRuntimeRoot } from '../shared/runtime-assets.js';

type ScalarOrList = string | string[];
type StringMap = Record<string, string>;
type StringListMap = Record<string, string[]>;
type NestedPolicyMap = Record<string, Record<string, ScalarOrList>>;

export interface KernelPrinciple {
  id: string;
  guidance: string;
  rationale: string;
  revision: string;
}

export interface KernelPrinciplesDocument {
  schemaVersion: 1;
  revision: string;
  sourceRef: string;
  sourceDigest: string;
  principles: readonly Readonly<KernelPrinciple>[];
}

export interface ContextPolicy {
  schemaVersion: 1;
  revision: string;
  stableTokenBudget: number;
  stageTokenBudget: number;
  layers: readonly string[];
  forbiddenContent: readonly string[];
  receiptRequired: true;
  sourceRef: string;
  sourceDigest: string;
}

interface ParsePrinciplesOptions {
  sourceRef?: string;
}

interface LoadPrinciplesOptions {
  sourceRoot?: string;
  text?: string;
}

interface ParseContextPolicyOptions {
  sourceRef?: string;
}

interface LoadContextPolicyOptions {
  sourceRoot?: string;
  text?: string;
}

const sourceRoot = resolveRuntimeRoot(import.meta.url);

const readPolicy = (name: string): string => (
  readFileSync(path.join(sourceRoot, 'kernel', name), 'utf8')
);

export const KERNEL_PRINCIPLES_SOURCE = 'kernel/principles.yaml';

export class KernelPrinciplesError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'KernelPrinciplesError';
    this.code = code;
  }
}

const unquote = (value: string): string => (
  value.trim().replace(
    /^(?:"([\s\S]*)"|'([\s\S]*)')$/,
    (_match: string, doubleQuoted: string | undefined, singleQuoted: string | undefined) => (
      doubleQuoted ?? singleQuoted ?? ''
    ),
  )
);

export const parseKernelPrinciplesText = (
  text: unknown,
  { sourceRef = KERNEL_PRINCIPLES_SOURCE }: ParsePrinciplesOptions = {},
): Readonly<KernelPrinciplesDocument> => {
  const raw = String(text ?? '');
  const lines = raw.split(/\r?\n/);
  let schemaVersion: number | undefined;
  let revision: string | undefined;
  let inPrinciples = false;
  let current: Partial<KernelPrinciple> | null = null;
  const principles: Partial<KernelPrinciple>[] = [];

  const flush = (): void => {
    if (current) principles.push(current);
    current = null;
  };

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const top = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (top) {
      flush();
      if (!new Set(['schemaVersion', 'revision', 'principles']).has(matchCapture(top, 1))) {
        throw new KernelPrinciplesError(
          'kernel_principles_malformed',
          `Unknown field in ${sourceRef}: ${matchCapture(top, 1)}`,
        );
      }
      inPrinciples = matchCapture(top, 1) === 'principles';
      if (matchCapture(top, 1) === 'schemaVersion') schemaVersion = Number(matchCapture(top, 2));
      if (matchCapture(top, 1) === 'revision') revision = unquote(matchCapture(top, 2));
      continue;
    }

    if (inPrinciples) {
      const item = line.match(/^\s{2}-\s+id:\s*(.+)$/);
      if (item) {
        flush();
        current = { id: unquote(matchCapture(item, 1)) };
        continue;
      }

      const field = line.match(/^\s{4}(guidance|rationale|revision):\s*(.+)$/);
      if (field && current) {
        const fieldName = matchCapture(field, 1) as 'guidance' | 'rationale' | 'revision';
        current[fieldName] = unquote(matchCapture(field, 2));
        continue;
      }

      throw new KernelPrinciplesError(
        'kernel_principles_malformed',
        `Malformed ${sourceRef}: ${line.trim()}`,
      );
    }

    throw new KernelPrinciplesError(
      'kernel_principles_malformed',
      `Unexpected content in ${sourceRef}: ${line.trim()}`,
    );
  }

  flush();

  if (schemaVersion !== 1) {
    throw new KernelPrinciplesError(
      'kernel_principles_schema_invalid',
      `${sourceRef} schemaVersion must be 1`,
    );
  }
  if (!revision) {
    throw new KernelPrinciplesError(
      'kernel_principles_revision_missing',
      `${sourceRef} revision is required`,
    );
  }
  if (!principles.length) {
    throw new KernelPrinciplesError(
      'kernel_principles_empty',
      `${sourceRef} must contain at least one principle`,
    );
  }

  const ids = new Set<string>();
  const normalized: KernelPrinciple[] = [];
  for (const principle of principles) {
    if (
      !principle.id
      || !principle.guidance
      || !principle.rationale
      || !principle.revision
    ) {
      throw new KernelPrinciplesError(
        'kernel_principles_record_invalid',
        `${sourceRef} records require id, guidance, rationale, and revision`,
      );
    }
    if (ids.has(principle.id)) {
      throw new KernelPrinciplesError(
        'kernel_principles_duplicate_id',
        `Duplicate principle id: ${principle.id}`,
      );
    }
    ids.add(principle.id);
    normalized.push({
      id: principle.id,
      guidance: principle.guidance,
      rationale: principle.rationale,
      revision: principle.revision,
    });
  }

  return Object.freeze({
    schemaVersion: 1,
    revision,
    sourceRef,
    sourceDigest: createHash('sha256').update(raw).digest('hex'),
    principles: Object.freeze(
      normalized.map((principle) => Object.freeze(principle)),
    ),
  });
};

export const loadKernelPrinciples = ({
  sourceRoot: root = sourceRoot,
  text,
}: LoadPrinciplesOptions = {}): Readonly<KernelPrinciplesDocument> => {
  const sourceRef = KERNEL_PRINCIPLES_SOURCE;
  const raw = text ?? readFileSync(path.join(root, sourceRef), 'utf8');
  return parseKernelPrinciplesText(raw, { sourceRef });
};

const parseMap = (text: string, section: string): StringMap => {
  const start = text.indexOf(`${section}:`);
  if (start < 0) return {};

  const result: StringMap = {};
  for (const line of text.slice(start).split(/\r?\n/).slice(1)) {
    if (/^\S/.test(line) && line.trim()) break;
    const match = line.match(/^\s{2}([A-Za-z0-9_-]+):\s*(.+)$/);
    if (match) result[matchCapture(match, 1)] = matchCapture(match, 2).trim();
  }
  return result;
};

const parseListMap = (text: string, section: string): StringListMap => {
  const map = parseMap(text, section);
  return Object.fromEntries(
    Object.entries(map).map(([key, value]) => [
      key,
      value
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ]),
  );
};

const parseScalarOrList = (value: string): ScalarOrList => (
  /^\[.*\]$/.test(value)
    ? value
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    : value
);

// Two-level map: section -> key -> field.
const parseNestedMap = (text: string, section: string): NestedPolicyMap => {
  const start = text.indexOf(`${section}:`);
  if (start < 0) return {};

  const result: NestedPolicyMap = {};
  let currentKey: string | null = null;

  for (const line of text.slice(start).split(/\r?\n/).slice(1)) {
    if (/^\S/.test(line) && line.trim()) break;
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const key = line.match(/^\s{2}([A-Za-z0-9_-]+):\s*$/);
    if (key) {
      currentKey = matchCapture(key, 1);
      result[currentKey] = {};
      continue;
    }

    const field = line.match(/^\s{4}([A-Za-z0-9_-]+):\s*(.+)$/);
    if (field && currentKey) {
      (result[currentKey] ??= {})[matchCapture(field, 1)] = parseScalarOrList(matchCapture(field, 2).trim());
    }
  }

  return result;
};

const proofPolicy = readPolicy('proof-policy.yaml');
const evidencePolicy = readPolicy('evidence-policy.yaml');

const toSurface = (key: string): string => (
  key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`)
);

export const parseContextPolicyText = (
  text: unknown,
  { sourceRef = 'kernel/context-policy.yaml' }: ParseContextPolicyOptions = {},
): Readonly<ContextPolicy> => {
  const raw = String(text ?? '');
  const scalars: StringMap = {};
  const forbiddenContent: string[] = [];
  const layers: string[] = [];
  let inForbidden = false;
  let inLayers = false;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const top = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (top) {
      if (!new Set([
        'schemaVersion',
        'revision',
        'layers',
        'forbiddenContent',
        'receiptRequired',
        'stableTokenBudget',
        'stageTokenBudget',
      ]).has(matchCapture(top, 1))) {
        throw new KernelPrinciplesError(
          'kernel_context_policy_malformed',
          `Unknown field in ${sourceRef}: ${matchCapture(top, 1)}`,
        );
      }

      inForbidden = matchCapture(top, 1) === 'forbiddenContent';
      inLayers = matchCapture(top, 1) === 'layers';
      if (inForbidden || inLayers) continue;
      scalars[matchCapture(top, 1)] = unquote(matchCapture(top, 2));
      continue;
    }

    const item = line.match(/^\s{2}-\s*(.+)$/);
    if (item && inForbidden) {
      forbiddenContent.push(unquote(matchCapture(item, 1)));
      continue;
    }
    if (item && inLayers) {
      layers.push(unquote(matchCapture(item, 1)));
      continue;
    }

    throw new KernelPrinciplesError(
      'kernel_context_policy_malformed',
      `Malformed ${sourceRef}: ${line.trim()}`,
    );
  }

  if (Number(scalars.schemaVersion) !== 1) {
    throw new KernelPrinciplesError(
      'kernel_context_policy_schema_invalid',
      `${sourceRef} schemaVersion must be 1`,
    );
  }
  if (!scalars.revision) {
    throw new KernelPrinciplesError(
      'kernel_context_policy_revision_missing',
      `${sourceRef} revision is required`,
    );
  }

  const stableTokenBudget = Number(scalars.stableTokenBudget);
  const stageTokenBudget = Number(scalars.stageTokenBudget);

  if (!Number.isInteger(stableTokenBudget) || stableTokenBudget <= 0) {
    throw new KernelPrinciplesError(
      'kernel_context_policy_budget_invalid',
      `${sourceRef} stableTokenBudget must be a positive integer`,
    );
  }
  if (
    !Number.isInteger(stageTokenBudget)
    || stageTokenBudget < stableTokenBudget
  ) {
    throw new KernelPrinciplesError(
      'kernel_context_policy_budget_invalid',
      `${sourceRef} stageTokenBudget must be an integer >= stableTokenBudget`,
    );
  }
  if (scalars.receiptRequired !== 'true') {
    throw new KernelPrinciplesError(
      'kernel_context_policy_receipt_required',
      `${sourceRef} receiptRequired must be true`,
    );
  }
  if (!layers.length) {
    throw new KernelPrinciplesError(
      'kernel_context_policy_layers_empty',
      `${sourceRef} layers must not be empty`,
    );
  }
  if (!forbiddenContent.length) {
    throw new KernelPrinciplesError(
      'kernel_context_policy_forbidden_empty',
      `${sourceRef} forbiddenContent must not be empty`,
    );
  }

  return Object.freeze({
    schemaVersion: 1,
    revision: scalars.revision || 'kernel-context-policy.v1',
    stableTokenBudget,
    stageTokenBudget,
    layers: Object.freeze(layers),
    forbiddenContent: Object.freeze(forbiddenContent),
    receiptRequired: true,
    sourceRef,
    sourceDigest: createHash('sha256').update(raw).digest('hex'),
  });
};

export const loadContextPolicy = ({
  sourceRoot: root = sourceRoot,
  text,
}: LoadContextPolicyOptions = {}): Readonly<ContextPolicy> => (
  parseContextPolicyText(
    text ?? readFileSync(path.join(root, 'kernel', 'context-policy.yaml'), 'utf8'),
  )
);

const contextPolicy = loadContextPolicy();

export const KERNEL_POLICY = Object.freeze({
  proofTiers: parseMap(proofPolicy, 'tiers'),
  hardFloors: Object.fromEntries(
    Object.entries(parseMap(proofPolicy, 'hardFloors'))
      .map(([key, value]) => [toSurface(key), value]),
  ),
  requiredChecks: parseListMap(proofPolicy, 'requiredChecks'),
  obligations: parseNestedMap(proofPolicy, 'obligations'),
  proofToEvidence: parseMap(evidencePolicy, 'proofToEvidence'),
  context: contextPolicy,
});
