// Presentation only. Never persist this projection or use it for Host/proof
// decisions. Unknown fields remain visible; only known duplicates are omitted.
export const projectKernelModelView = (payload, { verbose = false } = {}) => {
  if (verbose || !payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const view = { ...payload };
  if (view.next) view.next = projectKernelModelView(view.next);
  if (!view.action) return view;
  view.view = 'compact';
  if (view.acceptancePlans?.length) delete view.acceptance;
  if (view.resume) {
    const { durableState, workAuthority, ...resume } = view.resume;
    view.resume = resume;
  }
  if (view.workAuthority) {
    const { task, ...work } = view.workAuthority;
    if (task) {
      const { objective, acceptanceCriteria, ...identity } = task;
      work.task = identity;
    }
    view.workAuthority = work;
  }
  if (view.trustAuthority) {
    const actionRequirements = new Map((view.action.obligations || []).map((o) => [o.obligationId, o]));
    view.trustAuthority = {
      ...view.trustAuthority,
      requirements: (view.trustAuthority.requirements || []).map((requirement) => {
        const actionRequirement = actionRequirements.get(requirement.obligationId);
        if (!actionRequirement || JSON.stringify(actionRequirement.allowedCommandRefs) !== JSON.stringify(requirement.allowedCommandRefs)) return requirement;
        const { allowedCommandRefs, ...rest } = requirement;
        return { ...rest, commandRefsSource: 'action.obligations' };
      }),
    };
  }
  if (view.action.projectContext?.knownCommands && view.action.obligations?.length) {
    const { knownCommands, ...context } = view.action.projectContext;
    view.action = { ...view.action, projectContext: context };
  }
  return view;
};
