import { matchCapture } from '../../shared/match-capture.js';
// Host-owned model policy loading and provider requirement checks.

import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolveRuntimeRoot } from '../../shared/runtime-assets.js';
import {
  ACTION_KINDS,
  EXECUTION_CLASSES,
  PERMISSIONS,
  ROLES,
} from '../../contracts/model-route.js';
import type {
  ActionKind,
  ModelRoutePermission,
  ModelRouteRole,
} from '../../contracts/model-route.js';
import type { ExecutionClass, LegacyModelClass } from '../../contracts/execution-class.js';
import {
  executionClassForAction,
  executionClassFromLegacyModelClass,
  legacyModelClassForExecutionClass,
} from '../../contracts/execution-class.js';
import { ModelRouteContractError } from '../../contracts/model-execution.js';

type UnknownRecord = Record<string, unknown>;

interface PolicyClassSpec extends UnknownRecord {
  providerModelRequired?: unknown;
  requiredCapabilities?: unknown;
}

interface ActionDefaultSpec extends UnknownRecord {
  executionClass?: unknown;
  modelClass?: unknown;
  role?: unknown;
  permissions?: unknown;
}

interface NormalizedPolicyClass extends UnknownRecord {
  providerModelRequired: boolean;
}

interface NormalizedActionDefault extends UnknownRecord {
  executionClass: ExecutionClass | null;
  readonly modelClass?: LegacyModelClass;
}

export interface ModelPolicy {
  schemaVersion: 1;
  policyRevision: string;
  thresholds: Readonly<UnknownRecord>;
  executionClasses: Readonly<Record<string, NormalizedPolicyClass>>;
  actionDefaults: Readonly<Record<string, Readonly<NormalizedActionDefault>>>;
  sourceRef: string;
  sourceDigest: string;
  readonly modelClasses?: Readonly<Record<string, NormalizedPolicyClass>>;
}

const sourceRoot = resolveRuntimeRoot(import.meta.url);

export const MODEL_POLICY_SOURCE = 'kernel/model-policy.yaml';

const fail = (code: string, message: string): never => {
  throw new ModelRouteContractError(code, message);
};

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
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
    (_match, doubleQuoted: string | undefined, singleQuoted: string | undefined) => (
      doubleQuoted ?? singleQuoted ?? ''
    ),
  );
};

const stringMember = (
  values: readonly string[],
  value: unknown,
): value is string => (
  typeof value === 'string' && values.includes(value)
);

const toClassMap = (value: unknown): Record<string, PolicyClassSpec> => {
  const record = asRecord(value);
  return Object.fromEntries(
    Object.entries(record).map(([name, spec]) => [
      name,
      asRecord(spec) as PolicyClassSpec,
    ]),
  );
};

const toActionMap = (value: unknown): Record<string, ActionDefaultSpec> => {
  const record = asRecord(value);
  return Object.fromEntries(
    Object.entries(record).map(([name, spec]) => [
      name,
      asRecord(spec) as ActionDefaultSpec,
    ]),
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
      const fieldName = matchCapture(top, 1);
      const rawValue = matchCapture(top, 2);
      if (!Object.hasOwn(doc, fieldName)) {
        return fail(
          'kernel_model_policy_malformed',
          `Unknown field in ${sourceRef}: ${fieldName}`,
        );
      }
      section = fieldName;
      key = null;
      if (rawValue.trim()) doc[fieldName] = parseValue(rawValue);
      continue;
    }

    const entry = line.match(/^ {2}([A-Za-z0-9_]+):\s*(.*)$/);
    if (entry && section) {
      const sectionRecord = asRecord(doc[section]);
      if (matchCapture(entry, 2).trim()) {
        sectionRecord[matchCapture(entry, 1)] = parseValue(matchCapture(entry, 2));
        key = null;
      } else {
        key = matchCapture(entry, 1);
        sectionRecord[key] = {};
      }
      doc[section] = sectionRecord;
      continue;
    }

    const field = line.match(/^ {4}([A-Za-z0-9_]+):\s*(.+)$/);
    if (field && section && key) {
      const sectionRecord = asRecord(doc[section]);
      const nested = asRecord(sectionRecord[key]);
      nested[matchCapture(field, 1)] = parseValue(matchCapture(field, 2));
      sectionRecord[key] = nested;
      doc[section] = sectionRecord;
      continue;
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

  const executionClasses = toClassMap(doc.executionClasses);
  const legacyModelClasses = toClassMap(doc.modelClasses);
  const declaredExecutionClasses: Record<string, PolicyClassSpec> = (
    Object.keys(executionClasses).length > 0
      ? executionClasses
      : Object.fromEntries(
        Object.entries(legacyModelClasses)
          .filter(([name]) => name !== 'kernel')
          .map(([name, spec]) => [
            name === 'frontier_reasoning'
              ? 'planning'
              : name === 'value_coding'
                ? 'standard'
                : name,
            spec,
          ]),
      )
  );

  const normalizedClasses: Record<string, NormalizedPolicyClass> = {};
  for (const [name, spec] of Object.entries(declaredExecutionClasses)) {
    if (!EXECUTION_CLASSES.includes(name)) {
      return fail(
        'kernel_model_policy_class_unknown',
        `${sourceRef} declares an unknown execution class: ${name}`,
      );
    }
    const providerModelRequired = spec.providerModelRequired;
    if (typeof providerModelRequired !== 'boolean') {
      return fail(
        'kernel_model_policy_class_invalid',
        `${sourceRef} execution class ${name} requires providerModelRequired`,
      );
    }
    normalizedClasses[name] = {
      ...spec,
      providerModelRequired: providerModelRequired === true,
    };
  }

  const actionSpecs = toActionMap(doc.actionDefaults);
  for (const action of ACTION_KINDS) {
    const spec = actionSpecs[action];
    if (!spec) {
      return fail(
        'kernel_model_policy_action_missing',
        `${sourceRef} has no default for action: ${action}`,
      );
    }

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
      && !(
        action === 'implement'
        && executionClass === 'complex_implementation'
      )
    ) {
      return fail(
        'kernel_model_policy_action_invalid',
        `${sourceRef} action ${action} has an invalid executionClass`,
      );
    }
    if (
      action !== 'prove'
      && action !== 'close'
      && !executionClass
    ) {
      return fail(
        'kernel_model_policy_action_invalid',
        `${sourceRef} action ${action} requires an executionClass`,
      );
    }
    if (!stringMember(ROLES, spec.role)) {
      return fail(
        'kernel_model_policy_action_invalid',
        `${sourceRef} action ${action} has an invalid role`,
      );
    }
    if (!stringMember(PERMISSIONS, spec.permissions)) {
      return fail(
        'kernel_model_policy_action_invalid',
        `${sourceRef} action ${action} has invalid permissions`,
      );
    }
  }

  const thresholds = asRecord(doc.thresholds);
  const retryEscalationThreshold = thresholds.retryEscalationThreshold;
  const stagnationThreshold = thresholds.stagnationThreshold;
  if (
    !Number.isInteger(retryEscalationThreshold)
    || Number(retryEscalationThreshold) < 1
  ) {
    fail(
      'kernel_model_policy_threshold_invalid',
      `${sourceRef} retryEscalationThreshold must be a positive integer`,
    );
  }
  if (
    !Number.isInteger(stagnationThreshold)
    || Number(stagnationThreshold) < 1
  ) {
    fail(
      'kernel_model_policy_threshold_invalid',
      `${sourceRef} stagnationThreshold must be a positive integer`,
    );
  }

  const actionDefaults = Object.fromEntries(
    Object.entries(actionSpecs).map(([action, spec]) => {
      const executionClass = (
        spec.executionClass
        || (
          spec.modelClass
            ? executionClassFromLegacyModelClass(spec.modelClass)
            : null
        )
      ) as ExecutionClass | null;
      const { modelClass: _legacyModelClass, ...normalizedSpec } = spec;
      const normalized: NormalizedActionDefault = {
        ...normalizedSpec,
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

  const normalizedPolicy: ModelPolicy = {
    schemaVersion: 1,
    policyRevision: String(doc.policyRevision),
    thresholds: Object.freeze(thresholds),
    executionClasses: Object.freeze(normalizedClasses),
    actionDefaults: Object.freeze(actionDefaults),
    sourceRef,
    sourceDigest: createHash('sha256').update(raw).digest('hex'),
  };

  Object.defineProperty(normalizedPolicy, 'modelClasses', {
    enumerable: false,
    configurable: false,
    get: () => {
      const providerClasses = Object.entries(normalizedClasses);
      const frontier = providerClasses.find(([name]) => (
        ['planning', 'review', 'complex_implementation'].includes(name)
      ))?.[1];
      const standard = providerClasses.find(([name]) => name === 'standard')?.[1];
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

  return Object.freeze(normalizedPolicy);
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

export const requiresProviderModel = (
  executionClassOrModelClass: unknown,
  policy: Readonly<ModelPolicy> = loadModelPolicy(),
): boolean => {
  const normalized = String(executionClassOrModelClass || '');
  const executionClass = EXECUTION_CLASSES.includes(normalized)
    ? normalized as ExecutionClass
    : executionClassFromLegacyModelClass(executionClassOrModelClass);
  if (executionClass === null) return false;

  const legacy = normalized as LegacyModelClass;
  return policy.executionClasses[executionClass]?.providerModelRequired === true
    || policy.modelClasses?.[legacy]?.providerModelRequired === true;
};
