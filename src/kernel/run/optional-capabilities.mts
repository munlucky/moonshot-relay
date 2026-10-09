type Flags = Record<string, unknown>;
interface CapabilityTask { flags?: Flags; taskClass?: unknown }
export interface CapabilityContext {
  run?: { taskContract?: CapabilityTask };
  taskContract?: CapabilityTask;
  flags?: Flags;
  actionKind?: unknown;
  action?: { actionKind?: unknown; type?: unknown };
  taskClass?: unknown;
  request?: Flags;
  attempts?: Array<{ status?: unknown }>;
  threshold?: number;
  gitCloseoutRequest?: { mode?: unknown };
  requestedMode?: unknown;
}
interface Verification { status?: unknown; obligationId?: string }

// Optional capabilities are deliberately evaluated at the boundary where the
// corresponding work is requested.  The default Kernel graph is the work,
// evidence, and knowledge lifecycle; these capabilities do not add ambient
// state or provider routing to every turn.

export const OPTIONAL_CAPABILITY_IDS = Object.freeze([
  'independent-review',
  'stagnation-escalation',
  'optimization-cycle',
  'architecture-planning',
  'retro-collection',
  'audit',
  'remote-parity',
]);

export const DEFAULT_OPTIONAL_CAPABILITIES = Object.freeze(
  Object.fromEntries(OPTIONAL_CAPABILITY_IDS.map((id) => [id, false])),
);

const stringValue = (value: unknown) => (value === undefined || value === null ? '' : String(value));
const flagsOf = (context: CapabilityContext = {}) => ({
  ...(context.run?.taskContract?.flags || {}),
  ...(context.taskContract?.flags || {}),
  ...(context.flags || {}),
});

const actionKindOf = (context: CapabilityContext = {}) => stringValue(
  context.actionKind || context.action?.actionKind || context.action?.type,
).toLowerCase();

const taskClassOf = (context: CapabilityContext = {}) => stringValue(
  context.taskClass || context.taskContract?.taskClass || context.run?.taskContract?.taskClass,
).toLowerCase();

const explicit = (flags: Flags, ...names: string[]) => names.some((name) => flags[name] === true);

export const optionalCapabilityActive = (capability: string, context: CapabilityContext = {}) => {
  if (!OPTIONAL_CAPABILITY_IDS.includes(capability)) return false;
  const flags = flagsOf(context);
  const actionKind = actionKindOf(context);
  const taskClass = taskClassOf(context);
  const request = context.request || {};

  switch (capability) {
    case 'independent-review':
      return actionKind.startsWith('review')
        || actionKind === 'review'
        || request.reviewRequired === true
        || explicit(flags, 'independentReviewRequired', 'reviewRequired');
    case 'stagnation-escalation': {
      const failedAttempts = (Array.isArray(context.attempts) ? context.attempts : [])
        .filter((attempt) => attempt?.status === 'failed').length;
      const threshold = Number(context.threshold || 3);
      return explicit(flags, 'stagnationEscalation', 'stagnationRequested')
        || (Number.isFinite(threshold) && failedAttempts >= threshold);
    }
    case 'optimization-cycle':
      return explicit(flags, 'optimizationCycle', 'optimizationRequested')
        || request.optimizationRequested === true;
    case 'architecture-planning':
      return ['understand', 'design', 'plan', 'replan'].includes(actionKind)
        || ['analysis', 'design', 'plan'].includes(taskClass)
        || explicit(flags, 'architecturePlanning', 'architectureRequested', 'planningRequested')
        || request.architectureRequested === true;
    case 'retro-collection':
      return explicit(flags, 'retro', 'retroRequested') || request.retroRequested === true;
    case 'audit':
      return explicit(flags, 'audit', 'auditRequested') || request.auditRequested === true;
    case 'remote-parity':
      return stringValue(context.gitCloseoutRequest?.mode || context.requestedMode) === 'commit_and_push'
        || explicit(flags, 'remoteParity', 'remoteParityRequested')
        || request.remoteParityRequested === true;
    default:
      return false;
  }
};

export const resolveOptionalCapabilities = (context: CapabilityContext = {}) => {
  const active = Object.fromEntries(
    OPTIONAL_CAPABILITY_IDS.map((id) => [id, optionalCapabilityActive(id, context)]),
  );
  const reasons = Object.fromEntries(
    OPTIONAL_CAPABILITY_IDS.map((id) => [id, active[id] ? 'condition-met' : 'condition-not-met']),
  );
  return {
    schemaVersion: 1,
    defaults: DEFAULT_OPTIONAL_CAPABILITIES,
    active,
    reasons,
  };
};

// Kept here so the default control-plane graph does not import the optional
// stagnation module. The old module remains a compatibility surface for
// callers/tests that explicitly request the capability.
export const detectOptionalStagnation = ({ attempts = [], verifications = [], threshold = 3, ...context }: CapabilityContext & { verifications?: Verification[] } = {}) => {
  const failedAttempts = attempts.filter((attempt) => attempt?.status === 'failed');
  if (!optionalCapabilityActive('stagnation-escalation', { ...context, attempts, threshold })) {
    return { stagnant: false, reason: 'optional-capability-disabled', failedAttempts: failedAttempts.length };
  }
  if (failedAttempts.length < threshold) {
    return { stagnant: false, reason: 'below-threshold', failedAttempts: failedAttempts.length };
  }

  const failingByObligation = new Map();
  for (const verification of verifications) {
    if (verification.status === 'failed') failingByObligation.set(verification.obligationId, verification);
    else failingByObligation.delete(verification.obligationId);
  }
  if (failingByObligation.size === 0) {
    return { stagnant: false, reason: 'no-failing-obligation', failedAttempts: failedAttempts.length };
  }
  const [obligationId] = [...failingByObligation.keys()];
  return {
    stagnant: true,
    reason: 'repeated-failure-no-progress',
    repeatedObligation: obligationId,
    failedAttempts: failedAttempts.length,
  };
};
