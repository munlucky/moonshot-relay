import type { KernelTaskSnapshot } from '../../contracts/generated/kernel.task-snapshot.js';
import { parseKernelContract, KernelContractSchemaError } from '../../contracts/schema-codec.js';
import { requiredIndex } from '../../shared/required-index.js';
// Task Contract normalization and persistence (§8, P0-4/P0-5).
//
// The contract — objective, acceptance, constraints, non-goals, risks, and
// optional evidence refinements — is the run's authority. It is
// persisted verbatim in SQLite so a new process can resume without any chat
// history, and every acceptance criterion carries a stable id (AC-n) so
// evidence can be bound to it rather than to a free-text string.

import { createHash } from 'node:crypto';
import { assertNoRawSecret } from '../../shared/persistent-sanitizer.js';
import {
  normalizeCompletionOutcome,
  normalizeCompletionPredicate,
  outcomeForEvidenceMethod,
  type CompletionOutcome,
} from '../../contracts/completion-outcomes.js';
import { assertCurrentSeed } from '../../contracts/task-contract-seed.js';

const EVIDENCE_CLASSES = ['hard', 'judgment'] as const;
type EvidenceClass = typeof EVIDENCE_CLASSES[number];
type EvidenceLevel = 'work' | 'integration' | 'goal';
type UnknownRecord = Record<string, unknown>;

interface EvidencePlanInput extends UnknownRecord {
  class?: unknown;
  method?: unknown;
  commandRefs?: unknown;
  commandRef?: unknown;
  obligationId?: unknown;
  evidenceLevel?: unknown;
  scope?: unknown;
  freshnessInputs?: unknown;
  outcome?: unknown;
}

export type NormalizedEvidencePlan = NonNullable<NormalizedAcceptance['evidencePlan']>;

interface AcceptanceInput extends UnknownRecord {
  id?: unknown;
  acceptance?: unknown;
  statement?: unknown;
  evidencePlan?: unknown;
}

export type NormalizedAcceptance = KernelTaskSnapshot['acceptance'][number];

interface ObligationLike extends UnknownRecord {
  acceptanceIds?: unknown;
  obligationId?: unknown;
}

export interface ContractStep extends UnknownRecord {
  stepId?: unknown;
  acceptanceIds?: unknown;
  acceptanceCoverage?: unknown;
  coverage?: unknown;
  acceptanceMapping?: unknown;
  obligationIds?: unknown;
}

export interface TaskContractLike extends UnknownRecord {
  taskContractSeed?: unknown;
  seed?: unknown;
  objective?: unknown;
  acceptance?: unknown;
  acceptanceCriteria?: unknown;
  constraints?: unknown;
  nonGoals?: unknown;
  nonGoal?: unknown;
  risks?: unknown;
  surfaces?: unknown;
  taskClass?: unknown;
  riskTier?: unknown;
  proofTier?: unknown;
  requestedTier?: unknown;
  changeClass?: unknown;
  scopeExtension?: unknown;
  defectWithinScope?: unknown;
  replacement?: unknown;
  requiredObligations?: unknown;
  requiredVerifications?: unknown;
  completionPredicate?: unknown;
  requiredOutcomes?: unknown;
  steps?: unknown;
  supersededStepIds?: unknown;
  allowedPaths?: unknown;
  forbiddenPaths?: unknown;
  filesChanged?: unknown;
  strictBoundedScope?: unknown;
  changedPaths?: unknown;
  flags?: UnknownRecord;
  risk?: UnknownRecord;
  seedProvenance?: unknown;
  digest?: unknown;
}

export type NormalizedTaskContract = KernelTaskSnapshot;


interface ContractDigestSource {
  objective?: unknown;
  acceptance?: unknown;
  constraints?: unknown;
  nonGoals?: unknown;
  risks?: unknown;
  surfaces?: unknown;
  taskClass?: unknown;
  requestedTier?: unknown;
  changeClass?: unknown;
  scopeExtension?: unknown;
  defectWithinScope?: unknown;
  replacement?: unknown;
  requiredObligations?: unknown;
  requiredVerifications?: unknown;
  completionPredicate?: unknown;
  seedProvenance?: unknown;
  steps?: unknown;
  supersededStepIds?: unknown;
  allowedPaths?: unknown;
  forbiddenPaths?: unknown;
  flags?: unknown;
}

export class MissingEvidencePlanError extends Error {
  readonly code = 'MISSING_EVIDENCE_PLAN';
  readonly missing: string[];

  constructor(message: string, missing: string[]) {
    super(message);
    this.name = 'MissingEvidencePlanError';
    this.missing = missing;
  }
}

export class EvidencePlanBindingError extends Error {
  readonly code: string;
  readonly detail: UnknownRecord;

  constructor(code: string, message: string, detail: UnknownRecord = {}) {
    super(message);
    this.name = 'EvidencePlanBindingError';
    this.code = code;
    this.detail = detail;
  }
}

export class AcceptanceCoverageBindingError extends Error {
  readonly code: string;
  readonly detail: UnknownRecord;

  constructor(code: string, message: string, detail: UnknownRecord = {}) {
    super(message);
    this.name = 'AcceptanceCoverageBindingError';
    this.code = code;
    this.detail = detail;
  }
}

export class ContractBindingError extends Error {
  readonly code: string;
  readonly detail: UnknownRecord;

  constructor(code: string, message: string, detail: UnknownRecord = {}) {
    super(message);
    this.name = 'ContractBindingError';
    this.code = code;
    this.detail = detail;
  }
}

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' ? value as UnknownRecord : {}
);

const asStringList = (value: unknown): string[] => (
  Array.isArray(value) ? value : value ? [value] : []
)
  .map((item) => {
    if (typeof item === 'string') return item;
    const record = asRecord(item);
    return String(record.statement || record.text || '');
  })
  .map((item) => item.trim())
  .filter(Boolean);

export const normalizeEvidencePlan = (plan: unknown): NormalizedEvidencePlan | null => {
  if (!plan || typeof plan !== 'object') return null;
  const candidate = plan as EvidencePlanInput;
  if (candidate.outcome !== undefined && candidate.outcome !== null && !normalizeCompletionOutcome(candidate.outcome)) {
    throw new EvidencePlanBindingError(
      'EVIDENCE_PLAN_OUTCOME_INVALID',
      `Unsupported evidence outcome: ${candidate.outcome}`,
      { outcome: candidate.outcome },
    );
  }
  const commandRefs = [
    ...(Array.isArray(candidate.commandRefs) ? candidate.commandRefs : []),
    ...(candidate.commandRef ? [candidate.commandRef] : []),
  ].map(String).filter(Boolean);
  return {
    class: EVIDENCE_CLASSES.includes(candidate.class as EvidenceClass) ? candidate.class as EvidenceClass : null,
    method: candidate.method ? String(candidate.method) : null,
    commandRefs: [...new Set(commandRefs)],
    obligationId: candidate.obligationId ? String(candidate.obligationId) : null,
    evidenceLevel: ['work', 'integration', 'goal'].includes(String(candidate.evidenceLevel)) ? candidate.evidenceLevel as EvidenceLevel : null,
    scope: asStringList(candidate.scope),
    freshnessInputs: asStringList(candidate.freshnessInputs),
    outcome: normalizeCompletionOutcome(candidate.outcome) || outcomeForEvidenceMethod(candidate.method),
  };
};

// Acceptance may arrive as plain strings or structured objects. Evidence plans
// are optional refinements; the Kernel binds an unplanned criterion to the
// compiled proof-policy obligation.
export const normalizeAcceptance = (acceptance: unknown = []): NormalizedAcceptance[] => (Array.isArray(acceptance) ? acceptance : []).map((item: unknown, index: number) => {
  const id = `AC-${index + 1}`;
  if (typeof item === 'string') {
    return { id, statement: item.trim(), evidencePlan: null, structured: false };
  }
  if (item && typeof item === 'object') {
    const candidate = item as AcceptanceInput;
    const hasExplicitPlan = Object.prototype.hasOwnProperty.call(candidate, 'evidencePlan')
      && candidate.evidencePlan !== null
      && candidate.evidencePlan !== undefined;
    const evidencePlan = normalizeEvidencePlan(candidate.evidencePlan);
    if (hasExplicitPlan && (!evidencePlan || !evidencePlan.class)) {
      throw new MissingEvidencePlanError(
        `Evidence plan for ${candidate.id ? String(candidate.id) : id} must declare class`,
        [candidate.id ? String(candidate.id) : id],
      );
    }
    return {
      id: candidate.id ? String(candidate.id) : id,
      statement: String(candidate.acceptance || candidate.statement || '').trim(),
      evidencePlan,
      structured: true,
    };
  }
  return { id, statement: String(item), evidencePlan: null, structured: false };
});

export const assertEvidencePlans = (acceptance: unknown = []): NormalizedAcceptance[] => {
  return normalizeAcceptance(acceptance);
};

export const acceptanceStatements = (acceptance: unknown = []): string[] => normalizeAcceptance(acceptance).map((item) => item.statement).filter(Boolean);

const acceptanceIndex = ({
  contract = {},
  acceptanceCriteria = [],
}: { contract?: TaskContractLike | NormalizedTaskContract; acceptanceCriteria?: unknown[] } = {}) => {
  const rawAcceptance = Array.isArray(contract?.acceptance) && contract.acceptance.length > 0
    ? contract.acceptance
    : acceptanceCriteria;
  const items = normalizeAcceptance(rawAcceptance);
  const byToken = new Map<string, string>();
  const ambiguous = new Set<string>();
  const idCounts = new Map<string, number>();
  for (const item of items) idCounts.set(item.id, (idCounts.get(item.id) || 0) + 1);
  for (const item of items) {
    if ((idCounts.get(item.id) || 0) > 1) ambiguous.add(item.id);
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
export const normalizeAcceptanceCoverage = ({
  contract = {},
  acceptanceCriteria = [],
  obligation = null,
  coverage = [],
}: {
  contract?: TaskContractLike;
  acceptanceCriteria?: unknown[];
  obligation?: ObligationLike | null;
  coverage?: unknown;
} = {}): string[] => {
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

  const canonical = [...new Set(values.map((value) => byToken.get(value)).filter((id): id is string => Boolean(id)))];
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
export const assertEvidencePlanSubmission = (
  contract: TaskContractLike | NormalizedTaskContract = {},
  evidencePlans: unknown = [],
): Array<UnknownRecord & { acceptanceId: string; evidencePlan: NormalizedEvidencePlan }> => {
  if (!Array.isArray(evidencePlans)) {
    throw new EvidencePlanBindingError('EVIDENCE_PLANS_INVALID', 'evidencePlans must be an array');
  }
  const { items } = acceptanceIndex({ contract });
  const knownIds = new Set(items.map((item) => item.id));
  const seen = new Set<string>();
  const updates = new Map<string, UnknownRecord & { acceptanceId: string; evidencePlan: NormalizedEvidencePlan }>();
  const unknown: string[] = [];
  for (const rawValue of evidencePlans) {
    if (!rawValue || typeof rawValue !== 'object') {
      throw new EvidencePlanBindingError('EVIDENCE_PLAN_INVALID', 'Each evidence plan must be an object');
    }
    const raw = rawValue as UnknownRecord;
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
  'frontend', 'visualBehavior', 'browserProof', 'knowledgeRequired',
];

// The full contract the Kernel persists. Everything the model needs on resume
// must be reachable from this object alone.
export const normalizeTaskContract = (
  input: unknown = {},
  { objective, changedFileCount = 0 }: { objective?: unknown; changedFileCount?: number } = {},
): NormalizedTaskContract => {
  assertNoRawSecret(input);
  const contract: TaskContractLike = input && typeof input === 'object' ? input as TaskContractLike : {};
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
  const flags: Record<string, true> = {};
  for (const flag of RISK_FLAGS) {
    const value = contract[flag] === true
      || contract.flags?.[flag] === true
      || contract.risk?.[flag] === true;
    if (value) flags[flag] = true;
  }
  const rawCompletionPredicate = contract.completionPredicate || contract.requiredOutcomes;
  const completionPredicateInput = Array.isArray(rawCompletionPredicate)
    ? rawCompletionPredicate
    : rawCompletionPredicate && typeof rawCompletionPredicate === 'object'
      ? rawCompletionPredicate as { requiredOutcomes?: unknown[] }
      : null;
  const normalized = {
    schemaVersion: 1 as const,
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
      ? contract.requiredVerifications.map((item: unknown) => (item && typeof item === 'object' ? { ...item as UnknownRecord } : String(item)))
      : [],
    completionPredicate: normalizeCompletionPredicate(completionPredicateInput),
    // Standalone pre-work may provide a validated seed, but the seed remains
    // provenance only. It never becomes a completion, proof, review, or
    // knowledge authority inside Kernel.
    seedProvenance,
    // Work-unit scope (K1). Declared here so an Execution Capsule can bound a
    // worker to the paths the contract actually authorises; an empty list means
    // the whole workspace and can never be violated.
    // Declared decomposition (K2). Present only when the caller actually split
    // the work; otherwise the run gets one synthetic step.
    steps: Array.isArray(contract.steps) ? contract.steps as ContractStep[] : [],
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
  return parseKernelContract('kernel.task-snapshot', { ...normalized, digest: contractDigest(normalized) });
};

export const contractDigest = (contract: ContractDigestSource) => `sha256:${createHash('sha256').update(JSON.stringify({
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

export const surfacesFromFlags = (flags: Record<string, unknown> = {}): string[] => [...new Set(
  Object.entries(FLAG_SURFACES).filter(([flag]) => flags[flag] === true).map(([, surface]) => surface),
)];

const surfacesFromDeclaredRisks = (risks: unknown = []): string[] => [...new Set((Array.isArray(risks) ? risks : []).flatMap((risk: unknown) => {
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
export const riskSummaryFromContract = (contract: NormalizedTaskContract) => ({
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
// Persisted canonical contracts retain their original digest and seed receipt.
// Legacy snapshots pass through the existing normalizer only at this read boundary.
export const readTaskContractSnapshot = (input: unknown, objective?: string): NormalizedTaskContract => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return normalizeTaskContract(input, { objective });
  const value = input as Record<string, unknown>;
  if (value.schemaVersion === undefined) return normalizeTaskContract(value, { objective });
  try { return parseKernelContract('kernel.task-snapshot', value); }
  catch (error) {
    if (error instanceof KernelContractSchemaError) throw new Error('contract_rejected: invalid persisted Task Contract snapshot');
    throw error;
  }
};

export const contractBriefing = (contract: NormalizedTaskContract) => ({
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

const nextAcceptanceId = (items: NormalizedAcceptance[]): string => {
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
const mergeAcceptance = (
  previous: NormalizedAcceptance[] = [],
  next: NormalizedAcceptance[] = [],
): { acceptance: NormalizedAcceptance[]; idMap: Map<string, string> } => {
  const merged: NormalizedAcceptance[] = previous.map((item) => ({ ...item }));
  const indexByStatement = new Map<string, number>(merged.map((item, index) => [item.statement, index]));
  const idMap = new Map<string, string>();
  const previousIds = new Set<string>();
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
  const nextIds = new Set<string>();
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
      const existing = requiredIndex(merged, existingIndex);
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

const acceptanceIdSet = (acceptance: NormalizedAcceptance[] = []): Set<string> => new Set(acceptance.map((item) => String(item.id)));

const contractObligationIds = (contract: { requiredObligations?: string[]; acceptance?: NormalizedAcceptance[] } = {}): Set<string> => new Set([
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

const rebaseAcceptanceList = (
  values: unknown,
  idMap: Map<string, string>,
  canonicalIds: Set<string>,
  field: string,
  stepIndex: number,
): string[] => {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => {
    const token = String(value);
    const mapped = idMap.get(token);
    if (mapped !== undefined) return mapped;
    if (canonicalIds.has(token)) return token;
    throw new ContractBindingError(
      'CONTRACT_STEP_ACCEPTANCE_UNKNOWN',
      `Step ${stepIndex + 1} references unknown acceptance id ${token}`,
      { field, stepIndex, acceptanceId: token, knownAcceptanceIds: [...canonicalIds] },
    );
  }))];
};

const rebaseStepAcceptanceReferences = (
  steps: ContractStep[] = [],
  { idMap, canonicalIds, knownObligations }: {
    idMap: Map<string, string>;
    canonicalIds: Set<string>;
    knownObligations: Set<string>;
  },
): ContractStep[] => steps.map((step, stepIndex) => {
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
    nextStep.acceptanceMapping = step.acceptanceMapping.map((mapping: unknown) => {
      if (!mapping || typeof mapping !== 'object') return mapping;
      const mappingRecord = mapping as UnknownRecord;
      const acceptance = mappingRecord.acceptanceId || mappingRecord.acceptance;
      if (!acceptance) return mapping;
      const [canonical] = rebaseAcceptanceList([acceptance], idMap, canonicalIds, 'acceptanceMapping', stepIndex);
      return {
        ...mappingRecord,
        ...(mappingRecord.acceptanceId ? { acceptanceId: canonical } : {}),
        ...(mappingRecord.acceptance ? { acceptance: canonical } : {}),
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

const assertIntroducedBindingsAreClaimed = ({
  previous,
  next,
  merged,
  idMap,
  steps,
}: {
  previous: NormalizedTaskContract | null;
  next: NormalizedTaskContract;
  merged: { acceptance: NormalizedAcceptance[] };
  idMap: Map<string, string>;
  steps: ContractStep[];
}): void => {
  if (!Array.isArray(steps) || steps.length === 0) return;
  const claimedAcceptanceIds = new Set(steps.flatMap((step) => Array.isArray(step.acceptanceIds) ? step.acceptanceIds.map(String) : []));
  const previousIds = acceptanceIdSet(previous?.acceptance || []);
  const introducedAcceptanceIds = next.acceptance
    .map((item) => idMap.get(item.id))
    .filter((id): id is string => typeof id === 'string' && !previousIds.has(id));
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
  const claimedObligationIds = new Set(steps.flatMap((step) => Array.isArray(step.obligationIds) ? step.obligationIds.map(String) : []));
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

export const mergeContractRevisionWithBindings = (
  previous: NormalizedTaskContract | null | undefined,
  next: NormalizedTaskContract,
): { contract: NormalizedTaskContract; acceptanceIdMap: Record<string, string> } => {
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
  const union = (left: string[] = [], right: string[] = []): string[] => [...new Set([...left, ...right])];
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

  let mergedSteps: ContractStep[] = [];
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
      const indexById = new Map<string, number>();
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
          if (idx === undefined) throw new Error('contract_step_index_missing');
          mergedSteps[idx] = { ...mergedSteps[idx], ...nextStep };
        } else {
          mergedSteps.push(nextStep);
          if (id) indexById.set(id, mergedSteps.length - 1);
        }
      }
    }
  }

  const merged: NormalizedTaskContract = {
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
  const contract: NormalizedTaskContract = { ...merged, steps: mergedSteps, digest: contractDigest({ ...merged, steps: mergedSteps }) };
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
export const replaceContractRevisionWithBindings = (
  previous: NormalizedTaskContract | null | undefined,
  next: NormalizedTaskContract,
): { contract: NormalizedTaskContract; acceptanceIdMap: Record<string, string> } => {
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
  // Active replacements use the same semantic step contract as initial Runs.
  // Explicit step bindings are preserved and validated, while unclaimed goal
  // acceptance/obligations are settled on the final Work Unit by the planner.
  // The compatibility merge path remains strict for additive lineage merging.
  return { contract, acceptanceIdMap: Object.fromEntries(identity) };
};

// Compatibility export for callers that explicitly request a contract merge.
// Active Run lifecycle code uses replaceContractRevisionWithBindings instead.
export const mergeContractRevision = (
  previous: NormalizedTaskContract | null | undefined,
  next: NormalizedTaskContract,
): NormalizedTaskContract => {
  return mergeContractRevisionWithBindings(previous, next).contract;
};

// Merge model-supplied evidence plans (submitted from FRAME) into the stored
// contract. Returns null when nothing changed so callers can skip a revision.
const evidencePlanKey = (plan: unknown): string => {
  const normalized = normalizeEvidencePlan(plan);
  return normalized
    ? JSON.stringify({ ...normalized, commandRefs: [...normalized.commandRefs].sort() })
    : 'null';
};

export const applyEvidencePlans = (
  contract: NormalizedTaskContract,
  evidencePlans: unknown = [],
): NormalizedTaskContract | null => {
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
