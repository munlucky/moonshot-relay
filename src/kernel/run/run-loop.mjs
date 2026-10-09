import { TRANSITIONS } from '../transition.mjs';
import { sanitizePersistentPayload } from '../persistent-sanitizer.mjs';

export const REPORT_BLOCK_REASONS = Object.freeze([
  'question',
  'permission',
  'external-dependency',
  'unsupported-verification',
  'unsafe-command',
  'network-policy',
]);

// Shortest transition path between workflow states, so the report loop can
// advance a run without the model ever naming internal states.
export const planStatePath = (from, to) => {
  if (from === to) return [];
  const visited = new Set([from]);
  const queue = [[from, []]];
  while (queue.length > 0) {
    const [state, pathSoFar] = queue.shift();
    for (const next of TRANSITIONS[state] || []) {
      if (visited.has(next)) continue;
      const nextPath = [...pathSoFar, next];
      if (next === to) return nextPath;
      visited.add(next);
      queue.push([next, nextPath]);
    }
  }
  return null;
};

// Steps along the route fixed at run start (P1-1). The route now contains only
// durable lifecycle states; work decomposition and proof selection stay in the
// Step Ledger and obligation compiler.
export const planRouteSteps = (route, from, to) => {
  if (!Array.isArray(route) || route.length === 0) return null;
  const fromIndex = route.indexOf(from);
  const toIndex = route.indexOf(to);
  if (fromIndex < 0 || toIndex < 0 || toIndex < fromIndex) return null;
  const steps = route.slice(fromIndex + 1, toIndex + 1);
  // Only usable when every hop is a legal transition; otherwise fall back.
  let cursor = from;
  for (const step of steps) {
    if (!(TRANSITIONS[cursor] || []).includes(step)) return null;
    cursor = step;
  }
  return steps;
};

// Keep next() small and decision-oriented. Full receipts remain available to
// Kernel internals and review capsules; the model only needs the three-bucket
// obligation projection, with details attached to failures.
export const summarizeVerification = ({
  verifications = [],
  requiredObligations = [],
  satisfiedObligations = null,
  outstandingObligationIds = null,
  failures = [],
} = {}) => {
  const required = [...new Set((requiredObligations || []).map(String))];
  const passed = new Set(
    (satisfiedObligations
      ? [...satisfiedObligations]
      : verifications.filter((verification) => verification.status === 'passed').map((verification) => verification.obligationId))
      .map(String),
  );
  const failureRows = [...(failures || [])];
  const failedById = new Map();
  for (const verification of verifications.filter((entry) => entry.status === 'failed')) failureRows.push(verification);
  for (const failure of failureRows) {
    const obligationId = failure?.obligationId || failure?.commandRef;
    if (!obligationId || failedById.has(String(obligationId))) continue;
    failedById.set(String(obligationId), {
      obligationId: String(obligationId),
      ...(failure.commandRef ? { commandRef: String(failure.commandRef) } : {}),
      ...(failure.errorSummary ? { errorSummary: String(failure.errorSummary) } : {}),
    });
  }
  const explicitOutstanding = outstandingObligationIds
    ? new Set([...outstandingObligationIds].map(String))
    : null;
  const pending = (explicitOutstanding
    ? required.filter((obligationId) => explicitOutstanding.has(obligationId))
    : required.filter((obligationId) => !passed.has(obligationId)))
    .filter((obligationId) => !failedById.has(obligationId));
  return {
    passed: required.filter((obligationId) => passed.has(obligationId)),
    pending,
    failed: [...failedById.values()],
  };
};

// What the model needs to satisfy an obligation: the class of evidence that
// counts and the exact commands that are bound to it. Without this the model
// has to guess, and guessing is what produced forged obligation names.
const describeObligations = (obligations = [], obligationIds = []) => obligationIds.map((obligationId) => {
  const declared = obligations.find((obligation) => obligation.obligationId === obligationId);
  return {
    obligationId,
    evidenceClass: declared?.evidenceClass || 'hard',
    verificationMethod: declared?.verificationMethod || 'kernel-executed-command',
    allowedCommandRefs: declared?.allowedCommandRefs || [],
    commandRef: declared?.allowedCommandRefs?.[0] || null,
    acceptanceIds: declared?.acceptanceIds || [],
    verificationScope: declared?.metadata?.verificationScope || declared?.metadata?.scope || null,
    timeoutMs: Number.isFinite(Number(declared?.metadata?.timeoutMs)) ? Number(declared.metadata.timeoutMs) : null,
  };
});

// An ordinary work unit is assigned a bounded role before the model can report
// implementation work. Transport selection belongs to the Host, so the
// model-visible projection carries only role and, for protected review, the
// independent-review requirement.
const actorRoleForAction = (actionType) => {
  if (actionType === 'review') return 'reviewer';
  if (actionType === 'debug') return 'debugger';
  if (['implement', 'fix'].includes(actionType)) return 'implementer';
  if (['understand', 'design', 'plan', 'replan'].includes(actionType)) return 'planner';
  return null;
};

const withExecution = (action, { transportNeutral = false } = {}) => {
  const role = actorRoleForAction(action?.type);
  if (!role) return action;
  const independentReviewRequired = role === 'reviewer' && action?.independentReviewRequired === true;
  const useSubagent = independentReviewRequired && (action?.mode === 'subagent' || action?.delegationTarget === 'subagent');
  const execution = {
    role,
    delegation: {
      mode: independentReviewRequired ? 'required' : 'optional',
      ...(useSubagent ? { target: 'subagent', requested: true } : {}),
    },
  };
  // Contract-bound runs use a transport-neutral model projection. Keep the
  // legacy unbound payload shape for callers that have not adopted a Task
  // Contract yet; Host routing still remains authoritative in both cases.
  if (independentReviewRequired) execution.executionMode = useSubagent ? 'native-subagent' : 'independent-review';
  else if (!transportNeutral) execution.executionMode = 'owner-direct';
  return {
    ...action,
    execution,
  };
};

// Model-visible payload for `kernel next`: contract, current evidence, and one
// action. Internal state names are never exposed.
export const buildNextPayload = ({
  run,
  verifications = [],
  requiredObligations = [],
  obligations = [],
  contract = null,
  failures = [],
  knowledgePromptBlock = null,
  capabilities = [],
  satisfiedObligations = null,
  outstandingObligationIds = null,
  resume = null,
  workAuthority = null,
  trustAuthority = null,
}) => {
  const acceptancePlans = Array.isArray(contract?.acceptance)
    ? contract.acceptance.map((item) => ({
      id: item.id,
      statement: item.statement,
      evidencePlan: item.evidencePlan || null,
    }))
    : [];
  const verification = summarizeVerification({
    verifications,
    requiredObligations,
    satisfiedObligations,
    outstandingObligationIds,
    failures,
  });
  const requiredVerificationDescriptions = describeObligations(obligations, requiredObligations);
  const currentWorkUnit = workAuthority?.currentWorkUnit || null;
  const currentAction = (action) => ({
    ...base,
    nextAction: action?.type || null,
    action,
  });
  const executionProjectionOptions = {
    // An empty contract briefing is the legacy unplanned-run shape. A
    // declared acceptance contract is the boundary at which ordinary work
    // becomes transport-neutral in the model-visible payload.
    transportNeutral: Array.isArray(contract?.acceptance) && contract.acceptance.length > 0,
  };
  const base = {
    schemaVersion: 1,
    runId: run.runId,
    objective: run.objective,
    acceptance: contract?.acceptance?.map((item) => item.statement) || run.acceptanceCriteria || [],
    // Constraints and non-goals come from persisted SQLite state, so a run
    // resumed in a fresh process does not lose them (P0-4).
    constraints: contract?.constraints || [],
    nonGoals: contract?.nonGoals || [],
    risks: contract?.risks || [],
    completionPredicate: contract?.completionPredicate || { requiredOutcomes: [] },
    verification,
    knowledge: knowledgePromptBlock,
    acceptancePlans,
    capabilities,
    stepId: currentWorkUnit?.stepId || null,
    allowedPaths: currentWorkUnit?.allowedPaths || [],
    forbiddenPaths: currentWorkUnit?.forbiddenPaths || [],
    acceptanceIds: Array.isArray(contract?.acceptance) ? contract.acceptance.map((item) => item.id) : [],
    requiredVerifications: requiredVerificationDescriptions,
    availableCommandRefs: [...new Set(requiredVerificationDescriptions.flatMap((entry) => entry.allowedCommandRefs || []))].sort(),
    ...(workAuthority ? { workAuthority } : {}),
    ...(trustAuthority ? { trustAuthority } : {}),
    ...(resume ? {
      resume: (resume.durableState && !run.verboseNext)
        ? {
          status: resume.status,
          action: resume.action,
          stepId: resume.stepId || null,
          workUnitId: resume.workUnitId || null,
        }
        : resume,
    } : {}),
  };

  if (run.status === 'completed' && (run.finalizationStatus || 'completed') === 'completed') {
    if (workAuthority?.goalStatus === 'active' || workAuthority?.goal?.status === 'active') {
      return currentAction(withExecution({
          type: 'implement',
          guidance: 'Work unit finished, but goal is still active. Continue with the remaining acceptance criteria.',
        }, executionProjectionOptions));
    }
    return currentAction({ type: 'done', guidance: 'Run is complete. No further work is required.' });
  }
  // Accepted completion whose knowledge commit or Git closeout did not finish
  // is NOT done; the run stays retryable (P0-7).
  if (run.status === 'completed') {
    return currentAction({
        type: 'finalize',
        finalizationStatus: run.finalizationStatus,
        guidance: 'Evidence was accepted but finalization did not complete. Submit kernel report again to retry the outstanding finalization step.',
      });
  }
  if (run.status === 'blocked' && run.blockedReason) {
    return currentAction({
        type: 'blocked',
        reason: run.blockedReason,
        blockingClass: run.blockingClass || 'safety',
        guidance: run.blockedReason === 'unsupported-verification'
          ? 'Required verification commands are missing or unsatisfiable. Use an existing discovered project command when available; otherwise report an unsupported-verification blocker for the project owner, without mutating the product manifest.'
          : 'Resolve the blocker with the user, then submit a new report.',
      });
  }

  const failing = verification.failed;
  if (failing.length > 0) {
    return currentAction(withExecution({
        type: 'fix',
        guidance: 'Fix the failing verification(s), then submit kernel report again with the summary and changed paths.',
        failures: failing.map((failure) => ({
          obligationId: failure.obligationId,
          commandRef: failure.commandRef || null,
          errorSummary: failure.errorSummary || null,
          allowedCommandRefs: failure.allowedCommandRefs || undefined,
        })),
      }, executionProjectionOptions));
  }

  const outstanding = verification.pending;
  if (outstanding.length > 0) {
    const described = describeObligations(obligations, outstanding);
    if (outstanding.length > 0 && described.every((entry) => entry.evidenceClass === 'judgment')) {
      return currentAction(withExecution({
          type: 'review',
          mode: 'subagent',
          guidance: 'Route the outstanding judgment obligations to an independent reviewer session or native subagent, and submit the Kernel-recorded review receipt in kernel report. In a single-session environment where subagents are unavailable, submit self-review findings for operator confirmation. Operator approval may satisfy only outstanding judgment obligations and requires a Host-issued approval reference; hard evidence must still be executed by the Kernel.',
          outstandingObligations: outstanding,
          obligations: described,
          independentReviewRequired: true,
          supportOperatorApproval: true,
        }, executionProjectionOptions));
    }
    const unsatisfiable = described
      .filter((entry) => entry.evidenceClass === 'hard' && entry.allowedCommandRefs.length === 0);
    return currentAction(withExecution({
      type: 'implement',
      guidance: unsatisfiable.length > 0
          ? 'Implement the objective. Some required evidence has no runnable project command yet — use an existing discovered project command when available; otherwise report an unsupported-verification blocker for the project owner.'
          : 'Implement the objective, then submit kernel report with a summary and changed paths. The Kernel will run only outstanding bound proof.',
        outstandingObligations: outstanding,
        obligations: described,
      }, executionProjectionOptions));
  }

  if (workAuthority?.progress?.remainingCount > 0 && (workAuthority?.goalStatus === 'active' || workAuthority?.goal?.status === 'active')) {
    return {
      ...base,
      action: withExecution({
        type: 'implement',
        guidance: `Work unit ${workAuthority.currentWorkUnit?.stepId || ''} is in progress. Continue implementation.`.trim(),
      }, executionProjectionOptions),
    };
  }

  return currentAction({ type: 'report', guidance: 'All Kernel evidence obligations passed. Submit kernel report to finalize the run.' });
};

export const normalizeReport = (payload = {}) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('report payload must be a JSON object');
  }
  const blocker = payload.blocker && typeof payload.blocker === 'object' ? payload.blocker : null;
  if (blocker && !REPORT_BLOCK_REASONS.includes(blocker.reason)) {
    throw new Error(`blocker.reason must be one of: ${REPORT_BLOCK_REASONS.join(', ')}`);
  }
  const verifications = Array.isArray(payload.verifications) ? payload.verifications : [];
  for (const request of verifications) {
    if (!request || typeof request !== 'object' || !request.commandRef) {
      throw new Error('each requested verification requires a commandRef');
    }
  }
  // A judgment carries the Review Receipt it rests on, not a reviewer name the
  // report invented; protected and T3 judgments are refused without one.
  const judgments = (Array.isArray(payload.judgments) ? payload.judgments : []).map((judgment) => {
    if (!judgment || typeof judgment !== 'object' || !judgment.obligationId || !['pass', 'fail'].includes(judgment.verdict)) {
      throw new Error('each judgment requires an obligationId and a pass/fail verdict');
    }
    if (judgment.reviewReceiptId !== undefined && judgment.reviewReceiptId !== null && !/^review-receipt-[a-f0-9]{8,64}$/.test(String(judgment.reviewReceiptId))) {
      throw new Error('judgment.reviewReceiptId must be a review-receipt-<hex> identifier recorded by the Kernel');
    }
    return {
      ...judgment,
      reviewReceiptId: judgment.reviewReceiptId ? String(judgment.reviewReceiptId) : null,
      acceptanceCoverage: Array.isArray(judgment.acceptanceCoverage) ? judgment.acceptanceCoverage.map(String) : undefined,
    };
  });
  return sanitizePersistentPayload({
    summary: typeof payload.summary === 'string' ? payload.summary : '',
    implementerId: payload.implementerId ? String(payload.implementerId) : null,
    // The bounded context (K1) and the work unit (K2) this report answers.
    capsuleId: payload.capsuleId ? String(payload.capsuleId) : null,
    attemptId: payload.attemptId ? String(payload.attemptId) : null,
    bindingId: payload.bindingId ? String(payload.bindingId) : null,
    // The Host-issued actor handle is consumed at the report boundary.  It is
    // not part of the model-visible action, and a capsule id cannot substitute
    // for it.
    assignmentId: payload.assignmentId ? String(payload.assignmentId) : null,
    stepId: payload.stepId ? String(payload.stepId) : null,
    planRevision: payload.planRevision === undefined || payload.planRevision === null ? undefined : Number(payload.planRevision),
    actorSessionId: payload.actorSessionId || payload.sessionId || payload.workerSessionId ? String(payload.actorSessionId || payload.sessionId || payload.workerSessionId) : null,
    workspaceId: payload.workspaceId ? String(payload.workspaceId) : null,
    changedPaths: Array.isArray(payload.changedPaths) ? payload.changedPaths.map(String) : [],
    risks: Array.isArray(payload.risks) ? payload.risks.map(String) : [],
    verifications,
    judgments,
    // Evidence plans the model produced in FRAME; persisted before execution.
    evidencePlans: Array.isArray(payload.evidencePlans) ? payload.evidencePlans : [],
    blocker,
    gitCloseoutRequest: payload.gitCloseoutRequest && typeof payload.gitCloseoutRequest === 'object' ? payload.gitCloseoutRequest : null,
    knowledgeObservations: Array.isArray(payload.knowledgeObservations) ? payload.knowledgeObservations : [],
  });
};
