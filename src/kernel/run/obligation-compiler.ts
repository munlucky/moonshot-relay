import { requiredIndex } from '../../shared/required-index.js';
// Obligation compilation (P0-2/P0-3/P0-5).
//
// A run's obligations are fixed at start from the available authorities:
//   1. the proof policy's required checks for the resolved tier,
//   2. optional evidence plans for acceptance criteria,
//   3. committed Project Knowledge required_verification records,
//   4. obligations the caller explicitly declared.
//
// Each compiled obligation records HOW it may be satisfied — its evidence
// class and the exact set of project command refs that can prove it. Without
// this binding a model can name an obligation `unit-test` and satisfy it with
// any passing command, which is the false-completion path this closes.

import { KERNEL_POLICY } from '../policy.js';
import { isProtectedObligation } from '../proof/protected-obligations.js';
import { commandRefsForClasses } from '../../contracts/command-catalog.js';
import { matchPathScope } from '../../shared/path-scope.js';
import { cheapReVerify } from '../knowledge/freshness.js';
import type { ProjectCommand } from '../../contracts/project-command.js';

type UnknownRecord = Record<string, unknown>;

interface CommandCandidate {
  sourceType?: string | null;
  sourceRef?: string | null;
  commandRefs?: string[];
}

interface ScopeCandidate {
  sourceType?: string | null;
  sourceRef?: string | null;
  scope?: string[];
  freshnessInputs?: string[];
}

interface ObligationMetadata extends UnknownRecord {
  commandCandidates?: CommandCandidate[];
  scopeCandidates?: ScopeCandidate[];
  outcome?: unknown;
  outcomes?: unknown[];
  scope?: unknown;
  freshnessInputs?: unknown[];
  evidencePlanCommandBinding?: boolean;
  explicitCommandBinding?: boolean;
  explicitBindingSourceType?: string | null;
  rootProofRequired?: boolean;
  evidenceLevel?: unknown;
}

interface RejectedCommandRef {
  commandRef: string;
  reason: string;
}

interface ObligationLike extends UnknownRecord {
  obligationId: string;
  evidenceClass: string;
  verificationMethod?: string | null;
  allowedCommandRefs: string[];
  rejectedCommandRefs: RejectedCommandRef[];
  acceptanceIds: string[];
  protected?: boolean;
  sourceType?: string | null;
  sourceRef?: string | null;
  metadata?: ObligationMetadata;
  contractRevision?: number;
  satisfiable?: boolean;
}

interface EvidencePlanLike extends UnknownRecord {
  obligationId?: string | null;
  class?: string | null;
  commandRefs: string[];
  method?: string | null;
  outcome?: unknown;
  evidenceLevel?: unknown;
  scope?: unknown;
  freshnessInputs?: unknown[];
  timeoutMs?: unknown;
}

interface AcceptanceLike extends UnknownRecord {
  id: string;
  evidencePlan?: EvidencePlanLike | null;
}

interface TaskContractLike extends UnknownRecord {
  requiredObligations?: string[];
  requiredVerifications?: unknown[];
  acceptance?: AcceptanceLike[];
}

interface KnowledgeVerificationLike extends UnknownRecord {
  obligationId?: unknown;
  commandRefs?: unknown[];
  commandRef?: unknown;
  method?: unknown;
  scope?: unknown;
  evidenceLevel?: unknown;
  receiptContractRef?: unknown;
  freshnessInputs?: unknown[];
}

interface KnowledgeRecordLike extends UnknownRecord {
  id?: unknown;
  recordId?: unknown;
  type?: unknown;
  recordType?: unknown;
  status?: unknown;
  verification?: KnowledgeVerificationLike;
  recordJson?: { verification?: KnowledgeVerificationLike } & UnknownRecord;
  scope?: unknown;
  statement?: unknown;
  evidenceLevel?: unknown;
  receiptContractRef?: unknown;
  freshnessInputs?: unknown[];
  sourceRefs?: unknown[];
  sourceDigest?: unknown;
}

interface DeclareOptions {
  sourceType: string;
  sourceRef?: string | null;
  acceptanceIds?: string[];
  commandRefs?: string[] | null;
  evidenceClass?: string | null;
  method?: string | null;
  metadata?: ObligationMetadata | null;
}

interface MergeMetadataOptions {
  sourceType?: string | null;
  sourceRef?: string | null;
  allowedCommandRefs?: string[];
  candidateCommandRefs?: string[] | null;
  addCommandCandidate?: boolean;
}

interface CompileRunObligationsInput {
  projectRoot?: string;
  requiredChecks?: string[];
  contract?: TaskContractLike | null;
  contractRevision?: number;
  commands?: ProjectCommand[] | null;
  knowledgeRecords?: KnowledgeRecordLike[];
  changedPaths?: string[];
}

interface UnsupportedVerification extends UnknownRecord {
  obligationId?: string;
  sourceType?: (string | null) | undefined;
  verificationMethod?: (string | null) | undefined;
  rejectedCommandRefs?: RejectedCommandRef[];
  outcome?: unknown;
  reason?: string;
}

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);
import {
  authoritativeVerificationScope,
  deriveVerificationSettlementScope,
  deriveEvidenceLevel,
} from '../../contracts/verification-settlement.js';

export class ObligationBindingError extends Error {
  readonly code: string;
  readonly detail: UnknownRecord;

  constructor(code: string, message: string, detail: UnknownRecord = {}) {
    super(message);
    this.name = 'ObligationBindingError';
    this.code = code;
    this.detail = detail;
  }
}

const DEFAULT_OBLIGATION_POLICY = Object.freeze({
  evidenceClass: 'hard',
  commandClasses: [
    'unit-test',
    'integration-test',
    'e2e',
    'static-analysis',
    'build',
    'runtime-reproduction',
    'runtime-observation',
    'deployment',
    'post-deployment-observation',
    'script',
  ],
});

// An evidence plan names how a criterion will be proven. Its command refs are
// therefore subject to the SAME classification check as a policy obligation —
// otherwise a plan saying `{ class: 'hard', method: 'unit-test',
// commandRefs: ['noop'] }` would bind a no-op script as hard evidence and walk
// straight around the binding that P0-2 exists to enforce.
// Matching is by family, not by exact class. Classification is name-based, so
// a project's `test:auth` script reads as `unit-test` even when it is really
// the integration test — demanding an exact class match would reject honest
// plans and push callers to mislabel their method. Families are coarse enough
// to avoid that while still refusing a plainly wrong binding (a linter standing
// in for a browser scenario) and, above all, a `script` that proves nothing.
const TEST_CLASSES = Object.freeze(['unit-test', 'integration-test', 'e2e']);
const ANALYSIS_CLASSES = Object.freeze(['static-analysis', 'build']);
const RUNTIME_CLASSES = Object.freeze([
  'runtime-reproduction',
  'runtime-observation',
  'deployment',
  'post-deployment-observation',
]);
const PROOF_COMMAND_CLASSES = Object.freeze([...TEST_CLASSES, ...ANALYSIS_CLASSES, ...RUNTIME_CLASSES]);

const METHOD_FAMILIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'unit-test': TEST_CLASSES,
  unit: TEST_CLASSES,
  'integration-test': TEST_CLASSES,
  integration: TEST_CLASSES,
  e2e: TEST_CLASSES,
  'browser-scenario': TEST_CLASSES,
  scenario: TEST_CLASSES,
  'static-analysis': ANALYSIS_CLASSES,
  lint: ANALYSIS_CLASSES,
  typecheck: ANALYSIS_CLASSES,
  build: ANALYSIS_CLASSES,
  'runtime-reproduction': ['runtime-reproduction'],
  'runtime-observation': ['runtime-observation', 'post-deployment-observation'],
  deployment: ['deployment'],
  'post-deployment-observation': ['post-deployment-observation'],
});

// Command and freshness scope authority follow the same ordering. The
// metadata is stored on the existing obligation row, while the selected
// command and current scope digest remain derived values.
const SOURCE_PRIORITY: Readonly<Record<string, number>> = Object.freeze({
  'evidence-plan': 0,
  knowledge: 1,
  caller: 2,
  'proof-policy': 3,
  'ad-hoc': 4,
});

const sourcePriority = (sourceType: unknown): number => SOURCE_PRIORITY[String(sourceType)] ?? 99;
const normalizeScope = (scope: unknown): string[] => (Array.isArray(scope)
  ? [...new Set(scope.map(String).map((entry) => entry.trim()).filter(Boolean))].sort()
  : []);

const mergeObligationMetadata = (existing: ObligationMetadata = {}, incoming: ObligationMetadata = {}, {
  sourceType = null,
  sourceRef = null,
  allowedCommandRefs = [],
  candidateCommandRefs = null,
  addCommandCandidate = false,
}: MergeMetadataOptions = {}): ObligationMetadata => {
  const merged: ObligationMetadata = { ...(existing || {}) };
  for (const [key, value] of Object.entries(incoming || {})) {
    if (key === 'commandCandidates' || key === 'scopeCandidates') continue;
    if (key === 'outcome' && !value) continue;
    if (key === 'scope' && normalizeScope(value).length === 0) continue;
    if (key === 'freshnessInputs' && (!Array.isArray(value) || value.length === 0)) continue;
    merged[key] = value;
  }

  const commandCandidates = [
    ...(Array.isArray(existing?.commandCandidates) ? existing.commandCandidates : []),
    ...(addCommandCandidate && (candidateCommandRefs || allowedCommandRefs).length > 0 ? [{
      sourceType,
      sourceRef: sourceRef || null,
      commandRefs: [...new Set((candidateCommandRefs || allowedCommandRefs).map(String))],
    }] : []),
  ];
  const uniqueCommands = commandCandidates.filter((candidate, index, all) => (
    all.findIndex((other) => JSON.stringify({
      sourceType: other.sourceType,
      sourceRef: other.sourceRef || null,
      commandRefs: [...new Set((other.commandRefs || []).map(String))],
    }) === JSON.stringify({
      sourceType: candidate.sourceType,
      sourceRef: candidate.sourceRef || null,
      commandRefs: [...new Set((candidate.commandRefs || []).map(String))],
    })) === index
  ));
  if (uniqueCommands.length > 0) merged.commandCandidates = uniqueCommands;

  const incomingScope = normalizeScope(incoming?.scope);
  const scopeCandidates = [
    ...(Array.isArray(existing?.scopeCandidates) ? existing.scopeCandidates : []),
    ...(incomingScope.length > 0 ? [{
      sourceType,
      sourceRef: sourceRef || null,
      scope: incomingScope,
      freshnessInputs: Array.isArray(incoming?.freshnessInputs)
        ? [...new Set(incoming.freshnessInputs.map(String))]
        : [],
    }] : []),
  ];
  const uniqueScopes = scopeCandidates.filter((candidate, index, all) => (
    all.findIndex((other) => JSON.stringify({
      sourceType: other.sourceType,
      sourceRef: other.sourceRef || null,
      scope: normalizeScope(other.scope),
      freshnessInputs: [...new Set((other.freshnessInputs || []).map(String))].sort(),
    }) === JSON.stringify({
      sourceType: candidate.sourceType,
      sourceRef: candidate.sourceRef || null,
      scope: normalizeScope(candidate.scope),
      freshnessInputs: [...new Set((candidate.freshnessInputs || []).map(String))].sort(),
    })) === index
  ));
  if (uniqueScopes.length > 0) merged.scopeCandidates = uniqueScopes;

  const outcomes = new Set([
    ...(Array.isArray(existing?.outcomes) ? existing.outcomes : []),
    ...(existing?.outcome ? [existing.outcome] : []),
    ...(incoming?.outcome ? [incoming.outcome] : []),
  ]);
  if (outcomes.size > 0) {
    merged.outcome = outcomes.size === 1 ? [...outcomes][0] : null;
    merged.outcomes = [...outcomes];
  }
  return merged;
};

const orderedCandidates = (candidates: CommandCandidate[] = []): CommandCandidate[] => [...candidates]
  .filter((candidate) => candidate && typeof candidate === 'object')
  .sort((left, right) => (
    sourcePriority(left.sourceType) - sourcePriority(right.sourceType)
      || String(left.sourceRef || '').localeCompare(String(right.sourceRef || ''))
  ));

const projectCommandRefs = (commands: ProjectCommand[] | null | undefined): Set<string> | null => (Array.isArray(commands)
  ? new Set(commands.map((command) => String(command?.commandRef || '')).filter(Boolean))
  : null);

// The selected command is derived at execution time from the highest
// authority that supplied a usable candidate. `allowedCommandRefs` remains a
// compatibility/anti-forgery allowlist; it is not the selection policy. A
// report hint may choose a command only within that highest-authority
// candidate; it cannot promote a lower-authority command over an explicit
// evidence plan or Project Knowledge binding.
export const selectBoundCommandRef = (obligation: ObligationLike | null | undefined, { projectCommands = null, preferredCommandRef = null }: { projectCommands?: ProjectCommand[] | null; preferredCommandRef?: (string | null) | undefined } = {}): string | null => {
  if (!obligation || obligation.evidenceClass === 'judgment') return null;
  const allowed = new Set((obligation.allowedCommandRefs || []).map(String));
  const declaredProjectRefs = projectCommandRefs(projectCommands);
  const usableCandidates = orderedCandidates(obligation.metadata?.commandCandidates || [])
    .map((candidate) => (Array.isArray(candidate.commandRefs) ? candidate.commandRefs : [])
      .map(String)
      .filter((ref) => allowed.has(ref) && (!declaredProjectRefs || declaredProjectRefs.has(ref))))
    .filter((commandRefs) => commandRefs.length > 0);
  if (usableCandidates.length > 0) {
    const highestAuthority = requiredIndex(usableCandidates, 0);
    const preferred = preferredCommandRef === null || preferredCommandRef === undefined
      ? null
      : String(preferredCommandRef);
    return (preferred && highestAuthority.includes(preferred))
      ? preferred
      : requiredIndex(highestAuthority, 0);
  }
  const preferred = preferredCommandRef === null || preferredCommandRef === undefined
    ? null
    : String(preferredCommandRef);
  if (preferred && allowed.has(preferred) && (!declaredProjectRefs || declaredProjectRefs.has(preferred))) return preferred;
  for (const commandRef of obligation.allowedCommandRefs || []) {
    const ref = String(commandRef);
    if (!declaredProjectRefs || declaredProjectRefs.has(ref)) return ref;
  }
  return null;
};

// Commands may be added or updated during EXECUTE before PROVE is entered.
// Refresh proof-policy bindings as well as deferred explicit/evidence-plan
// command candidates against the current project command catalog.
export const refreshVerificationBindings = ({ obligations = [], projectRoot = process.cwd(), commands = null }: { obligations?: ObligationLike[]; projectRoot?: string; commands?: ProjectCommand[] | null } = {}): ObligationLike[] => {
  const projectCommands = Array.isArray(commands) ? commands : [];
  return obligations.map((obligation) => {
    if (!obligation || obligation.evidenceClass === 'judgment') return obligation;
    const policy = obligationPolicyFor(obligation.obligationId);

    // 1. Proof-policy obligation without explicit narrowing
    if (obligation.sourceType === 'proof-policy' && obligation.metadata?.evidencePlanCommandBinding !== true && obligation.metadata?.explicitCommandBinding !== true) {
      const allowedCommandRefs = commandRefsForClasses({ classes: policy.commandClasses, commands: projectCommands });
      const nonPolicyCandidates = (obligation.metadata?.commandCandidates || [])
        .filter((candidate) => candidate?.sourceType !== 'proof-policy');
      const nonPolicyRefs = nonPolicyCandidates.flatMap((candidate) => candidate.commandRefs || []);
      const metadata = mergeObligationMetadata(
        { ...(obligation.metadata || {}), commandCandidates: nonPolicyCandidates },
        {},
        {
          sourceType: 'proof-policy',
          sourceRef: 'kernel/proof-policy.yaml',
          allowedCommandRefs,
          addCommandCandidate: true,
        },
      );
      return {
        ...obligation,
        allowedCommandRefs: [...new Set([...nonPolicyRefs, ...allowedCommandRefs])],
        rejectedCommandRefs: [],
        metadata,
        satisfiable: nonPolicyRefs.length > 0 || allowedCommandRefs.length > 0,
      };
    }

    // 2. Explicit command candidates (from evidence-plan or caller requiredVerifications)
    const candidates = obligation.metadata?.commandCandidates || [];
    if (candidates.length > 0) {
      // A reused obligation can retain candidates from a lower-authority
      // proof-policy/caller declaration. Once an evidence plan (or another
      // higher-authority explicit binding) exists, refresh only candidates at
      // that highest source priority; otherwise a late refresh would widen a
      // deliberately narrowed obligation back to an unrelated command.
      const highestPriority = Math.min(...candidates.map((candidate) => sourcePriority(candidate?.sourceType)));
      const authoritativeCandidates = candidates.filter((candidate) => sourcePriority(candidate?.sourceType) === highestPriority);
      const permitted = new Set(classesForEvidenceMethod(obligation.verificationMethod));
      const newlyAllowed: string[] = [];
      const rejectedCommandRefs: RejectedCommandRef[] = [];
      for (const candidate of authoritativeCandidates) {
        for (const ref of candidate.commandRefs || []) {
          const command = projectCommands.find((entry) => entry.commandRef === ref);
          if (!command) {
            rejectedCommandRefs.push({ commandRef: ref, reason: 'not-declared-by-project' });
          } else if (!permitted.has(command.commandClass)) {
            rejectedCommandRefs.push({ commandRef: ref, reason: `class-${command.commandClass}-does-not-prove-${obligation.verificationMethod || 'this-obligation'}` });
          } else {
            newlyAllowed.push(ref);
          }
        }
      }
      const uniqueAllowed = [...new Set(newlyAllowed)];
      return {
        ...obligation,
        allowedCommandRefs: uniqueAllowed,
        rejectedCommandRefs,
        satisfiable: uniqueAllowed.length > 0,
      };
    }

    // An explicit evidence-plan/caller binding with no surviving candidate is
    // still an authoritative binding. This happens when every declared ref
    // was missing or had the wrong semantic class at Run creation. Do not
    // reinterpret that empty result as an implicit proof-policy obligation:
    // doing so would let a later, unrelated project command satisfy a plan
    // that explicitly named no usable command.
    if (obligation.metadata?.evidencePlanCommandBinding === true
      || obligation.metadata?.explicitCommandBinding === true) {
      return {
        ...obligation,
        allowedCommandRefs: [],
        satisfiable: false,
      };
    }

    // 3. Fallback for obligations without explicit candidates
    const allowedCommandRefs = commandRefsForClasses({
      classes: obligation.verificationMethod ? classesForEvidenceMethod(obligation.verificationMethod) : policy.commandClasses,
      commands: projectCommands,
    });
    return {
      ...obligation,
      allowedCommandRefs: [...new Set(allowedCommandRefs)],
      rejectedCommandRefs: [],
      satisfiable: allowedCommandRefs.length > 0,
    };
  });
};

export const rebindProofPolicyCommands = refreshVerificationBindings;

export class UnsupportedVerificationError extends Error {
  readonly code = 'unsupported-verification';
  readonly errorCode = 'unsupported-verification';
  readonly nextAction = 'declare-project-verification-command';
  readonly details: { unsupported: UnsupportedVerification[] };

  constructor(unsupported: UnsupportedVerification[] = []) {
    super('unsupported-verification');
    this.name = 'UnsupportedVerificationError';
    this.details = { unsupported };
  }
}

export const assertVerificationSupport = (obligations: ObligationLike[] = [], { completionPredicate = null }: { completionPredicate?: ({ requiredOutcomes?: unknown[] } | null) | undefined } = {}, { projectMode = null }: { projectMode?: string | null } = {}): ObligationLike[] => {
  const unsupported: UnsupportedVerification[] = obligations
    .filter((item) => (
      item.evidenceClass === 'hard'
      && item.satisfiable === false
      // A genuine greenfield Run must be able to create its walking skeleton
      // and manifest before proof-policy commands can exist. Only implicit
      // policy obligations are deferred; caller/AC command bindings still
      // fail before Run creation when they are missing or incompatible.
      && !(projectMode === 'greenfield' && item.sourceType === 'proof-policy')
    ))
    .map((item) => ({
      obligationId: item.obligationId,
      sourceType: item.sourceType,
      verificationMethod: item.verificationMethod,
      rejectedCommandRefs: item.rejectedCommandRefs || [],
    }));
  const requiredOutcomes = completionPredicate?.requiredOutcomes || [];
  for (const outcome of requiredOutcomes) {
    if (outcome === 'implemented') continue;
    const bound = obligations.some((item) => (
      item.metadata?.outcome === outcome
      || item.metadata?.outcomes?.includes(outcome)
    ));
    if (!bound) {
      unsupported.push({
        outcome,
        verificationMethod: 'completion-predicate',
        rejectedCommandRefs: [],
        reason: 'required-outcome-has-no-bound-evidence-plan',
      });
    }
  }
  if (unsupported.length > 0) throw new UnsupportedVerificationError(unsupported);
  return obligations;
};

// With no declared method, any command that proves something is acceptable —
// but never a plain `script`, which carries no semantic claim at all.
export const classesForEvidenceMethod = (method: unknown): readonly string[] => METHOD_FAMILIES[String(method || '').toLowerCase()] || PROOF_COMMAND_CLASSES;

export const obligationPolicyFor = (obligationId: string): { evidenceClass: string; commandClasses: readonly string[] } => {
  const policy = asRecord(asRecord(KERNEL_POLICY).obligations)[obligationId] as UnknownRecord | undefined;
  if (!policy) return DEFAULT_OBLIGATION_POLICY;
  return {
    evidenceClass: policy.evidenceClass === 'judgment' ? 'judgment' : 'hard',
    commandClasses: Array.isArray(policy.commandClasses) ? policy.commandClasses : DEFAULT_OBLIGATION_POLICY.commandClasses,
  };
};

const obligationForAcceptancePlan = (item: AcceptanceLike, tierObligations: string[]): string | null => {
  const plan = item.evidencePlan;
  if (!plan) return null;
  if (plan.obligationId) return plan.obligationId;
  if (plan.class === 'judgment') return `judgment-${item.id.toLowerCase()}`;
  if (plan.commandRefs.length > 0) return `acceptance-${item.id.toLowerCase()}`;
  // A hard plan with no command of its own rides on the tier's obligations.
  return tierObligations[0] || 'default';
};

// Compiles the immutable obligation set for a run.
export const compileRunObligations = ({
  projectRoot = process.cwd(),
  requiredChecks = ['default'],
  contract,
  contractRevision = 1,
  commands = null,
  knowledgeRecords = [],
  changedPaths = [],
}: CompileRunObligationsInput = {}): ObligationLike[] => {
  const projectCommands: ProjectCommand[] = Array.isArray(commands) ? commands : [];
  const tierObligations: string[] = [...requiredChecks];
  const compiled = new Map<string, ObligationLike>();

  const declare = (obligationId: string, { sourceType, sourceRef = null, acceptanceIds = [], commandRefs = null, evidenceClass = null, method = null, metadata = null }: DeclareOptions): ObligationLike => {
    const policy = obligationPolicyFor(obligationId);
    const resolvedClass = evidenceClass || policy.evidenceClass;
    const hasExplicitPlanCommands = sourceType === 'evidence-plan'
      && resolvedClass !== 'judgment'
      && Array.isArray(commandRefs)
      && commandRefs.length > 0;
    const hasExplicitCommandRefs = resolvedClass !== 'judgment'
      && Array.isArray(commandRefs)
      && commandRefs.length > 0;

    // Command refs requested by an evidence plan are filtered against the
    // catalog and the classes the plan's own method implies. A ref that the
    // project does not declare, or that carries no matching semantic class, is
    // rejected rather than trusted.
    const rejectedCommandRefs: RejectedCommandRef[] = [];
    let allowed: string[];
    if (resolvedClass === 'judgment') {
      allowed = [];
    } else if (commandRefs && commandRefs.length > 0) {
      const permitted = new Set(classesForEvidenceMethod(method));
      allowed = [];
      for (const ref of commandRefs) {
        const command = projectCommands.find((entry) => entry.commandRef === ref);
        if (!command) {
          rejectedCommandRefs.push({ commandRef: ref, reason: 'not-declared-by-project' });
        } else if (!permitted.has(command.commandClass)) {
          rejectedCommandRefs.push({ commandRef: ref, reason: `class-${command.commandClass}-does-not-prove-${method || 'this-obligation'}` });
        } else {
          allowed.push(ref);
        }
      }
    } else {
      allowed = commandRefsForClasses({
        classes: method ? classesForEvidenceMethod(method) : policy.commandClasses,
        commands: projectCommands,
      });
    }

    const existing = compiled.get(obligationId);
    if (existing) {
      existing.acceptanceIds = [...new Set([...existing.acceptanceIds, ...acceptanceIds])];
      existing.metadata = mergeObligationMetadata(existing.metadata, metadata || {}, {
        sourceType,
        sourceRef,
        allowedCommandRefs: allowed,
        candidateCommandRefs: hasExplicitCommandRefs ? commandRefs : null,
        addCommandCandidate: hasExplicitCommandRefs || sourceType === 'proof-policy',
      });
      const currentSourcePriority = sourcePriority(existing.sourceType);
      if (sourcePriority(sourceType) < currentSourcePriority) {
        existing.sourceType = sourceType;
        existing.sourceRef = sourceRef;
        if (method) existing.verificationMethod = method;
      }
      // A plan that explicitly reuses a policy/caller obligation must narrow
      // that obligation to the commands the plan named. Otherwise the tier's
      // broad allowlist (for example every unit-test script) lets an
      // unplanned command satisfy an AC. Multiple explicit plans may share an
      // obligation, so later plans add only their own validated refs.
      if (hasExplicitPlanCommands) {
        const bindingAlreadyNarrowed = existing.metadata?.evidencePlanCommandBinding === true;
        existing.allowedCommandRefs = bindingAlreadyNarrowed
          ? [...new Set([...existing.allowedCommandRefs, ...allowed])]
          : [...new Set(allowed)];
        const rejected = [...(existing.rejectedCommandRefs || []), ...rejectedCommandRefs];
        existing.rejectedCommandRefs = rejected.filter((entry, index, all) => all.findIndex((candidate) => candidate.commandRef === entry.commandRef && candidate.reason === entry.reason) === index);
        existing.metadata = { ...(existing.metadata || {}), evidencePlanCommandBinding: true };
        existing.sourceType = 'evidence-plan';
        existing.sourceRef = existing.sourceRef || sourceRef;
        if (method) existing.verificationMethod = method;
      } else if (hasExplicitCommandRefs
        && sourceType !== 'proof-policy'
        && existing.metadata?.evidencePlanCommandBinding !== true) {
        const priorSource = existing.metadata?.explicitBindingSourceType || null;
        const priorPriority = sourcePriority(priorSource);
        if (!priorSource || sourcePriority(sourceType) < priorPriority) {
          existing.allowedCommandRefs = [...new Set(allowed)];
        } else if (sourcePriority(sourceType) === priorPriority) {
          existing.allowedCommandRefs = [...new Set([...existing.allowedCommandRefs, ...allowed])];
        }
        existing.metadata = {
          ...(existing.metadata || {}),
          explicitCommandBinding: true,
          explicitBindingSourceType: !priorSource || sourcePriority(sourceType) <= priorPriority ? sourceType : priorSource,
        };
      } else if (existing.metadata?.evidencePlanCommandBinding !== true) {
        existing.allowedCommandRefs = [...new Set([...existing.allowedCommandRefs, ...allowed])];
      }
      existing.rejectedCommandRefs = [...new Set([
        ...(existing.rejectedCommandRefs || []),
        ...rejectedCommandRefs,
      ].map((entry) => JSON.stringify(entry)))].map((entry) => JSON.parse(entry));
      return existing;
    }
    const obligationMetadata = mergeObligationMetadata(
      {},
      {
        ...(metadata || {}),
        ...(hasExplicitPlanCommands ? { evidencePlanCommandBinding: true } : {}),
        ...(hasExplicitCommandRefs && sourceType !== 'proof-policy' && !hasExplicitPlanCommands
          ? { explicitCommandBinding: true, explicitBindingSourceType: sourceType }
          : {}),
      },
      {
      sourceType,
      sourceRef,
      allowedCommandRefs: allowed,
      candidateCommandRefs: hasExplicitCommandRefs ? commandRefs : null,
      addCommandCandidate: hasExplicitCommandRefs || sourceType === 'proof-policy',
      },
    );
    const obligation = {
      obligationId,
      evidenceClass: resolvedClass,
      verificationMethod: resolvedClass === 'judgment' ? (method || 'structured-judgment') : (method || 'kernel-executed-command'),
      allowedCommandRefs: [...new Set(allowed)],
      rejectedCommandRefs,
      acceptanceIds: [...new Set(acceptanceIds)],
      protected: isProtectedObligation(obligationId),
      sourceType,
      sourceRef,
      ...(Object.keys(obligationMetadata).length > 0 ? { metadata: obligationMetadata } : {}),
      contractRevision,
      satisfiable: resolvedClass === 'judgment' || allowed.length > 0,
    };
    compiled.set(obligationId, obligation);
    return obligation;
  };

  for (const check of tierObligations) {
    declare(check, { sourceType: 'proof-policy', sourceRef: 'kernel/proof-policy.yaml', metadata: { rootProofRequired: true } });
  }
  for (const declared of contract?.requiredObligations || []) {
    declare(declared, { sourceType: 'caller', sourceRef: 'task-contract' });
  }
  for (const [index, verification] of (Array.isArray(contract?.requiredVerifications) ? contract.requiredVerifications : []).entries()) {
    const record = verification && typeof verification === 'object' ? asRecord(verification) : { method: String(verification) };
    const obligationId = String(record.obligationId || record.id || `required-verification-${index + 1}`);
    declare(obligationId, {
      sourceType: 'caller',
      sourceRef: 'task-contract.requiredVerifications',
      commandRefs: Array.isArray(record.commandRefs) ? record.commandRefs.map(String) : (record.commandRef ? [String(record.commandRef)] : null),
      evidenceClass: ['hard', 'judgment'].includes(String(record.evidenceClass || record.class || '')) ? String(record.evidenceClass || record.class) : 'hard',
      method: record.method || record.kind ? String(record.method || record.kind) : null,
      metadata: {
        scenarioId: record.scenarioId || null,
        verificationKind: record.kind || record.type || null,
        evidenceDepth: record.evidenceDepth || null,
        evidenceLevel: ['work', 'integration', 'goal'].includes(String(record.evidenceLevel || '')) ? String(record.evidenceLevel) : null,
        scope: normalizeScope(record.scope),
        freshnessInputs: Array.isArray(record.freshnessInputs) ? record.freshnessInputs.map(String) : [],
        timeoutMs: Number.isFinite(Number(record.timeoutMs)) && Number(record.timeoutMs) > 0 ? Number(record.timeoutMs) : null,
      },
    });
  }
  for (const item of contract?.acceptance || []) {
    const obligationId = obligationForAcceptancePlan(item, tierObligations);
    if (!obligationId) {
      // Unplanned acceptance is covered by the tier obligations; coverage is
      // still enforced at completion.
      for (const check of tierObligations) {
        const existing = compiled.get(check);
        if (existing) existing.acceptanceIds = [...new Set([...existing.acceptanceIds, item.id])];
      }
      continue;
    }
    const plan = item.evidencePlan;
    declare(obligationId, {
      sourceType: 'evidence-plan',
      sourceRef: item.id,
      acceptanceIds: [item.id],
      commandRefs: plan?.commandRefs?.length ? plan.commandRefs.map(String) : null,
      evidenceClass: plan?.class || null,
      method: plan?.method || null,
      metadata: {
        outcome: plan?.outcome || null,
        evidenceLevel: ['work', 'integration', 'goal'].includes(String(plan?.evidenceLevel || '')) ? plan?.evidenceLevel : null,
        scope: normalizeScope(plan?.scope),
        freshnessInputs: Array.isArray(plan?.freshnessInputs) ? plan.freshnessInputs.map(String) : [],
        timeoutMs: Number.isFinite(Number(plan?.timeoutMs)) && Number(plan?.timeoutMs) > 0 ? Number(plan?.timeoutMs) : null,
      },
    });
  }

  // Project-owned required_verification records are executable only when the
  // changed scope intersects the record's declared scope. The Kernel carries
  // command refs and freshness metadata but does not interpret project domain
  // semantics or invent pass rules.
  for (const record of Array.isArray(knowledgeRecords) ? knowledgeRecords : []) {
    const type = record?.type || record?.recordType;
    if (type !== 'required_verification' || ['superseded', 'rejected', 'archived'].includes(String(record.status || ''))) continue;
    const sourceRefs = Array.isArray(record.sourceRefs) ? record.sourceRefs.map(String) : [];
    if (sourceRefs.length > 0) {
      const freshness = cheapReVerify({
        sourceRefs,
        sourceDigest: typeof record.sourceDigest === 'string' ? record.sourceDigest : null,
      }, { projectRoot });
      if (freshness.status !== 'fresh') continue;
    }
    const verification = record.verification || record.recordJson?.verification || {};
    const recordScope = normalizeScope(record.scope);
    const verificationScope = normalizeScope(verification.scope);
    const scope = recordScope.length > 0 ? recordScope : verificationScope;
    if (!Array.isArray(changedPaths) || changedPaths.length === 0) continue;
    if (scope.length > 0 && !changedPaths.some((changedPath) => matchPathScope(changedPath, scope))) continue;
    const explicitCommandRefs: string[] = Array.isArray(verification.commandRefs)
      ? verification.commandRefs.map(String)
      : (verification.commandRef ? [String(verification.commandRef)] : []);
    // Older committed required_verification records may have preserved the
    // canonical regression statement but lost the nested commandRefs field.
    // Recover only the exact command token emitted by the Kernel's own
    // regression-capture format; arbitrary knowledge prose must not become an
    // executable command binding.
    const statementCommand = /^Regression verification executed:\s*([A-Za-z0-9][A-Za-z0-9:_-]*)\s*$/i.exec(String(record.statement || ''))?.[1] || null;
    const commandRefs = explicitCommandRefs.length > 0
      ? explicitCommandRefs
      : (statementCommand ? [statementCommand] : []);
    const obligationId = String(verification.obligationId || `required-verification-${record.id || record.recordId || 'record'}`);
    declare(obligationId, {
      sourceType: 'knowledge',
      sourceRef: record.id || record.recordId ? String(record.id || record.recordId) : null,
      commandRefs,
      evidenceClass: 'hard',
      method: verification.method ? String(verification.method) : null,
      metadata: {
        scope,
        evidenceLevel: ['work', 'integration', 'goal'].includes(String(verification.evidenceLevel || record.evidenceLevel || ''))
          ? String(verification.evidenceLevel || record.evidenceLevel)
          : null,
        receiptContractRef: verification.receiptContractRef || record.receiptContractRef ? String(verification.receiptContractRef || record.receiptContractRef) : null,
        freshnessInputs: Array.isArray(verification.freshnessInputs) ? verification.freshnessInputs.map(String) : (Array.isArray(record.freshnessInputs) ? record.freshnessInputs.map(String) : []),
      },
    });
  }

  return [...compiled.values()];
};

// Verification-time binding check (P0-2). A Kernel-executed command may only
// stand as evidence for an obligation whose allowlist contains it.
export const assertCommandBinding = (obligation: ObligationLike | null | undefined, commandRef: string | null | undefined): void => {
  if (!obligation) return;
  if (obligation.evidenceClass === 'judgment') {
    throw new ObligationBindingError(
      'OBLIGATION_REQUIRES_JUDGMENT',
      `Obligation "${obligation.obligationId}" is a judgment obligation and cannot be satisfied by running a command`,
      { obligationId: obligation.obligationId },
    );
  }
  if (!commandRef) return;
  if (obligation.allowedCommandRefs.length === 0) {
    const rejected = (obligation.rejectedCommandRefs || []).map((entry) => `${entry.commandRef} (${entry.reason})`);
    throw new ObligationBindingError(
      'OBLIGATION_UNSATISFIABLE',
      rejected.length > 0
        ? `Obligation "${obligation.obligationId}" has no usable command: the evidence plan named ${rejected.join(', ')}. Name a project command that actually performs this kind of verification, or report an unsupported-verification blocker`
        : `Obligation "${obligation.obligationId}" has no project command that can prove it; declare one in the project manifest or report an unsupported-verification blocker`,
      { obligationId: obligation.obligationId, rejectedCommandRefs: obligation.rejectedCommandRefs || [] },
    );
  }
  if (!obligation.allowedCommandRefs.includes(commandRef)) {
    throw new ObligationBindingError(
      'COMMAND_NOT_BOUND_TO_OBLIGATION',
      `Command "${commandRef}" is not bound to obligation "${obligation.obligationId}" (allowed: ${obligation.allowedCommandRefs.join(', ') || 'none'})`,
      { obligationId: obligation.obligationId, commandRef, allowedCommandRefs: obligation.allowedCommandRefs },
    );
  }
};
