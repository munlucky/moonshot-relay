type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
);

const copyWithout = (
  value: UnknownRecord,
  keys: readonly string[],
): UnknownRecord => {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
};

// Presentation only. Never persist this projection or use it for Host/proof
// decisions. Unknown fields remain visible; only known duplicates are omitted.
export const projectKernelModelView = (
  payload: unknown,
  { verbose = false }: { verbose?: boolean } = {},
): unknown => {
  const payloadRecord = asRecord(payload);
  if (verbose || !payloadRecord) return payload;

  const view: UnknownRecord = { ...payloadRecord };
  if (view.next) view.next = projectKernelModelView(view.next);
  if (!view.action) return view;

  const action = asRecord(view.action);
  view.view = 'compact';

  if (Array.isArray(view.acceptancePlans) && view.acceptancePlans.length > 0) {
    delete view.acceptance;
    if (Array.isArray(view.acceptanceIds)) {
      const planIds = view.acceptancePlans
        .map((entry) => asRecord(entry)?.id)
        .filter((id): id is string => typeof id === 'string');
      if (JSON.stringify(view.acceptanceIds) === JSON.stringify(planIds)) {
        delete view.acceptanceIds;
      }
    }
  }

  if (
    action
    && Array.isArray(view.requiredVerifications)
    && Array.isArray(action.obligations)
    && action.obligations.length > 0
  ) {
    if (JSON.stringify(view.requiredVerifications) === JSON.stringify(action.obligations)) {
      delete view.requiredVerifications;
      view.requiredVerificationsSource = 'action.obligations';
    }
    if (Array.isArray(view.availableCommandRefs)) {
      delete view.availableCommandRefs;
    }
  }

  if (view.knowledgeSegments) {
    delete view.knowledgeSegments;
  }

  const knowledgeAuthority = asRecord(view.knowledgeAuthority);
  if (knowledgeAuthority && knowledgeAuthority.lifecycle) {
    view.knowledgeAuthority = copyWithout(knowledgeAuthority, ['lifecycle', 'projection']);
  }

  const trustDecision = asRecord(asRecord(view.trustAuthority)?.decision);
  if (view.completion && trustDecision?.completion && JSON.stringify(view.completion) === JSON.stringify(trustDecision.completion)) {
    delete view.completion;
  }

  const resume = asRecord(view.resume);
  if (resume) {
    view.resume = copyWithout(resume, ['durableState', 'workAuthority']);
  }

  const workAuthority = asRecord(view.workAuthority);
  if (workAuthority) {
    const work = copyWithout(workAuthority, ['task']);
    const task = asRecord(workAuthority.task);
    if (task) {
      work.task = copyWithout(task, ['objective', 'acceptanceCriteria']);
    }
    if (
      action
      && action.step
      && work.currentWorkUnit
      && JSON.stringify(work.currentWorkUnit) === JSON.stringify(action.step)
    ) {
      delete work.currentWorkUnit;
      work.currentWorkUnitSource = 'action.step';
    }
    view.workAuthority = work;
  }

  const trustAuthority = asRecord(view.trustAuthority);
  if (trustAuthority && action) {
    const obligations = Array.isArray(action.obligations) ? action.obligations : [];
    const actionRequirements = new Map<string, UnknownRecord>();
    for (const obligation of obligations) {
      const record = asRecord(obligation);
      if (record && typeof record.obligationId === 'string') {
        actionRequirements.set(record.obligationId, record);
      }
    }

    const requirements = Array.isArray(trustAuthority.requirements)
      ? trustAuthority.requirements
      : [];
    view.trustAuthority = {
      ...trustAuthority,
      requirements: requirements.map((requirement) => {
        const record = asRecord(requirement);
        if (!record || typeof record.obligationId !== 'string') return requirement;
        const actionRequirement = actionRequirements.get(record.obligationId);
        if (
          !actionRequirement
          || JSON.stringify(actionRequirement.allowedCommandRefs)
            !== JSON.stringify(record.allowedCommandRefs)
        ) {
          return requirement;
        }
        return {
          ...copyWithout(record, ['allowedCommandRefs']),
          commandRefsSource: 'action.obligations',
        };
      }),
    };
  }

  if (action) {
    const projectContext = asRecord(action.projectContext);
    const obligations = Array.isArray(action.obligations) ? action.obligations : [];
    const MAX_COMPACT_COMMAND_REFS = 8;
    const compactObligations = obligations.map((entry) => {
      const record = asRecord(entry);
      if (!record || !Array.isArray(record.allowedCommandRefs) || record.allowedCommandRefs.length <= MAX_COMPACT_COMMAND_REFS) {
        return entry;
      }
      return {
        ...record,
        allowedCommandRefs: record.allowedCommandRefs.slice(0, MAX_COMPACT_COMMAND_REFS),
        allowedCommandRefsTotal: record.allowedCommandRefs.length,
      };
    });
    const nextActionRecord: UnknownRecord = {
      ...action,
      ...(obligations.length > 0 ? { obligations: compactObligations } : {}),
    };
    if (projectContext?.knownCommands && obligations.length > 0) {
      nextActionRecord.projectContext = copyWithout(projectContext, ['knownCommands']);
    }
    view.action = nextActionRecord;
  }

  return view;
};
