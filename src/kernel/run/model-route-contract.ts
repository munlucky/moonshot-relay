import { matchCapture } from '../../shared/match-capture.js';
// Kernel→Host model route policy source and routing measurements.
//
// Canonical route/work-profile/usage contracts live under src/contracts.
// This module only owns the policy document loader and derived measurements.

import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolveRuntimeRoot } from '../../shared/runtime-assets.js';
import {
  executionClassForAction,
  executionClassFromLegacyModelClass,
  legacyModelClassForExecutionClass,
} from '../../contracts/execution-class.js';
import {
  ACTION_KINDS,
  EXECUTION_CLASSES,
  PERMISSIONS,
  ROLES,
  type ActionKind,
} from '../../contracts/model-route.js';
import { ModelRouteContractError } from '../../contracts/model-execution.js';

type UnknownRecord = Record<string, unknown>;

export interface ModelPolicyClassSpec extends UnknownRecord {
  providerModelRequired?: boolean;
  requiredCapabilities?: unknown[];
}

export interface ModelPolicyActionSpec extends UnknownRecord {
  executionClass?: unknown;
  modelClass?: unknown;
  role?: unknown;
  permissions?: unknown;
}

export interface ModelPolicy {
  schemaVersion: 1;
  policyRevision: string;
  thresholds: Readonly<{
    retryEscalationThreshold: number;
    stagnationThreshold: number;
    [key: string]: unknown;
  }>;
  executionClasses: Readonly<Record<string, ModelPolicyClassSpec>>;
  actionDefaults: Readonly<Record<string, ModelPolicyActionSpec>>;
  readonly modelClasses: Readonly<Record<string, ModelPolicyClassSpec>>;
  sourceRef: string;
  sourceDigest: string;
}

interface MetricReceipt extends UnknownRecord {
  eligiblePrefixTokens?: number | null;
  cacheReadInputTokens?: number | null;
  cacheWriteInputTokens?: number | null;
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  sessionLineageId?: string | null;
  cacheMissReason?: string | null;
  enforcementStatus?: 'enforced' | 'fallback' | 'advisory' | 'unsupported' | 'failed';
  resolvedModel?: string | null;
  decisionId?: string | null;
}

interface RoutingDecisionMetric extends UnknownRecord {
  decisionId?: string;
  modelClass?: string;
  reasonCodes?: readonly string[];
  independentContextRequired?: boolean;
}

type NumericMetricField =
  | 'eligiblePrefixTokens'
  | 'cacheReadInputTokens'
  | 'cacheWriteInputTokens'
  | 'inputTokens'
  | 'cachedInputTokens'
  | 'outputTokens'
  | 'reasoningTokens';

const sourceRoot = resolveRuntimeRoot(import.meta.url);

export const MODEL_POLICY_SOURCE = 'kernel/model-policy.yaml';

const fail = (code: string, message: string): never => {
  throw new ModelRouteContractError(code, message);
};

const isObject = (value: unknown): value is UnknownRecord => Boolean(
  value && typeof value === 'object' && !Array.isArray(value),
);

const recordOf = (value: unknown): UnknownRecord => (
  isObject(value) ? value : {}
);

const classSpecOf = (value: unknown): ModelPolicyClassSpec => (
  isObject(value) ? value as ModelPolicyClassSpec : {}
);

const actionSpecOf = (value: unknown): ModelPolicyActionSpec => (
  isObject(value) ? value as ModelPolicyActionSpec : {}
);

const parseValue = (raw: string): unknown => {
  const value = raw.trim();
  if (/^\[.*\]$/.test(value)) {
    return value
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (value === 'true' || value === 'false') return value === 'true';
  if (/^-?\d+$/.test(value)) return Number(value);
  return value.replace(
    /^(?:"([\s\S]*)"|'([\s\S]*)')$/,
    (_match: string, doubleQuoted: string | undefined, singleQuoted: string | undefined) => (
      doubleQuoted ?? singleQuoted ?? ''
    ),
  );
};

export const parseModelPolicyText = (
  text: unknown,
  { sourceRef = MODEL_POLICY_SOURCE }: { sourceRef?: string } = {},
): Readonly<ModelPolicy> => {
  const raw = String(text ?? '');
  const doc: UnknownRecord = {
    schemaVersion: null,
    policyRevision: null,
    thresholds: {},
    executionClasses: {},
    modelClasses: {},
    actionDefaults: {},
  };
  let section: string | null = null;
  let key: string | null = null;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const top = line.match(/^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/);
    if (top) {
      const field = matchCapture(top, 1);
      if (!Object.hasOwn(doc, field)) {
        return fail(
          'kernel_model_policy_malformed',
          `Unknown field in ${sourceRef}: ${field}`,
        );
      }
      section = field;
      key = null;
      if (matchCapture(top, 2).trim()) doc[field] = parseValue(matchCapture(top, 2));
      continue;
    }

    const entry = line.match(/^ {2}([A-Za-z0-9_]+):\s*(.*)$/);
    if (entry && section) {
      const sectionValue = doc[section];
      if (isObject(sectionValue)) {
        if (matchCapture(entry, 2).trim()) {
          sectionValue[matchCapture(entry, 1)] = parseValue(matchCapture(entry, 2));
          key = null;
        } else {
          key = matchCapture(entry, 1);
          sectionValue[key] = {};
        }
        continue;
      }
    }

    const field = line.match(/^ {4}([A-Za-z0-9_]+):\s*(.+)$/);
    if (field && section && key) {
      const sectionValue = doc[section];
      const nested = isObject(sectionValue) ? sectionValue[key] : null;
      if (isObject(nested)) {
        nested[matchCapture(field, 1)] = parseValue(matchCapture(field, 2));
        continue;
      }
    }

    fail(
      'kernel_model_policy_malformed',
      `Malformed ${sourceRef}: ${line.trim()}`,
    );
  }

  if (doc.schemaVersion !== 1) {
    fail(
      'kernel_model_policy_schema_invalid',
      `${sourceRef} schemaVersion must be 1`,
    );
  }
  if (!doc.policyRevision) {
    fail(
      'kernel_model_policy_revision_missing',
      `${sourceRef} policyRevision is required`,
    );
  }

  const executionClassesInput = recordOf(doc.executionClasses);
  const legacyClassesInput = recordOf(doc.modelClasses);
  const declaredExecutionClasses: Record<string, ModelPolicyClassSpec> = (
    Object.keys(executionClassesInput).length > 0
      ? Object.fromEntries(
          Object.entries(executionClassesInput)
            .map(([name, spec]) => [name, classSpecOf(spec)]),
        )
      : Object.fromEntries(
          Object.entries(legacyClassesInput)
            .filter(([name]) => name !== 'kernel')
            .map(([name, spec]) => [
              name === 'frontier_reasoning'
                ? 'planning'
                : name === 'value_coding'
                  ? 'standard'
                  : name,
              classSpecOf(spec),
            ]),
        )
  );

  for (const [name, spec] of Object.entries(declaredExecutionClasses)) {
    if (!EXECUTION_CLASSES.includes(name)) {
      return fail(
        'kernel_model_policy_class_unknown',
        `${sourceRef} declares an unknown execution class: ${name}`,
      );
    }
    if (typeof spec.providerModelRequired !== 'boolean') {
      return fail(
        'kernel_model_policy_class_invalid',
        `${sourceRef} execution class ${name} requires providerModelRequired`,
      );
    }
  }

  const actionDefaultsInput = recordOf(doc.actionDefaults);
  for (const action of ACTION_KINDS) {
    const rawSpec = actionDefaultsInput[action];
    if (!isObject(rawSpec)) {
      return fail(
        'kernel_model_policy_action_missing',
        `${sourceRef} has no default for action: ${action}`,
      );
    }
    const spec = actionSpecOf(rawSpec);
    const executionClass = spec.executionClass
      || (
        spec.modelClass
          ? executionClassFromLegacyModelClass(spec.modelClass)
          : null
      );
    const expected = executionClassForAction(action);
    if (
      executionClass !== null
      && executionClass !== expected
      && !(action === 'implement' && executionClass === 'complex_implementation')
    ) {
      return fail(
        'kernel_model_policy_action_invalid',
        `${sourceRef} action ${action} has an invalid executionClass`,
      );
    }
    if (action !== 'prove' && action !== 'close' && !executionClass) {
      return fail(
        'kernel_model_policy_action_invalid',
        `${sourceRef} action ${action} requires an executionClass`,
      );
    }
    if (!(ROLES as readonly unknown[]).includes(spec.role)) {
      return fail(
        'kernel_model_policy_action_invalid',
        `${sourceRef} action ${action} has an invalid role`,
      );
    }
    if (!(PERMISSIONS as readonly unknown[]).includes(spec.permissions)) {
      return fail(
        'kernel_model_policy_action_invalid',
        `${sourceRef} action ${action} has invalid permissions`,
      );
    }
  }

  const thresholdsInput = recordOf(doc.thresholds);
  const retryEscalationThreshold = Number(
    thresholdsInput.retryEscalationThreshold,
  );
  const stagnationThreshold = Number(thresholdsInput.stagnationThreshold);
  if (
    !Number.isInteger(retryEscalationThreshold)
    || retryEscalationThreshold < 1
  ) {
    fail(
      'kernel_model_policy_threshold_invalid',
      `${sourceRef} retryEscalationThreshold must be a positive integer`,
    );
  }
  if (!Number.isInteger(stagnationThreshold) || stagnationThreshold < 1) {
    fail(
      'kernel_model_policy_threshold_invalid',
      `${sourceRef} stagnationThreshold must be a positive integer`,
    );
  }

  const actionDefaults: Record<string, ModelPolicyActionSpec> =
    Object.fromEntries(
      Object.entries(actionDefaultsInput).map(([action, rawSpec]) => {
        const spec = actionSpecOf(rawSpec);
        const executionClass = spec.executionClass
          || (
            spec.modelClass
              ? executionClassFromLegacyModelClass(spec.modelClass)
              : null
          );
        const normalized: ModelPolicyActionSpec = {
          ...spec,
          executionClass,
        };
        Object.defineProperty(normalized, 'modelClass', {
          enumerable: false,
          configurable: false,
          get: () => (
            executionClass === null
              ? 'kernel'
              : legacyModelClassForExecutionClass(executionClass)
          ),
        });
        return [action, Object.freeze(normalized)];
      }),
    );

  const base = {
    schemaVersion: 1 as const,
    policyRevision: String(doc.policyRevision),
    thresholds: Object.freeze({
      ...thresholdsInput,
      retryEscalationThreshold,
      stagnationThreshold,
    }),
    executionClasses: Object.freeze(declaredExecutionClasses),
    actionDefaults: Object.freeze(actionDefaults),
    sourceRef,
    sourceDigest: createHash('sha256').update(raw).digest('hex'),
  };

  const legacyClasses = {
    get modelClasses(): Readonly<Record<string, ModelPolicyClassSpec>> {
      const providerClasses = Object.entries(declaredExecutionClasses);
      const frontier = providerClasses.find(([name]) => ['planning', 'review', 'complex_implementation'].includes(name))?.[1];
      const standard = providerClasses.find(([name]) => name === 'standard')?.[1];
      return Object.freeze({ frontier_reasoning: frontier || { requiredCapabilities: [], providerModelRequired: true }, value_coding: standard || { requiredCapabilities: [], providerModelRequired: true }, kernel: { requiredCapabilities: [], providerModelRequired: false } });
    },
  };
  const withLegacy = { ...base, get modelClasses() { return legacyClasses.modelClasses; } };
  Object.defineProperty(withLegacy, 'modelClasses', {
    enumerable: false,
    configurable: false,
    get: () => {
      const providerClasses = Object.entries(declaredExecutionClasses);
      const frontier = providerClasses.find(
        ([name]) => ['planning', 'review', 'complex_implementation'].includes(name),
      )?.[1];
      const standard = providerClasses.find(
        ([name]) => name === 'standard',
      )?.[1];
      return Object.freeze({
        frontier_reasoning: frontier || {
          requiredCapabilities: [],
          providerModelRequired: true,
        },
        value_coding: standard || {
          requiredCapabilities: [],
          providerModelRequired: true,
        },
        kernel: {
          requiredCapabilities: [],
          providerModelRequired: false,
        },
      });
    },
  });

  return Object.freeze(withLegacy);
};

let cached: Readonly<ModelPolicy> | null = null;

export const loadModelPolicy = ({
  sourceRoot: root = sourceRoot,
  text,
}: {
  sourceRoot?: string;
  text?: unknown;
} = {}): Readonly<ModelPolicy> => {
  if (text === undefined && root === sourceRoot && cached) return cached;
  const policy = parseModelPolicyText(
    text ?? readFileSync(path.join(root, MODEL_POLICY_SOURCE), 'utf8'),
  );
  if (text === undefined && root === sourceRoot) cached = policy;
  return policy;
};

// prove/close are Kernel-owned: they must never ask the Host for a model.
export const requiresProviderModel = (
  executionClassOrModelClass: unknown,
  policy: Readonly<ModelPolicy> = loadModelPolicy(),
): boolean => {
  const raw = String(executionClassOrModelClass || '');
  const executionClass = EXECUTION_CLASSES.includes(raw)
    ? raw
    : executionClassFromLegacyModelClass(executionClassOrModelClass);
  if (executionClass === null) return false;
  return (
    policy.executionClasses[executionClass]?.providerModelRequired === true
    || policy.modelClasses[raw]?.providerModelRequired === true
  );
};

const ratio = (
  numerator: number | null,
  denominator: number | null,
): number | null => (
  numerator === null || denominator === null || !denominator
    ? null
    : numerator / denominator
);

const sum = (
  receipts: readonly MetricReceipt[],
  field: NumericMetricField,
): number | null => receipts.reduce<number | null>((total, receipt) => {
  const value = receipt[field];
  return value === null || value === undefined
    ? total
    : (total ?? 0) + value;
}, null);

const pairedRatio = (
  receipts: readonly MetricReceipt[],
  numeratorField: NumericMetricField,
  denominatorField: NumericMetricField,
): number | null => {
  let numerator: number | null = null;
  let denominator: number | null = null;
  for (const receipt of receipts) {
    const numValue = receipt[numeratorField];
    const denValue = receipt[denominatorField];
    if (
      numValue === null
      || numValue === undefined
      || denValue === null
      || denValue === undefined
    ) {
      continue;
    }
    numerator = (numerator ?? 0) + numValue;
    denominator = (denominator ?? 0) + denValue;
  }
  return ratio(numerator, denominator);
};

export const summarizeCacheEconomics = (
  receipts: readonly MetricReceipt[] = [],
) => {
  const eligiblePrefixTokens = sum(receipts, 'eligiblePrefixTokens');
  const cacheReadInputTokens = sum(receipts, 'cacheReadInputTokens');
  const cacheWriteInputTokens = sum(receipts, 'cacheWriteInputTokens');
  const inputTokens = sum(receipts, 'inputTokens');
  const outputTokens = sum(receipts, 'outputTokens');
  const reasoningTokens = sum(receipts, 'reasoningTokens');
  const continuationEligible = receipts.filter(
    (receipt) => receipt.sessionLineageId !== null,
  );
  const continued = continuationEligible.filter((receipt, index, all) => (
    all.findIndex(
      (other) => other.sessionLineageId === receipt.sessionLineageId,
    ) !== index
  ));
  const missReasons = [
    ...new Set(
      receipts
        .map((receipt) => receipt.cacheMissReason)
        .filter((reason): reason is string => Boolean(reason)),
    ),
  ].sort();

  return Object.freeze({
    schemaVersion: 1,
    receipts: receipts.length,
    totals: Object.freeze({
      eligiblePrefixTokens,
      cacheReadInputTokens,
      cacheWriteInputTokens,
      inputTokens,
      outputTokens,
      reasoningTokens,
    }),
    eligibleHitRatio: pairedRatio(
      receipts,
      'cacheReadInputTokens',
      'eligiblePrefixTokens',
    ),
    totalInputCacheRatio: pairedRatio(
      receipts,
      'cacheReadInputTokens',
      'inputTokens',
    ),
    writeReadRatio: pairedRatio(
      receipts,
      'cacheWriteInputTokens',
      'cacheReadInputTokens',
    ),
    reasoningRatio: pairedRatio(
      receipts,
      'reasoningTokens',
      'outputTokens',
    ),
    sessionContinuationRate: continuationEligible.length
      ? continued.length / continuationEligible.length
      : null,
    missReasons: Object.freeze(Object.fromEntries(
      missReasons.map((reason) => [
        reason,
        receipts.filter(
          (receipt) => receipt.cacheMissReason === reason,
        ).length,
      ]),
    )),
  });
};

export const summarizeModelRouting = (
  decisions: readonly RoutingDecisionMetric[] = [],
  receipts: readonly MetricReceipt[] = [],
) => {
  const byDecision = new Map(
    decisions.map((decision) => [decision.decisionId, decision]),
  );
  const summary = {
    totalTurns: decisions.length,
    frontierTurns: decisions.filter(
      (decision) => decision.modelClass === 'frontier_reasoning',
    ).length,
    valueTurns: decisions.filter(
      (decision) => decision.modelClass === 'value_coding',
    ).length,
    kernelOnlyActions: decisions.filter(
      (decision) => decision.modelClass === 'kernel',
    ).length,
    escalatedTurns: decisions.filter((decision) => (
      (decision.reasonCodes || []).some(
        (code) => (
          code.endsWith('_ESCALATION')
          || code.endsWith('_REPLAN')
          || code === 'PROTECTED_OBLIGATION_FAILURE'
        ),
      )
    )).length,
    independentReviewTurns: decisions.filter(
      (decision) => decision.independentContextRequired === true,
    ).length,
    enforcedTurns: 0,
    fallbackTurns: 0,
    advisoryTurns: 0,
    unsupportedTurns: 0,
    failedTurns: 0,
    receiptCoverage: {
      receipts: receipts.length,
      providerTurns: decisions.filter(
        (decision) => decision.modelClass !== 'kernel',
      ).length,
    },
    tokens: {
      input: null as number | null,
      cachedInput: null as number | null,
      output: null as number | null,
      reportedTurns: 0,
    },
    resolvedModels: [] as string[],
  };

  const counters = {
    enforced: 'enforcedTurns',
    fallback: 'fallbackTurns',
    advisory: 'advisoryTurns',
    unsupported: 'unsupportedTurns',
    failed: 'failedTurns',
  } as const;

  for (const receipt of receipts) {
    const status = receipt.enforcementStatus;
    if (status) {
      const counter = counters[status];
      summary[counter] += 1;
    }
    if (receipt.inputTokens === null && receipt.outputTokens === null) continue;
    summary.tokens.reportedTurns += 1;
    summary.tokens.input = (
      (summary.tokens.input ?? 0) + (receipt.inputTokens ?? 0)
    );
    summary.tokens.cachedInput = (
      (summary.tokens.cachedInput ?? 0) + (receipt.cachedInputTokens ?? 0)
    );
    summary.tokens.output = (
      (summary.tokens.output ?? 0) + (receipt.outputTokens ?? 0)
    );
  }

  summary.resolvedModels = [
    ...new Set(
      receipts
        .map((receipt) => (
          receipt.resolvedModel
            ? `${byDecision.get(receipt.decisionId ?? undefined)?.modelClass || 'unknown'}:${receipt.resolvedModel}`
            : null
        ))
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  return summary;
};
