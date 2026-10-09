export type ExecutionClass = 'planning' | 'complex_implementation' | 'review' | 'standard';
export type LegacyModelClass = 'frontier_reasoning' | 'value_coding' | 'kernel';

// Provider-neutral workload vocabulary owned by the Kernel.
//
// An execution class describes the work the Agent must perform. It is not a
// model name, provider name, cost tier, or difficulty score. Host adapters are
// responsible for mapping these four values to an actual execution setting.

export const EXECUTION_CLASSES: readonly string[] = Object.freeze([
  'planning',
  'complex_implementation',
  'review',
  'standard',
]);

export const LEGACY_MODEL_CLASSES = Object.freeze([
  'frontier_reasoning',
  'value_coding',
  'kernel',
]);

export const KERNEL_EXECUTION_CLASS = null;

const ACTION_EXECUTION_CLASSES: Readonly<Record<string, ExecutionClass | null>> = Object.freeze({
  understand: 'planning',
  design: 'planning',
  plan: 'planning',
  implement: 'standard',
  debug: 'standard',
  review_contract: 'review',
  review_engineering: 'review',
  replan: 'planning',
  prove: null,
  close: null,
});

const LEGACY_TO_EXECUTION_CLASS: Readonly<Record<string, ExecutionClass | null>> = Object.freeze({
  frontier_reasoning: 'planning',
  value_coding: 'standard',
  kernel: null,
});

const EXECUTION_TO_LEGACY_MODEL_CLASS: Readonly<Record<ExecutionClass, LegacyModelClass>> = Object.freeze({
  planning: 'frontier_reasoning',
  complex_implementation: 'frontier_reasoning',
  review: 'frontier_reasoning',
  standard: 'value_coding',
});

const COMPLEXITY_TO_EXECUTION_CLASS: Readonly<Record<string, ExecutionClass>> = Object.freeze({
  routine: 'standard',
  'routine-batch': 'standard',
  simple: 'standard',
  standard: 'standard',
  complex: 'complex_implementation',
  'large-refactor': 'complex_implementation',
});

export const normalizeExecutionClass = (value: unknown, { allowNull = true } = {}): ExecutionClass | null => {
  if (value === null || value === undefined || value === '') {
    if (allowNull) return null;
    throw new TypeError('executionClass is required');
  }
  const normalized = String(value).trim();
  if (!EXECUTION_CLASSES.includes(normalized)) {
    throw new TypeError(`executionClass must be one of: ${EXECUTION_CLASSES.join(', ')}`);
  }
  return normalized as ExecutionClass;
};

export const executionClassForAction = (actionKind: unknown, { complexity = null, explicit = null }: { complexity?: unknown; explicit?: unknown } = {}): ExecutionClass | null => {
  if (explicit !== null && explicit !== undefined && explicit !== '') return normalizeExecutionClass(explicit, { allowNull: false });
  const actionClass = ACTION_EXECUTION_CLASSES[String(actionKind)];
  if (actionClass === undefined) throw new TypeError(`Unknown actionKind: ${actionKind}`);
  if (actionClass !== 'standard') return actionClass;
  return COMPLEXITY_TO_EXECUTION_CLASS[String(complexity)] || actionClass;
};

export const executionClassFromLegacyModelClass = (modelClass: unknown): ExecutionClass | null => {
  if (modelClass === null || modelClass === undefined || modelClass === '') return null;
  const normalized = String(modelClass);
  if (!Object.hasOwn(LEGACY_TO_EXECUTION_CLASS, normalized)) {
    throw new TypeError(`legacy modelClass must be one of: ${LEGACY_MODEL_CLASSES.join(', ')}`);
  }
  return LEGACY_TO_EXECUTION_CLASS[normalized];
};

export const legacyModelClassForExecutionClass = (executionClass: unknown) => {
  const normalized = normalizeExecutionClass(executionClass);
  return normalized === null ? 'kernel' : EXECUTION_TO_LEGACY_MODEL_CLASS[normalized];
};

export const isProviderExecutionClass = (executionClass: unknown) => {
  const normalized = normalizeExecutionClass(executionClass);
  return normalized !== null;
};

export const complexityForExecutionClass = (executionClass: unknown) => {
  switch (normalizeExecutionClass(executionClass)) {
    case 'complex_implementation': return 'complex';
    case 'planning': return 'standard';
    case 'review': return 'standard';
    case 'standard': return 'standard';
    default: return null;
  }
};
