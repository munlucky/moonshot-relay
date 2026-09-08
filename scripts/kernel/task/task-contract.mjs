// Task Contract normalization and persistence (§8, P0-4/P0-5).
//
// The contract — objective, acceptance, constraints, non-goals, risks, and
// optional evidence refinements — is the run's authority. It is
// persisted verbatim in SQLite so a new process can resume without any chat
// history, and every acceptance criterion carries a stable id (AC-n) so
// evidence can be bound to it rather than to a free-text string.

import { createHash } from 'node:crypto';
import { assertNoRawSecret } from '../persistent-sanitizer.mjs';
import {
  normalizeCompletionOutcome,
  normalizeCompletionPredicate,
  outcomeForEvidenceMethod,
} from '../run/completion-outcomes.mjs';
import { assertCurrentSeed } from '../standalone/prework.mjs';

const EVIDENCE_CLASSES = ['hard', 'judgment'];

export class MissingEvidencePlanError extends Error {
  constructor(message, missing) {
    super(message);
    this.name = 'MissingEvidencePlanError';
    this.code = 'MISSING_EVIDENCE_PLAN';
    this.missing = missing;
  }
}

export class EvidencePlanBindingError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'EvidencePlanBindingError';
    this.code = code;
    this.detail = detail;
  }
}

export class AcceptanceCoverageBindingError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'AcceptanceCoverageBindingError';
    this.code = code;
    this.detail = detail;
  }
}

export class ContractBindingError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ContractBindingError';
    this.code = code;
    this.detail = detail;
  }
}

const asStringList = (value) => (Array.isArray(value) ? value : value ? [value] : [])
  .map((item) => (typeof item === 'string' ? item : String(item?.statement || item?.text || '')))
  .map((item) => item.trim())
  .filter(Boolean);

export const normalizeEvidencePlan = (plan) => {
  if (!plan || typeof plan !== 'object') return null;
  if (plan.outcome !== undefined && plan.outcome !== null && !normalizeCompletionOutcome(plan.outcome)) {
    throw new EvidencePlanBindingError(
      'EVIDENCE_PLAN_OUTCOME_INVALID',
      `Unsupported evidence outcome: ${plan.outcome}`,
      { outcome: plan.outcome },
    );
  }
  const commandRefs = [
    ...(Array.isArray(plan.commandRefs) ? plan.commandRefs : []),
    ...(plan.commandRef ? [plan.commandRef] : []),
  ].map(String).filter(Boolean);
  return {
    class: EVIDENCE_CLASSES.includes(plan.class) ? plan.class : null,
    method: plan.method ? String(plan.method) : null,
    commandRefs: [...new Set(commandRefs)],
    obligationId: plan.obligationId ? String(plan.obligationId) : null,
    scope: asStringList(plan.scope),
    freshnessInputs: asStringList(plan.freshnessInputs),
    outcome: normalizeCompletionOutcome(plan.outcome) || outcomeForEvidenceMethod(plan.method),
  };
};

// Acceptance may arrive as plain strings or structured objects. Evidence plans
// are optional refinements; the Kernel binds an unplanned criterion to the
// compiled proof-policy obligation.
export const normalizeAcceptance = (acceptance = []) => (Array.isArray(acceptance) ? acceptance : []).map((item, index) => {
  const id = `AC-${index + 1}`;
  if (typeof item === 'string') {
    return { id, statement: item.trim(), evidencePlan: null, structured: false };
  }
  if (item && typeof item === 'object') {
    const hasExplicitPlan = Object.prototype.hasOwnProperty.call(item, 'evidencePlan')
      && item.evidencePlan !== null
      && item.evidencePlan !== undefined;
    const evidencePlan = normalizeEvidencePlan(item.evidencePlan);
    if (hasExplicitPlan && (!evidencePlan || !evidencePlan.class)) {
      throw new MissingEvidencePlanError(
        `Evidence plan for ${item.id ? String(item.id) : id} must declare class`,
        [item.id ? String(item.id) : id],
      );
    }
    return {
      id: item.id ? String(item.id) : id,
      statement: String(item.acceptance || item.statement || '').trim(),
      evidencePlan,
      structured: true,
    };
  }
  return { id, statement: String(item), evidencePlan: null, structured: false };
});

export const assertEvidencePlans = (acceptance = []) => {
  return normalizeAcceptance(acceptance);
};

export const acceptanceStatements = (acceptance = []) => normalizeAcceptance(acceptance).map((item) => item.statement).filter(Boolean);

const acceptanceIndex = ({ contract = {}, acceptanceCriteria = [] } = {}) => {
  const rawAcceptance = Array.isArray(contract?.acceptance) && contract.acceptance.length > 0
    ? contract.acceptance
    : acceptanceCriteria;
  const items = normalizeAcceptance(rawAcceptance);
  const byToken = new Map();
  const ambiguous = new Set();
  const idCounts = new Map();
  for (const item of items) idCounts.set(item.id, (idCounts.get(item.id) || 0) + 1);
  for (const item of items) {
    if (idCounts.get(item.id) > 1) ambiguous.add(item.id);
    else if (byToken.has(item.id) && byToken.get(item.id) !== item.id) ambiguous.add(item.id);
    else if (!ambiguous.has(item.id)) byToken.set(item.id, item.id);
    if (!item.statement) continue;
    if (byToken.has(item.statement) && byToken.get(item.statement) !== item.id) {
      ambiguous.add(item.statement);
    } else if (!ambiguous.has(item.statement) && !byToken.has(item.statement)) {
      byToken.set(item.statement, item.id);
    }
  }
  return { items, byToken, ambiguous };
};

// A report may use either an AC id or its legacy statement spelling, but the
// Kernel canonicalizes both to the immutable AC id before persistence. The
// coverage must also belong to the obligation that produced the evidence; a
// passing command for AC-1 cannot be re-labeled as proof for AC-2 (or AC-999).
export const normalizeAcceptanceCoverage = ({ contract = {}, acceptanceCriteria = [], obligation = null, coverage = [] } = {}) => {
  const values = (Array.isArray(coverage) ? coverage : coverage ? [coverage] : [])
    .map((value) => String(value).trim())
    .filter(Boolean);
  if (values.length === 0) return [];

  const { byToken, ambiguous } = acceptanceIndex({ contract, acceptanceCriteria });
  const unknown = values.filter((value) => !byToken.has(value) || ambiguous.has(value));
  if (unknown.length > 0) {
    throw new AcceptanceCoverageBindingError(
      'ACCEPTANCE_COVERAGE_UNKNOWN',
      `Acceptance coverage names an unknown or ambiguous criterion: ${unknown.join(', ')}`,
      { unknown },
    );
  }

  const canonical = [...new Set(values.map((value) => byToken.get(value)))];
  const boundAcceptanceIds = new Set(Array.isArray(obligation?.acceptanceIds) ? obligation.acceptanceIds.map(String) : []);
  const unrelated = canonical.filter((id) => !boundAcceptanceIds.has(id));
  if (unrelated.length > 0) {
    throw new AcceptanceCoverageBindingError(
      'ACCEPTANCE_COVERAGE_NOT_BOUND',
      `Acceptance coverage is not bound to obligation "${obligation?.obligationId || 'unknown'}": ${unrelated.join(', ')}`,
      { obligationId: obligation?.obligationId || null, unrelated, boundAcceptanceIds: [...boundAcceptanceIds] },
    );
  }
  return canonical;
};

// Evidence plans are optional refinements after FRAME. Do not silently drop an
// unknown AC or a malformed plan, but do not require a plan for every criterion:
// unplanned criteria bind to the compiled proof-policy obligation.
export const assertEvidencePlanSubmission = (contract = {}, evidencePlans = []) => {
  if (!Array.isArray(evidencePlans)) {
    throw new EvidencePlanBindingError('EVIDENCE_PLANS_INVALID', 'evidencePlans must be an array');
  }
  const { items } = acceptanceIndex({ contract });
  const knownIds = new Set(items.map((item) => item.id));
  const seen = new Set();
  const updates = new Map();
  const unknown = [];
  for (const raw of evidencePlans) {
    if (!raw || typeof raw !== 'object') {
      throw new EvidencePlanBindingError('EVIDENCE_PLAN_INVALID', 'Each evidence plan must be an object');
    }
    const acceptanceId = raw.acceptanceId || raw.id;
    if (!acceptanceId) {
      throw new EvidencePlanBindingError('EVIDENCE_PLAN_ACCEPTANCE_ID_REQUIRED', 'Each evidence plan requires acceptanceId');
    }
    const id = String(acceptanceId);
    if (!knownIds.has(id)) {
      unknown.push(id);
      continue;
    }
    if (seen.has(id)) {
      throw new EvidencePlanBindingError('EVIDENCE_PLAN_DUPLICATE', `Multiple evidence plans were supplied for ${id}`, { acceptanceId: id });
    }
    seen.add(id);
    const plan = normalizeEvidencePlan(raw.evidencePlan || raw);
    if (!plan || !plan.class) {
      throw new MissingEvidencePlanError(`Evidence plan for ${id} must declare class`, [id]);
    }
    updates.set(id, { ...raw, acceptanceId: id, evidencePlan: plan });
  }
  if (unknown.length > 0) {
    throw new EvidencePlanBindingError(
      'EVIDENCE_PLAN_UNKNOWN_ACCEPTANCE',
      `Evidence plans reference acceptance criteria that do not exist: ${unknown.join(', ')}`,
      { unknown },
    );
  }

  return [...updates.values()];
};

const RISK_FLAGS = [
  'behaviorChanging', 'publicContract', 'securityBoundary', 'authBoundary', 'dataMigration',
  'migration', 'dataStorageChange', 'externalIntegration', 'componentBoundaryChange',
  'irreversibleDecision', 'crossLayer', 'complex', 'newDependency', 'ambiguityChangesOutcome',
  'domainTerminologyConflict', 'destructiveSchemaChange', 'schemaChange', 'acceptanceAmbiguity',
  'baselineRequired', 'acceptanceUnverifiable', 'objectiveNonGoalConflict', 'architectureBoundary',
  'irreversibleDecision', 'independentDeliverables', 'longLivedResume', 'safeParallelSplit',
  'testSurfaceAvailable', 'repeatedFailure', 'repeatedBlocker', 'rootCauseAmbiguous',
  'frontend', 'visualBehavior', 'browserProof',
];

// The full contract the Kernel persists. Everything the model needs on resume
// must be reachable from this object alone.
export const normalizeTaskContract = (input = {}, { objective, changedFileCount = 0 } = {}) => {
  assertNoRawSecret(input);
  const contract = input && typeof input === 'object' ? input : {};
  const suppliedSeed = contract.taskContractSeed || contract.seed || null;
  const seed = suppliedSeed
    ? assertCurrentSeed(suppliedSeed, { objective: objective || contract.objective || null })
    : null;
  const seedProvenance = seed ? {
    kind: seed.kind,
    authority: seed.authority,
    seedDigest: seed.seedDigest,
    artifactDigest: seed.artifactDigest || null,
    sourceProvenance: seed.sourceProvenance || null,
    referencedArtifacts: Array.isArray(seed.referencedArtifacts) ? seed.referencedArtifacts : [],
  } : null;
  const acceptance = assertEvidencePlans(contract.acceptance || contract.acceptanceCriteria || []);
  const flags = {};
  for (const flag of RISK_FLAGS) {
    const value = contract[flag] === true || (contract.risk && typeof contract.risk === 'object' && contract.risk[flag] === true);
    if (value) flags[flag] = true;
  }
  const normalized = {
    schemaVersion: 1,
    objective: String(objective || contract.objective || 'Kernel execution task'),
    acceptance,
    constraints: asStringList(contract.constraints),
    nonGoals: asStringList(contract.nonGoals || contract.nonGoal),
    risks: asStringList(contract.risks),
    surfaces: asStringList(contract.surfaces),
    taskClass: String(contract.taskClass || 'feature'),
    requestedTier: contract.riskTier || contract.proofTier || contract.requestedTier || null,
    changeClass: typeof contract.changeClass === 'string' ? contract.changeClass : null,
    scopeExtension: contract.scopeExtension === true,
    defectWithinScope: contract.defectWithinScope === true,
    replacement: contract.replacement === true,
    requiredObligations: asStringList(contract.requiredObligations),
    requiredVerifications: Array.isArray(contract.requiredVerifications)
      ? contract.requiredVerifications.map((item) => (item && typeof item === 'object' ? { ...item } : String(item)))
      : [],
    completionPredicate: normalizeCompletionPredicate(contract.completionPredicate || contract.requiredOutcomes),
    // Standalone pre-work may provide a validated seed, but the seed remains
    // provenance only. It never becomes a completion, proof, review, or
    // knowledge authority inside Kernel.
    seedProvenance,
    // Work-unit scope (K1). Declared here so an Execution Capsule can bound a
    // worker to the paths the contract actually authorises; an empty list means
    // the whole workspace and can never be violated.
    // Declared decomposition (K2). Present only when the caller actually split
    // the work; otherwise the run gets one synthetic step.
    steps: Array.isArray(contract.steps) ? contract.steps : [],
    // Step removal is explicit. An omitted step is preserved; only these
    // stable IDs (or an explicit replacement) may retire one.
    supersededStepIds: [...new Set([
      ...(Array.isArray(contract.supersededStepIds) ? contract.supersededStepIds : []),
      ...(Array.isArray(contract.flags?.supersededStepIds) ? contract.flags.supersededStepIds : []),
    ].map(String).filter(Boolean))],
    allowedPaths: asStringList(contract.allowedPaths),
    forbiddenPaths: asStringList(contract.forbiddenPaths),
    filesChanged: Number.isFinite(contract.filesChanged) ? Number(contract.filesChanged) : changedFileCount,
    strictBoundedScope: contract.strictBoundedScope === true || flags.strictBoundedScope === true,
    flags,
  };
  return { ...normalized, digest: contractDigest(normalized) };
};

export const contractDigest = (contract) => `sha256:${createHash('sha256').update(JSON.stringify({
  objective: contract.objective,
  acceptance: contract.acceptance,
  constraints: contract.constraints,
  nonGoals: contract.nonGoals,
  risks: contract.risks,
  surfaces: contract.surfaces,
  taskClass: contract.taskClass,
  requestedTier: contract.requestedTier,
  changeClass: contract.changeClass,
  scopeExtension: contract.scopeExtension,
  defectWithinScope: contract.defectWithinScope,
  replacement: contract.replacement,
  requiredObligations: contract.requiredObligations,
  requiredVerifications: contract.requiredVerifications || [],
  completionPredicate: contract.completionPredicate,
  seedProvenance: contract.seedProvenance || null,
  steps: contract.steps,
  supersededStepIds: contract.supersededStepIds || [],
  allowedPaths: contract.allowedPaths,
  forbiddenPaths: contract.forbiddenPaths,
  flags: contract.flags,
})).digest('hex')}`;

// A declared risk flag names the same thing as a risk surface; mapping it
// makes the flag reach the tier resolver's hard floors instead of only
// influencing the route (P1-1).
const FLAG_SURFACES = Object.freeze({
  publicContract: 'public_contract',
  securityBoundary: 'security_boundary',
  authBoundary: 'security_boundary',
  dataMigration: 'data_migration',
  migration: 'data_migration',
  destructiveSchemaChange: 'destructive_schema_change',
  schemaChange: 'schema_change',
  runtimeAuthority: 'runtime_authority',
});

export const surfacesFromFlags = (flags = {}) => [...new Set(
  Object.entries(FLAG_SURFACES).filter(([flag]) => flags[flag] === true).map(([, surface]) => surface),
)];

const surfacesFromDeclaredRisks = (risks = []) => [...new Set(risks.flatMap((risk) => {
  const value = String(risk).toLowerCase();
  if (/(security|auth(?:entication|orization)?)/.test(value)) return ['security_boundary'];
  if (/migration/.test(value)) return ['data_migration'];
  if (/(data.?loss|data.?deletion|irreversible)/.test(value)) return ['destructive_schema_change'];
  if (/payment/.test(value)) return ['payment_boundary'];
  return [];
}))];

// The risk summary the proof-route and task-route resolvers consume. Behavior
// change is carried through so an ordinary behavior-changing task is not left
// at T0 (P1-1).
export const riskSummaryFromContract = (contract) => ({
  objective: contract.objective,
  acceptance: contract.acceptance,
  requiredVerifications: contract.requiredVerifications || [],
  changedPaths: contract.changedPaths || [],
  requestedTier: contract.requestedTier || undefined,
  filesChanged: contract.filesChanged,
  surfaces: [...new Set([...contract.surfaces, ...surfacesFromFlags(contract.flags), ...surfacesFromDeclaredRisks(contract.risks)])],
  taskClass: contract.taskClass,
  crossLayer: contract.flags.crossLayer === true,
  // Declared behaviour change reaches the tier resolver (P1-1); it is never
  // inferred, because guessing it would silently escalate every task to T1.
  behaviorChanging: contract.flags.behaviorChanging === true,
  complex: contract.flags.complex === true,
  ...contract.flags,
});

// The compact contract slice `kernel next` returns. Full contract stays in
// SQLite; the model sees what changes its decisions.
export const contractBriefing = (contract) => ({
  objective: contract.objective,
  acceptance: contract.acceptance.map((item) => ({
    id: item.id,
    statement: item.statement,
    evidence: item.evidencePlan?.class || null,
    evidencePlan: item.evidencePlan || null,
  })),
  constraints: contract.constraints,
  nonGoals: contract.nonGoals,
  risks: contract.risks,
  seedProvenance: contract.seedProvenance || null,
});

const nextAcceptanceId = (items) => {
  const used = new Set(items.map((item) => item.id));
  let index = items.length + 1;
  while (used.has(`AC-${index}`)) index += 1;
  return `AC-${index}`;
};

// Acceptance is merged by STATEMENT, never by id. Plain-string acceptance is
// numbered positionally, so `AC-1` means "the first criterion of whichever list
// was submitted" — merging on it would let a later, shorter list overwrite an
// earlier criterion in place (["A","B"] revised with ["C"] becoming ["C","B"]),
// silently dropping A and re-pointing A's existing evidence at C.
//
// A statement that already exists is refined in place (its plan may be filled
// in); a statement that does not is appended under a fresh id. Rewording a
// criterion therefore adds one rather than replacing one, which is the
// conservative direction: a revision can never shrink the completion gate.
const mergeAcceptance = (previous = [], next = []) => {
  const merged = previous.map((item) => ({ ...item }));
  const indexByStatement = new Map(merged.map((item, index) => [item.statement, index]));
  const idMap = new Map();
  const previousIds = new Set();
  for (const item of previous) {
    if (previousIds.has(item.id)) {
      throw new ContractBindingError(
        'CONTRACT_ACCEPTANCE_ID_DUPLICATE',
        `Previous contract contains duplicate acceptance id ${item.id}`,
        { acceptanceId: item.id },
      );
    }
    previousIds.add(item.id);
  }
  const nextIds = new Set();
  for (const item of next) {
    if (nextIds.has(item.id)) {
      throw new ContractBindingError(
        'CONTRACT_ACCEPTANCE_ID_DUPLICATE',
        `Successor contract contains duplicate acceptance id ${item.id}`,
        { acceptanceId: item.id },
      );
    }
    nextIds.add(item.id);
    const existingIndex = indexByStatement.get(item.statement);
    if (existingIndex !== undefined) {
      const existing = merged[existingIndex];
      merged[existingIndex] = { ...existing, evidencePlan: item.evidencePlan || existing.evidencePlan };
      idMap.set(item.id, existing.id);
      continue;
    }
    const appended = { ...item, id: nextAcceptanceId(merged) };
    indexByStatement.set(appended.statement, merged.length);
    merged.push(appended);
    idMap.set(item.id, appended.id);
  }
  return { acceptance: merged, idMap };
};

const acceptanceIdSet = (acceptance = []) => new Set(acceptance.map((item) => String(item.id)));

const contractObligationIds = (contract = {}) => new Set([
  ...(Array.isArray(contract.requiredObligations) ? contract.requiredObligations : []),
  ...(Array.isArray(contract.acceptance) ? contract.acceptance : [])
    .map((item) => item.evidencePlan?.obligationId)
    .filter(Boolean),
  // These are compiled from proof policy rather than declared in the compact
  // contract. A step may still name them explicitly without making the
  // contract invent a second obligation authority.
  'default',
  'static-analysis',
  'unit-test',
  'security-review',
].map(String));

const rebaseAcceptanceList = (values, idMap, canonicalIds, field, stepIndex) => {
  if (!Array.isArray(values)) return values;
  return [...new Set(values.map((value) => {
    const token = String(value);
    if (idMap.has(token)) return idMap.get(token);
    if (canonicalIds.has(token)) return token;
    throw new ContractBindingError(
      'CONTRACT_STEP_ACCEPTANCE_UNKNOWN',
      `Step ${stepIndex + 1} references unknown acceptance id ${token}`,
      { field, stepIndex, acceptanceId: token, knownAcceptanceIds: [...canonicalIds] },
    );
  }))];
};

const rebaseStepAcceptanceReferences = (steps = [], { idMap, canonicalIds, knownObligations }) => steps.map((step, stepIndex) => {
  const nextStep = { ...step };
  if (Array.isArray(step.acceptanceIds)) {
    nextStep.acceptanceIds = rebaseAcceptanceList(step.acceptanceIds, idMap, canonicalIds, 'acceptanceIds', stepIndex);
  }
  for (const field of ['acceptanceCoverage', 'coverage']) {
    if (Array.isArray(step[field])) {
      nextStep[field] = rebaseAcceptanceList(step[field], idMap, canonicalIds, field, stepIndex);
    }
  }
  if (Array.isArray(step.acceptanceMapping)) {
    nextStep.acceptanceMapping = step.acceptanceMapping.map((mapping) => {
      if (!mapping || typeof mapping !== 'object') return mapping;
      const acceptance = mapping.acceptanceId || mapping.acceptance;
      if (!acceptance) return mapping;
      const [canonical] = rebaseAcceptanceList([acceptance], idMap, canonicalIds, 'acceptanceMapping', stepIndex);
      return {
        ...mapping,
        ...(mapping.acceptanceId ? { acceptanceId: canonical } : {}),
        ...(mapping.acceptance ? { acceptance: canonical } : {}),
      };
    });
  }
  if (Array.isArray(step.obligationIds)) {
    const unknown = step.obligationIds.map(String).filter((id) => !knownObligations.has(id));
    if (unknown.length > 0) {
      throw new ContractBindingError(
        'CONTRACT_STEP_OBLIGATION_UNKNOWN',
        `Step ${stepIndex + 1} references unknown obligation(s): ${unknown.join(', ')}`,
        { stepIndex, obligationIds: unknown, knownObligationIds: [...knownObligations] },
      );
    }
    nextStep.obligationIds = [...new Set(step.obligationIds.map(String))];
  }
  return nextStep;
});

const assertIntroducedBindingsAreClaimed = ({ previous, next, merged, idMap, steps }) => {
  if (!Array.isArray(steps) || steps.length === 0) return;
  const claimedAcceptanceIds = new Set(steps.flatMap((step) => step.acceptanceIds || []));
  const previousIds = acceptanceIdSet(previous?.acceptance || []);
  const introducedAcceptanceIds = next.acceptance
    .map((item) => idMap.get(item.id))
    .filter((id) => id && !previousIds.has(id));
  const missingAcceptanceIds = [...new Set(introducedAcceptanceIds)].filter((id) => !claimedAcceptanceIds.has(id));
  if (missingAcceptanceIds.length > 0) {
    throw new ContractBindingError(
      'CONTRACT_STEP_ACCEPTANCE_OMITTED',
      `Successor step plan omits newly merged acceptance id(s): ${missingAcceptanceIds.join(', ')}`,
      {
        code: 'contract-step-binding-invalid',
        missingBindings: missingAcceptanceIds,
        repair: {
          preserveExistingSteps: true,
          appendOrPatchSteps: true,
        },
        missingAcceptanceIds,
        claimedAcceptanceIds: [...claimedAcceptanceIds],
      },
    );
  }

  const previousObligations = contractObligationIds(previous || {});
  const introducedObligations = [
    ...(next.requiredObligations || []),
    ...(next.acceptance || []).map((item) => item.evidencePlan?.obligationId).filter(Boolean),
  ].map(String).filter((id) => !previousObligations.has(id));
  const claimedObligationIds = new Set(steps.flatMap((step) => step.obligationIds || []).map(String));
  const missingObligationIds = [...new Set(introducedObligations)].filter((id) => !claimedObligationIds.has(id));
  if (missingObligationIds.length > 0) {
    throw new ContractBindingError(
      'CONTRACT_STEP_OBLIGATION_OMITTED',
      `Successor step plan omits newly merged obligation id(s): ${missingObligationIds.join(', ')}`,
      {
        code: 'contract-step-binding-invalid',
        missingBindings: missingObligationIds,
        repair: {
          preserveExistingSteps: true,
          appendOrPatchSteps: true,
        },
        missingObligationIds,
        claimedObligationIds: [...claimedObligationIds],
      },
    );
  }
  const mergedIds = acceptanceIdSet(merged.acceptance);
  const unclaimedCanonicalIds = [...mergedIds].filter((id) => !previousIds.has(id) && !claimedAcceptanceIds.has(id));
  if (unclaimedCanonicalIds.length > 0) {
    throw new ContractBindingError(
      'CONTRACT_STEP_ACCEPTANCE_OMITTED',
      `Successor step plan omits canonical acceptance id(s): ${unclaimedCanonicalIds.join(', ')}`,
      {
        code: 'contract-step-binding-invalid',
        missingBindings: unclaimedCanonicalIds,
        repair: {
          preserveExistingSteps: true,
          appendOrPatchSteps: true,
        },
        missingAcceptanceIds: unclaimedCanonicalIds,
        claimedAcceptanceIds: [...claimedAcceptanceIds],
      },
    );
  }
};

export const mergeContractRevisionWithBindings = (previous, next) => {
  if (!previous) {
    const canonicalIds = acceptanceIdSet(next?.acceptance || []);
    const knownObligations = contractObligationIds(next || {});
    const steps = rebaseStepAcceptanceReferences(next?.steps || [], {
      idMap: new Map((next?.acceptance || []).map((item) => [item.id, item.id])),
      canonicalIds,
      knownObligations,
    });
    const contract = { ...next, steps, digest: contractDigest({ ...next, steps }) };
    assertIntroducedBindingsAreClaimed({ previous: null, next, merged: contract, idMap: new Map((next?.acceptance || []).map((item) => [item.id, item.id])), steps });
    return { contract, acceptanceIdMap: Object.fromEntries((next?.acceptance || []).map((item) => [item.id, item.id])) };
  }
  const union = (left = [], right = []) => [...new Set([...left, ...right])];
  const mergedAcceptance = mergeAcceptance(previous.acceptance, next.acceptance);
  const canonicalIds = acceptanceIdSet(mergedAcceptance.acceptance);
  const knownObligations = contractObligationIds({ ...next, acceptance: mergedAcceptance.acceptance });

  const isReplacement = next.replacement === true || next.flags?.replacement === true;
  const supersededStepIds = new Set(
    [
      ...(Array.isArray(next.supersededStepIds) ? next.supersededStepIds : []),
      ...(Array.isArray(next.flags?.supersededStepIds) ? next.flags.supersededStepIds : []),
    ].map(String),
  );

  const rebasedNextSteps = Array.isArray(next.steps) && next.steps.length > 0
    ? rebaseStepAcceptanceReferences(next.steps, {
      idMap: mergedAcceptance.idMap,
      canonicalIds,
      knownObligations,
    })
    : [];

  let mergedSteps = [];
  if (isReplacement || !previous.steps?.length) {
    mergedSteps = rebasedNextSteps;
  } else if (!rebasedNextSteps.length) {
    mergedSteps = (previous.steps || []).filter((s) => !supersededStepIds.has(String(s.stepId || '')));
  } else {
    const hasAnyStepId = previous.steps.some((s) => s.stepId) || rebasedNextSteps.some((s) => s.stepId);
    if (!hasAnyStepId && previous.steps.length === 1 && rebasedNextSteps.length === 1) {
      mergedSteps = [{ ...previous.steps[0], ...rebasedNextSteps[0] }];
    } else {
      mergedSteps = [];
      const indexById = new Map();
      for (const prev of previous.steps) {
        const id = String(prev.stepId || '');
        if (id && supersededStepIds.has(id)) continue;
        const copy = { ...prev };
        mergedSteps.push(copy);
        if (id) indexById.set(id, mergedSteps.length - 1);
      }
      for (const nextStep of rebasedNextSteps) {
        const id = String(nextStep.stepId || '');
        if (id && indexById.has(id)) {
          const idx = indexById.get(id);
          mergedSteps[idx] = { ...mergedSteps[idx], ...nextStep };
        } else {
          mergedSteps.push(nextStep);
          if (id) indexById.set(id, mergedSteps.length - 1);
        }
      }
    }
  }

  const merged = {
    ...next,
    acceptance: mergedAcceptance.acceptance,
    constraints: union(previous.constraints, next.constraints),
    nonGoals: union(previous.nonGoals, next.nonGoals),
    risks: union(previous.risks, next.risks),
    surfaces: union(previous.surfaces, next.surfaces),
    requiredObligations: union(previous.requiredObligations, next.requiredObligations),
    completionPredicate: {
      requiredOutcomes: union(
        previous.completionPredicate?.requiredOutcomes,
        next.completionPredicate?.requiredOutcomes,
      ),
    },
    steps: mergedSteps,
    allowedPaths: union(previous.allowedPaths, next.allowedPaths),
    forbiddenPaths: union(previous.forbiddenPaths, next.forbiddenPaths),
    flags: { ...previous.flags, ...next.flags },
    filesChanged: Math.max(Number(previous.filesChanged) || 0, Number(next.filesChanged) || 0),
    requestedTier: next.requestedTier || previous.requestedTier,
    seedProvenance: next.seedProvenance || previous.seedProvenance || null,
  };

  assertIntroducedBindingsAreClaimed({ previous, next, merged, idMap: mergedAcceptance.idMap, steps: mergedSteps });
  const contract = { ...merged, steps: mergedSteps, digest: contractDigest({ ...merged, steps: mergedSteps }) };
  return {
    contract,
    acceptanceIdMap: Object.fromEntries(mergedAcceptance.idMap.entries()),
  };
};

// Active Run revisions are authoritative replacements, not additive contract
// merges. `mergeContractRevisionWithBindings` remains the compatibility path
// for successor creation, where a new Run may need to rebase local acceptance
// ids onto a predecessor's lineage. An active Run has a different rule: the
// latest compiled contract is the complete current Goal authority.
export const replaceContractRevisionWithBindings = (previous, next) => {
  if (!previous) {
    const identity = new Map((next?.acceptance || []).map((item) => [item.id, item.id]));
    const canonicalIds = acceptanceIdSet(next?.acceptance || []);
    const knownObligations = contractObligationIds(next || {});
    const steps = rebaseStepAcceptanceReferences(next?.steps || [], {
      idMap: identity,
      canonicalIds,
      knownObligations,
    });
    const contract = { ...next, steps, digest: contractDigest({ ...next, steps }) };
    return { contract, acceptanceIdMap: Object.fromEntries(identity) };
  }

  const identity = new Map((next?.acceptance || []).map((item) => [item.id, item.id]));
  const canonicalIds = acceptanceIdSet(next?.acceptance || []);
  const knownObligations = contractObligationIds(next || {});
  const explicitSteps = Array.isArray(next?.steps) && next.steps.length > 0;
  // An active replacement that omits `steps` intentionally falls back to the
  // synthetic plan built from the replacement contract. Retaining normalized
  // predecessor steps here would retain their old path authority and let a
  // later `next` issue work outside the replacement scope.
  const stepSource = explicitSteps ? next.steps : [];
  const steps = rebaseStepAcceptanceReferences(stepSource, {
    idMap: identity,
    canonicalIds,
    knownObligations,
  });
  const contract = {
    ...next,
    steps,
    // A replacement is allowed to remove acceptance, scope, obligations, and
    // other contract fields. History remains in SQLite evidence rows; only
    // this normalized contract is current authority.
    digest: contractDigest({ ...next, steps }),
  };
  if (explicitSteps) {
    assertIntroducedBindingsAreClaimed({ previous: null, next, merged: contract, idMap: identity, steps });
  }
  return { contract, acceptanceIdMap: Object.fromEntries(identity) };
};

// Compatibility export for callers that explicitly request a contract merge.
// Active Run lifecycle code uses replaceContractRevisionWithBindings instead.
export const mergeContractRevision = (previous, next) => {
  return mergeContractRevisionWithBindings(previous, next).contract;
};

// Merge model-supplied evidence plans (submitted from FRAME) into the stored
// contract. Returns null when nothing changed so callers can skip a revision.
const evidencePlanKey = (plan) => {
  const normalized = normalizeEvidencePlan(plan);
  return normalized
    ? JSON.stringify({ ...normalized, commandRefs: [...normalized.commandRefs].sort() })
    : 'null';
};

export const applyEvidencePlans = (contract, evidencePlans = []) => {
  if (!Array.isArray(evidencePlans) || evidencePlans.length === 0) return null;
  const submitted = assertEvidencePlanSubmission(contract, evidencePlans);
  const byId = new Map(submitted.map((plan) => [plan.acceptanceId, plan]));
  let changed = false;
  const acceptance = contract.acceptance.map((item) => {
    const update = byId.get(item.id);
    if (!update) return item;
    const plan = normalizeEvidencePlan(update.evidencePlan || update);
    if (!plan || !plan.class) return item;
    if (evidencePlanKey(item.evidencePlan) === evidencePlanKey(plan)) return item;
    changed = true;
    return { ...item, evidencePlan: plan };
  });
  if (!changed) return null;
  const next = { ...contract, acceptance };
  return { ...next, digest: contractDigest(next) };
};
