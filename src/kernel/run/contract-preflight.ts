// Contract admission boundary (K1/K2). A task contract is validated before a
// Run, owner binding, or mutation lease becomes durable. Keeping this check
// separate from the later dispatch guards makes malformed work fail before it
// can strand lifecycle state.

import path from 'node:path';
import {
  classifyWorkUnitScope,
  requiresImplementationWorkUnitScope,
} from '../../contracts/work-unit-scope.js';

type UnknownRecord = Record<string, unknown>;

interface ErrorLike {
  code?: unknown;
  message?: unknown;
}

interface PathStatsPort {
  isSymbolicLink?: () => boolean;
}

interface ContractPathAccess {
  resolveRealpath?: ((value: string) => string) | undefined;
  checkExists?: ((value: string) => boolean) | undefined;
  lstatPath?: ((value: string) => PathStatsPort) | undefined;
}

interface EvidencePlanLike {
  commandRefs?: unknown;
  commandRef?: unknown;
  obligationId?: unknown;
}

interface AcceptanceLike {
  id?: unknown;
  evidencePlan?: unknown;
}

interface StepLike extends UnknownRecord {
  stepId?: unknown;
  allowedPaths?: unknown;
  strictBoundedScope?: boolean;
  acceptanceIds?: unknown;
  obligationIds?: unknown;
  expectedOutputs?: unknown;
}

interface ContractLike extends UnknownRecord {
  acceptance?: unknown;
  requiredObligations?: unknown;
  flags?: UnknownRecord;
  taskClass?: unknown;
  steps?: unknown[];
  allowedPaths?: unknown;
  strictBoundedScope?: boolean;
  requiredVerifications?: unknown;
}

interface ObligationLike {
  obligationId?: unknown;
}

interface CommandLike {
  commandRef?: unknown;
}

interface NormalizeBoundedPathsInput extends ContractPathAccess {
  paths?: unknown;
  projectRoot?: string;
}

interface ValidateDeclaredStepsInput extends ContractPathAccess {
  contract?: ContractLike;
  commands?: CommandLike[] | null;
  obligations?: ObligationLike[];
  projectRoot?: string;
  requireDetailedBindings?: boolean | null;
  acceptanceIdMap?: Record<string, string> | null;
}

interface ValidateVerificationCommandsInput {
  contract?: ContractLike;
  commands?: CommandLike[] | null;
  strict?: boolean;
}

interface PreflightTaskContractInput extends ContractPathAccess {
  contract?: unknown;
  projectRoot?: string;
  commands?: CommandLike[] | null;
  obligations?: ObligationLike[];
  requireImplementationScope?: boolean | null;
  strictVerificationCommands?: boolean;
  acceptanceIdMap?: Record<string, string> | null;
}

type ContractPreflightError = Error & {
  code: string | null | undefined;
  errorCode: string | null | undefined;
  details: UnknownRecord;
  recoverable: boolean;
  blockingClass: string;
  nextAction: string | null | undefined;
};

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);

const asStep = (value: unknown): StepLike => asRecord(value) as StepLike;
const asAcceptance = (value: unknown): AcceptanceLike => asRecord(value) as AcceptanceLike;
const asEvidencePlan = (value: unknown): EvidencePlanLike => asRecord(value) as EvidencePlanLike;
const errorLike = (value: unknown): ErrorLike => (
  value && typeof value === 'object' ? value as ErrorLike : {}
);
const errorCode = (value: unknown): string | null => {
  const candidate = errorLike(value);
  return candidate.code == null ? null : String(candidate.code);
};
const errorMessage = (value: unknown): string => {
  const candidate = errorLike(value);
  return String(candidate.message || value);
};

export const CONTRACT_PREFLIGHT_ERROR_CODES = Object.freeze({
  invalid: 'contract-preflight-invalid',
  pathInvalid: 'contract-path-invalid',
  stepBindingInvalid: 'contract-step-binding-invalid',
  verificationCommandMissing: 'verification-command-missing',
});

export const BLOCKING_CLASSES = Object.freeze({
  safety: 'safety',
  completion: 'completion',
  context: 'context',
  system: 'system',
});

const CONTRACT_PREFLIGHT_NEXT_ACTION = 'revise-task-contract';
const READ_ONLY_TASK_CLASSES = new Set(['analysis', 'audit', 'plan', 'review']);
const DETAILED_STEP_BINDING_FLAGS = new Set([
  'behaviorChanging',
  'crossLayer',
  'independentDeliverables',
  'safeParallelSplit',
  'longRunning',
]);

const fail = (
  code: string | null | undefined,
  message: unknown,
  details: UnknownRecord = {},
  nextAction: string | null | undefined = CONTRACT_PREFLIGHT_NEXT_ACTION,
  recoverable = true,
): ContractPreflightError => {
  const blockingClass = code === CONTRACT_PREFLIGHT_ERROR_CODES.pathInvalid
    ? BLOCKING_CLASSES.safety
    : BLOCKING_CLASSES.completion;
  const error = new Error(`${code}: ${message}`) as ContractPreflightError;
  error.code = code;
  error.errorCode = code;
  error.details = details;
  error.recoverable = recoverable;
  error.blockingClass = blockingClass;
  error.nextAction = nextAction;
  return error as ContractPreflightError;
};

const isAbsoluteRepositoryPath = (value: string): boolean => (
  value.startsWith('/')
  || value.startsWith('~')
  || /^[A-Za-z]:[\\/]/u.test(value)
  || /^[A-Za-z]:[^/]/u.test(value)
);

export const normalizeRepositoryPath = (
  entry: unknown,
  projectRoot: string | undefined,
  {
    resolveRealpath,
    checkExists,
    lstatPath,
  }: ContractPathAccess = {},
): string => {
  if (typeof entry !== 'string') {
    throw fail(
      CONTRACT_PREFLIGHT_ERROR_CODES.pathInvalid,
      'allowedPaths entries must be repository-relative strings',
      { entry, reason: 'non-string' },
      CONTRACT_PREFLIGHT_NEXT_ACTION,
      false,
    );
  }
  const value = entry.trim().replaceAll('\\', '/');
  if (!value || value === '.') {
    throw fail(
      CONTRACT_PREFLIGHT_ERROR_CODES.pathInvalid,
      'allowedPaths entries must name a bounded repository path',
      { entry, reason: 'empty-or-root' },
      CONTRACT_PREFLIGHT_NEXT_ACTION,
      true,
    );
  }
  if (value.includes('\u0000') || isAbsoluteRepositoryPath(value)) {
    throw fail(
      CONTRACT_PREFLIGHT_ERROR_CODES.pathInvalid,
      `allowedPaths entry is not repository-relative: ${entry}`,
      { entry, reason: 'absolute-or-invalid-root' },
      CONTRACT_PREFLIGHT_NEXT_ACTION,
      false,
    );
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw fail(
      CONTRACT_PREFLIGHT_ERROR_CODES.pathInvalid,
      `allowedPaths entry may not traverse outside the repository: ${entry}`,
      { entry, reason: 'path-traversal' },
      CONTRACT_PREFLIGHT_NEXT_ACTION,
      false,
    );
  }
  const normalized = segments.filter((segment) => segment && segment !== '.').join('/');
  if (!normalized) {
    throw fail(
      CONTRACT_PREFLIGHT_ERROR_CODES.pathInvalid,
      `allowedPaths entry is empty after normalization: ${entry}`,
      { entry, reason: 'empty-after-normalization' },
      CONTRACT_PREFLIGHT_NEXT_ACTION,
      true,
    );
  }

  if (typeof resolveRealpath !== 'function' || typeof checkExists !== 'function' || typeof lstatPath !== 'function') {
    throw new TypeError('contract_path_access_required');
  }

  const root = path.resolve(projectRoot || process.cwd());
  let canonicalRoot = root;
  let rootExists = false;
  try {
    rootExists = checkExists(root);
  } catch (err) {
    throw fail(
      CONTRACT_PREFLIGHT_ERROR_CODES.pathInvalid,
      `repository root cannot be verified: ${root}`,
      { entry, reason: 'repository-realpath-unavailable', projectRoot: root, error: errorMessage(err) },
      CONTRACT_PREFLIGHT_NEXT_ACTION,
      false,
    );
  }

  if (rootExists) {
    try {
      canonicalRoot = resolveRealpath(root);
    } catch (err) {
      throw fail(
        CONTRACT_PREFLIGHT_ERROR_CODES.pathInvalid,
        `repository root realpath failed: ${root}`,
        { entry, reason: 'repository-realpath-unavailable', projectRoot: root, error: errorMessage(err) },
        CONTRACT_PREFLIGHT_NEXT_ACTION,
        false,
      );
    }
  }

  const normalizeCase = (val: string): string => process.platform === 'win32' ? val.toLowerCase() : val;
  const compRoot = normalizeCase(canonicalRoot);

  let currentPath = root;
  for (const segment of normalized.split('/')) {
    const nextPath = path.resolve(currentPath, segment);
    let stats = null;
    try {
      stats = lstatPath(nextPath);
    } catch (err) {
      if (errorCode(err) === 'ENOENT' || errorCode(err) === 'ENOTDIR') {
        break;
      }
      throw fail(
        CONTRACT_PREFLIGHT_ERROR_CODES.pathInvalid,
        `allowedPaths ancestor cannot be inspected: ${nextPath}`,
        { entry, reason: 'ancestor-realpath-unavailable', projectRoot: root, path: nextPath, error: errorMessage(err) },
        CONTRACT_PREFLIGHT_NEXT_ACTION,
        false,
      );
    }

    const isSymlink = stats && (typeof stats.isSymbolicLink === 'function' ? stats.isSymbolicLink() : false);
    let realNext = nextPath;
    try {
      realNext = resolveRealpath(nextPath);
    } catch (err) {
      const reason = isSymlink ? 'broken-link' : 'ancestor-realpath-unavailable';
      throw fail(
        CONTRACT_PREFLIGHT_ERROR_CODES.pathInvalid,
        `allowedPaths path cannot be resolved physically: ${nextPath}`,
        { entry, reason, projectRoot: root, path: nextPath, error: errorMessage(err) },
        CONTRACT_PREFLIGHT_NEXT_ACTION,
        false,
      );
    }

    const compRealNext = normalizeCase(realNext);
    if (compRealNext !== compRoot && !compRealNext.startsWith(`${compRoot}${path.sep}`)) {
      throw fail(
        CONTRACT_PREFLIGHT_ERROR_CODES.pathInvalid,
        `allowedPaths entry escapes the repository via symlink/junction: ${entry}`,
        { entry, reason: 'out-of-root-symlink', projectRoot: root, resolved: realNext },
        CONTRACT_PREFLIGHT_NEXT_ACTION,
        false,
      );
    }
    currentPath = nextPath;
  }
  return normalized;
};

export const normalizeBoundedPaths = ({
  paths = [],
  projectRoot = process.cwd(),
  resolveRealpath,
  checkExists,
  lstatPath,
}: NormalizeBoundedPathsInput = {}): string[] => {
  if (!Array.isArray(paths)) {
    throw fail(
      CONTRACT_PREFLIGHT_ERROR_CODES.pathInvalid,
      'allowedPaths must be an array of repository-relative strings',
      { valueType: typeof paths, reason: 'not-array' },
    );
  }
  return [...new Set(paths.map((entry) => normalizeRepositoryPath(entry, projectRoot, { resolveRealpath, checkExists, lstatPath })))].sort();
};

const acceptanceIdsFor = (contract: ContractLike): Set<string> => new Set(
  (Array.isArray(contract.acceptance) ? contract.acceptance as unknown[] : [])
    .map((entry, index) => {
      const acceptance = asAcceptance(entry);
      return acceptance.id ? acceptance.id : `AC-${index + 1}`;
    })
    .filter(Boolean)
    .map(String),
);

const obligationIdsFor = (obligations: ObligationLike[], contract: ContractLike): Set<string> => new Set([
  ...obligations.map((entry) => entry.obligationId).filter(Boolean).map(String),
  ...(Array.isArray(contract.requiredObligations) ? contract.requiredObligations as unknown[] : []).map(String),
  ...(Array.isArray(contract.acceptance) ? contract.acceptance as unknown[] : [])
    .map((entry) => asEvidencePlan(asAcceptance(entry).evidencePlan).obligationId)
    .filter(Boolean)
    .map(String),
]);

const assertNonEmptyStringList = (
  value: unknown,
  label: string,
  details: UnknownRecord,
): string[] => {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw fail(
      CONTRACT_PREFLIGHT_ERROR_CODES.stepBindingInvalid,
      `Each declared step requires a non-empty ${label} list`,
      { ...details, field: label },
    );
  }
  return [...new Set((value as string[]).map((entry) => entry.trim()))];
};

export const requiresDetailedStepBindings = (contract: ContractLike = {}): boolean => {
  const flags = contract.flags && typeof contract.flags === 'object' ? contract.flags : {};
  return String(contract?.taskClass || '').toLowerCase() === 'long-running'
    || [...DETAILED_STEP_BINDING_FLAGS].some((flag) => flags[flag] === true || contract[flag] === true)
    || (Array.isArray(contract.steps) && (contract.steps as unknown[]).some((step) => (
      step && typeof step === 'object' && !Array.isArray(step)
      && Object.prototype.hasOwnProperty.call(step, 'expectedOutputs')
    )));
};

export const validateDeclaredSteps = ({
  contract = {},
  commands = null,
  obligations = [],
  projectRoot = process.cwd(),
  requireDetailedBindings = null,
  acceptanceIdMap = null,
  resolveRealpath,
  checkExists,
  lstatPath,
}: ValidateDeclaredStepsInput = {}) => {
  void commands;
  const declared: unknown[] = Array.isArray(contract.steps) ? contract.steps : [];
  if (declared.length === 0) return { valid: true, steps: [] };

  const isImplementationTask = !READ_ONLY_TASK_CLASSES.has(String(contract.taskClass || '').toLowerCase());
  const detailedBindings = requireDetailedBindings === null
    ? (requiresDetailedStepBindings(contract) || (isImplementationTask && requiresImplementationWorkUnitScope({ contract })))
    : Boolean(requireDetailedBindings);
  const acceptanceIds = acceptanceIdsFor(contract);
  const targetAcceptanceIds: Set<string> = acceptanceIdMap
    ? new Set(Object.values(acceptanceIdMap))
    : acceptanceIds;
  const obligationIds = obligationIdsFor(obligations, contract);
  const seenStepIds = new Set<string>();
  const claimedAcceptanceIds = new Set<string>();
  const normalizedSteps: Array<{
    stepId: string;
    allowedPaths: string[];
    acceptanceIds: string[];
    obligationIds: string[];
    expectedOutputs: string[];
  }> = [];

  for (const [index, raw] of declared.entries()) {
    const rawRecord = asRecord(raw);
    const details: UnknownRecord = { index, stepId: rawRecord.stepId || null };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw fail(
        CONTRACT_PREFLIGHT_ERROR_CODES.stepBindingInvalid,
        `Declared step ${index + 1} must be an object`,
        details,
      );
    }
    const step = asStep(raw);
    const stepId = step.stepId ? String(step.stepId).trim() : `step-${index + 1}`;
    if (seenStepIds.has(stepId)) {
      throw fail(
        CONTRACT_PREFLIGHT_ERROR_CODES.stepBindingInvalid,
        `Declared step id is duplicated: ${stepId}`,
        { ...details, stepId },
      );
    }
    seenStepIds.add(stepId);

    const hasStepScope = Object.prototype.hasOwnProperty.call(step, 'allowedPaths');
    const rawPaths = hasStepScope ? step.allowedPaths : contract.allowedPaths;
    const allowedPaths = Array.isArray(rawPaths)
      ? normalizeBoundedPaths({ paths: rawPaths, projectRoot, resolveRealpath, checkExists, lstatPath })
      : [];
    const scope = classifyWorkUnitScope({
      allowedPaths,
      strict: contract.strictBoundedScope === true || step.strictBoundedScope === true || isImplementationTask,
    });
    if (isImplementationTask && !scope.valid) {
      throw fail(scope.errorCode, scope.message, { ...details, stepId, scope }, scope.nextAction);
    }

    const stepAcceptanceIds = Array.isArray(step.acceptanceIds)
      ? assertNonEmptyStringList(step.acceptanceIds, 'acceptanceIds', { ...details, stepId })
      : [];
    if (detailedBindings && stepAcceptanceIds.length === 0 && targetAcceptanceIds.size > 0) {
      throw fail(
        CONTRACT_PREFLIGHT_ERROR_CODES.stepBindingInvalid,
        'Each declared step requires a non-empty acceptanceIds list',
        { ...details, stepId, field: 'acceptanceIds' },
      );
    }
    const unknownAcceptanceIds = stepAcceptanceIds.filter((id) => !acceptanceIds.has(id));
    if (unknownAcceptanceIds.length > 0) {
      throw fail(
        CONTRACT_PREFLIGHT_ERROR_CODES.stepBindingInvalid,
        `Declared step ${stepId} references unknown acceptance ids: ${unknownAcceptanceIds.join(', ')}`,
        { ...details, stepId, unknownAcceptanceIds },
      );
    }
    for (const id of stepAcceptanceIds) claimedAcceptanceIds.add(id);

    const stepObligationIds = Array.isArray(step.obligationIds)
      ? assertNonEmptyStringList(step.obligationIds, 'obligationIds', { ...details, stepId })
      : [];
    const unknownObligationIds = stepObligationIds.filter((id) => obligationIds.size > 0 && !obligationIds.has(id));
    if (unknownObligationIds.length > 0) {
      throw fail(
        CONTRACT_PREFLIGHT_ERROR_CODES.stepBindingInvalid,
        `Declared step ${stepId} references unknown obligation ids: ${unknownObligationIds.join(', ')}`,
        { ...details, stepId, unknownObligationIds },
      );
    }

    const expectedOutputs = Object.prototype.hasOwnProperty.call(step, 'expectedOutputs')
      ? assertNonEmptyStringList(step.expectedOutputs, 'expectedOutputs', { ...details, stepId })
      : [];
    if (detailedBindings && Object.prototype.hasOwnProperty.call(step, 'expectedOutputs') && expectedOutputs.length === 0) {
      throw fail(
        CONTRACT_PREFLIGHT_ERROR_CODES.stepBindingInvalid,
        'Each declared step requires a non-empty expectedOutputs list',
        { ...details, stepId, field: 'expectedOutputs' },
      );
    }
    normalizedSteps.push({ stepId, allowedPaths, acceptanceIds: stepAcceptanceIds, obligationIds: stepObligationIds, expectedOutputs });
  }

  const unclaimedAcceptanceIds: string[] = [...targetAcceptanceIds].filter((id) => !claimedAcceptanceIds.has(id));
  if (detailedBindings && targetAcceptanceIds.size > 0 && unclaimedAcceptanceIds.length > 0) {
    throw fail(
      CONTRACT_PREFLIGHT_ERROR_CODES.stepBindingInvalid,
      `Declared steps do not bind acceptance ids: ${unclaimedAcceptanceIds.join(', ')}`,
      { unclaimedAcceptanceIds, reason: 'acceptance-unbound' },
    );
  }

  return { valid: true, steps: normalizedSteps, detailedBindings };
};

const commandReferencesFor = (contract: ContractLike): string[] => {
  const refs: unknown[] = [];
  for (const acceptanceValue of Array.isArray(contract.acceptance) ? contract.acceptance as unknown[] : []) {
    const plan = asEvidencePlan(asAcceptance(acceptanceValue).evidencePlan);
    if (Array.isArray(plan.commandRefs)) refs.push(...plan.commandRefs);
    if (plan.commandRef) refs.push(plan.commandRef);
  }
  for (const verificationValue of Array.isArray(contract.requiredVerifications) ? contract.requiredVerifications as unknown[] : []) {
    if (typeof verificationValue === 'string') {
      refs.push(verificationValue);
      continue;
    }
    const verification = asRecord(verificationValue);
    if (verification.commandRef) refs.push(verification.commandRef);
    else if (Array.isArray(verification.commandRefs)) refs.push(...verification.commandRefs);
  }
  return [...new Set(refs.map(String).map((entry) => entry.trim()).filter(Boolean))];
};

export const validateVerificationCommands = ({
  contract = {},
  commands = null,
  strict = false,
}: ValidateVerificationCommandsInput = {}) => {
  const commandRefs = commandReferencesFor(contract);
  if (!Array.isArray(commands)) return { valid: true, commandRefs, declared: [], deferred: commandRefs, missing: [] };
  const known = new Set(commands.map((entry) => entry.commandRef).filter(Boolean).map(String));
  const declared = commandRefs.filter((ref) => known.has(ref));
  const missing = commandRefs.filter((ref) => !known.has(ref));
  if (strict && missing.length > 0) {
    throw fail(
      CONTRACT_PREFLIGHT_ERROR_CODES.verificationCommandMissing,
      `Task contract references verification commands not declared by the project: ${missing.join(', ')}`,
      { missing, commandRefs },
      'declare-project-verification-command',
      true,
    );
  }
  return { valid: true, commandRefs, declared, deferred: missing, missing };
};

export const preflightTaskContract = ({
  contract = {},
  projectRoot = process.cwd(),
  commands = null,
  obligations = [],
  requireImplementationScope = null,
  strictVerificationCommands = false,
  acceptanceIdMap = null,
  resolveRealpath,
  checkExists,
  lstatPath,
}: PreflightTaskContractInput = {}) => {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    throw fail(CONTRACT_PREFLIGHT_ERROR_CODES.invalid, 'Task contract must be an object', { reason: 'not-object' }, CONTRACT_PREFLIGHT_NEXT_ACTION, false);
  }

  const typedContract = contract as ContractLike;
  const declaredSteps = Array.isArray(typedContract.steps) && typedContract.steps.length > 0;
  const isImplementationTask = requireImplementationScope === null
    ? !READ_ONLY_TASK_CLASSES.has(String(typedContract.taskClass || '').toLowerCase())
    : Boolean(requireImplementationScope);
  const requiresScope = isImplementationTask && requiresImplementationWorkUnitScope({ contract: typedContract });
  let allowedPaths: string[] = [];
  if (Array.isArray(typedContract.allowedPaths)) {
    allowedPaths = normalizeBoundedPaths({
      paths: typedContract.allowedPaths,
      projectRoot,
      resolveRealpath,
      checkExists,
      lstatPath,
    });
    const scope = classifyWorkUnitScope({ allowedPaths, strict: typedContract.strictBoundedScope === true });
    if (requiresScope && !declaredSteps && !scope.valid) {
      const isSafety = scope.reason === 'path-traversal' || scope.scopeState === 'invalid';
      throw fail(scope.errorCode, scope.message, { scope }, scope.nextAction, !isSafety);
    }
  } else if (requiresScope && !declaredSteps) {
    const scope = classifyWorkUnitScope({ allowedPaths: [], strict: typedContract.strictBoundedScope === true });
    if (!scope.valid) {
      throw fail(scope.errorCode, scope.message, { scope }, scope.nextAction, true);
    }
  }

  const stepResult = validateDeclaredSteps({
    contract: typedContract,
    obligations,
    projectRoot,
    requireDetailedBindings: requiresScope ? true : null,
    acceptanceIdMap,
    resolveRealpath,
    checkExists,
    lstatPath,
  });
  const verification = validateVerificationCommands({
    contract: typedContract,
    commands,
    strict: strictVerificationCommands,
  });
  return {
    valid: true,
    required: requiresScope,
    declaredSteps,
    allowedPaths,
    steps: stepResult.steps,
    detailedStepBindings: stepResult.detailedBindings || false,
    verification,
  };
};
