// Model capsule projections. Persisted capsules contain the provenance and
// control state the Kernel needs to prove what happened. Providers only need
// the small, work-facing subset below. Every nested value is rebuilt from a
// fixed schema so an adversarial value cannot smuggle a Host field through a
// shallow top-level projection.

const OMIT = Symbol('omit');

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const own = (value, key) => {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
};

const hasOwn = (value, key) => {
  if (!value || typeof value !== 'object') return false;
  try { return Object.hasOwn(value, key); } catch { return false; }
};

const finiteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const text = (value) => (typeof value === 'string'
  ? value
  : typeof value === 'boolean' || finiteNumber(value) ? String(value) : '');
const meaningfulText = (...values) => {
  for (const value of values) {
    const projected = text(value);
    if (projected) return projected;
  }
  return '';
};

const freezeList = (values) => Object.freeze(values);

const stringList = (value) => freezeList(Array.isArray(value)
  ? value.map(text).filter(Boolean)
  : []);

const firstProjectedList = (project, ...values) => {
  let fallback = freezeList([]);
  for (const value of values) {
    const projected = project(value);
    if (!Array.isArray(projected)) continue;
    if (projected.length > 0) return projected;
    if (Array.isArray(value)) fallback = projected;
  }
  return fallback;
};

const projectFixedRecord = (value, fields) => {
  if (!isRecord(value)) return null;
  const projected = {};
  for (const [key, project] of fields) {
    const next = project(own(value, key));
    if (next !== OMIT) projected[key] = next;
  }
  return Object.freeze(projected);
};

const optionalText = (value) => {
  const projected = text(value);
  return projected ? projected : OMIT;
};

const optionalInteger = (value) => Number.isInteger(value) ? value : OMIT;

const projectAcceptanceItem = (value) => {
  if (typeof value === 'string' || typeof value === 'boolean' || finiteNumber(value)) return text(value);
  if (!isRecord(value)) return OMIT;
  const projected = projectFixedRecord(value, [
    ['id', optionalText],
    ['statement', optionalText],
    ['obligationIds', (next) => hasOwn(value, 'obligationIds') ? stringList(next) : OMIT],
  ]);
  return projected && Object.keys(projected).length > 0 ? projected : OMIT;
};

const acceptanceList = (value) => freezeList(Array.isArray(value)
  ? value.map(projectAcceptanceItem).filter((entry) => entry !== OMIT)
  : []);

const projectEvidenceItem = (value) => {
  if (typeof value === 'string' || typeof value === 'boolean' || finiteNumber(value)) return text(value);
  if (!isRecord(value)) return OMIT;
  const projected = projectFixedRecord(value, [
    ['obligationId', optionalText],
    ['evidenceClass', optionalText],
    ['allowedCommandRefs', (next) => hasOwn(value, 'allowedCommandRefs') ? stringList(next) : OMIT],
    ['acceptanceIds', (next) => hasOwn(value, 'acceptanceIds') ? stringList(next) : OMIT],
    ['status', optionalText],
    ['evidenceDigest', optionalText],
    ['command', optionalText],
    ['exitCode', optionalInteger],
    ['verificationMethod', optionalText],
    ['errorSummary', optionalText],
  ]);
  return projected && Object.keys(projected).length > 0 ? projected : OMIT;
};

const evidenceList = (value) => freezeList(Array.isArray(value)
  ? value.map(projectEvidenceItem).filter((entry) => entry !== OMIT)
  : []);

const projectKnowledgeRecord = (value) => {
  if (typeof value === 'string' || typeof value === 'boolean' || finiteNumber(value)) return text(value);
  if (!isRecord(value)) return OMIT;
  const projected = projectFixedRecord(value, [
    ['recordId', optionalText],
    ['summary', optionalText],
    ['revision', optionalInteger],
    ['type', optionalText],
    ['id', optionalText],
    ['statement', optionalText],
  ]);
  return projected && Object.keys(projected).length > 0 ? projected : OMIT;
};

const knowledgeValue = (value) => {
  if (Array.isArray(value)) {
    return freezeList(value.map(projectKnowledgeRecord).filter((entry) => entry !== OMIT));
  }
  const projected = projectKnowledgeRecord(value);
  return projected === OMIT ? null : projected;
};

const projectPathRecord = (value) => {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return OMIT;
  const projected = projectFixedRecord(value, [
    ['path', optionalText],
    ['reason', optionalText],
  ]);
  return projected && Object.keys(projected).length > 0 ? projected : OMIT;
};

const projectPathList = (value) => freezeList(Array.isArray(value)
  ? value.map(projectPathRecord).filter((entry) => entry !== OMIT)
  : []);

const projectSymbolRecord = (value) => {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return OMIT;
  const projected = projectFixedRecord(value, [
    ['symbol', optionalText],
    ['path', optionalText],
  ]);
  return projected && Object.keys(projected).length > 0 ? projected : OMIT;
};

const projectSymbolList = (value) => freezeList(Array.isArray(value)
  ? value.map(projectSymbolRecord).filter((entry) => entry !== OMIT)
  : []);

const projectSkeletonSlice = (value) => {
  if (!isRecord(value)) return OMIT;
  const projected = projectFixedRecord(value, [
    ['name', optionalText],
    ['objective', optionalText],
    ['description', optionalText],
    ['allowedPaths', (next) => hasOwn(value, 'allowedPaths') ? stringList(next) : OMIT],
    ['expectedOutputs', (next) => hasOwn(value, 'expectedOutputs') ? stringList(next) : OMIT],
  ]);
  return projected && Object.keys(projected).length > 0 ? projected : OMIT;
};

const projectSkeletonSlices = (value) => freezeList(Array.isArray(value)
  ? value.map(projectSkeletonSlice).filter((entry) => entry !== OMIT)
  : []);

const projectWalkingSkeleton = (value) => {
  if (!isRecord(value)) return null;
  return projectFixedRecord(value, [
    ['schemaVersion', optionalInteger],
    ['projectType', optionalText],
    ['objective', optionalText],
    ['expandedDesign', (next) => typeof next === 'boolean' ? next : OMIT],
    ['slice', (next) => hasOwn(value, 'slice') ? stringList(next) : OMIT],
    ['slices', (next) => hasOwn(value, 'slices') ? projectSkeletonSlices(next) : OMIT],
    ['requiredEvidence', (next) => {
      if (!hasOwn(value, 'requiredEvidence')) return OMIT;
      return projectFixedRecord(next, [['kind', optionalText], ['description', optionalText]]) || null;
    }],
    ['minimumCompletion', (next) => hasOwn(value, 'minimumCompletion') ? stringList(next) : OMIT],
  ]);
};

const projectPermissions = (value) => {
  if (typeof value === 'string' || typeof value === 'boolean' || finiteNumber(value)) return text(value);
  return projectFixedRecord(value, [
    ['filesystem', optionalText],
    ['network', optionalText],
    ['canDelegate', (next) => typeof next === 'boolean' ? next : OMIT],
    ['canCommit', (next) => typeof next === 'boolean' ? next : OMIT],
  ]);
};

const projectWorkUnit = (value, fallbackObjective = '') => {
  if (!isRecord(value)) return null;
  return Object.freeze({
    objective: meaningfulText(own(value, 'objective'), fallbackObjective),
    dependencies: stringList(own(value, 'dependencies')),
    allowedPaths: stringList(own(value, 'allowedPaths')),
    forbiddenPaths: stringList(own(value, 'forbiddenPaths')),
    expectedOutputs: stringList(own(value, 'expectedOutputs')),
  });
};

const projectRepositoryContext = (value) => {
  if (!isRecord(value)) return null;
  return Object.freeze({
    projectMode: meaningfulText(own(value, 'projectMode')) || null,
    entrypoints: stringList(own(value, 'entrypoints')),
    relevantFiles: projectPathList(own(value, 'relevantFiles')),
    relevantSymbols: projectSymbolList(own(value, 'relevantSymbols')),
    manifests: stringList(own(value, 'manifests')),
    knownCommands: stringList(own(value, 'knownCommands')),
    architectureRecords: knowledgeValue(own(value, 'architectureRecords')) || freezeList([]),
    knowledgeRecords: knowledgeValue(own(value, 'knowledgeRecords')) || freezeList([]),
    knownFailurePatterns: stringList(own(value, 'knownFailurePatterns')),
    baseline: projectFixedRecord(own(value, 'baseline'), [
      ['status', optionalText],
      ['knownFailures', (next) => stringList(next)],
    ]) || null,
    walkingSkeleton: projectWalkingSkeleton(own(value, 'walkingSkeleton')),
  });
};

const projectReviewScope = (value) => projectFixedRecord(value, [
  ['stage', optionalText],
  ['requiredChecks', (next) => stringList(next)],
  ['obligationId', optionalText],
]);

const projectCurrentWork = (value) => {
  if (!isRecord(value)) return null;
  const projected = {
    type: text(own(value, 'type')),
    guidance: text(own(value, 'guidance')),
    objective: text(own(value, 'objective')),
    allowedPaths: stringList(own(value, 'allowedPaths')),
    forbiddenPaths: stringList(own(value, 'forbiddenPaths')),
    expectedOutputs: stringList(own(value, 'expectedOutputs')),
  };
  if (hasOwn(value, 'changedPaths')) projected.changedPaths = projectPathList(own(value, 'changedPaths'));
  if (hasOwn(value, 'reviewScope')) projected.reviewScope = projectReviewScope(own(value, 'reviewScope'));
  if (hasOwn(value, 'verificationEvidence')) projected.verificationEvidence = evidenceList(own(value, 'verificationEvidence'));
  return Object.freeze(projected);
};

// Final prompt vocabulary is intentionally smaller than the persisted capsule
// and the full `next` response. These are work-facing concepts; routing,
// provider, lease, cache, CAS, and Git metadata stay on the Host/Kernel side.
export const MODEL_VISIBLE_PROMPT_FIELDS = Object.freeze([
  'objective',
  'acceptance',
  'constraints',
  'currentWork',
  'relevantProjectKnowledge',
  'requiredEvidence',
]);

export const MODEL_VISIBLE_PROMPT_MAX_BYTES = 65536;

const assertModelVisiblePromptBudget = (prompt) => {
  const serializedBytes = Buffer.byteLength(JSON.stringify(prompt), 'utf8');
  if (serializedBytes <= MODEL_VISIBLE_PROMPT_MAX_BYTES) return prompt;
  throw Object.assign(new Error('model_context_budget_exceeded'), {
    code: 'MODEL_CONTEXT_BUDGET_EXCEEDED',
    errorCode: 'MODEL_CONTEXT_BUDGET_EXCEEDED',
    serializedBytes,
    maxBytes: MODEL_VISIBLE_PROMPT_MAX_BYTES,
    nextAction: 'split-work-unit',
  });
};

const sanitizePromptView = (value) => {
  const source = isRecord(value) ? value : {};
  return Object.freeze({
    objective: text(own(source, 'objective')),
    acceptance: acceptanceList(own(source, 'acceptance')),
    constraints: stringList(own(source, 'constraints')),
    currentWork: projectCurrentWork(own(source, 'currentWork')),
    relevantProjectKnowledge: knowledgeValue(own(source, 'relevantProjectKnowledge')),
    requiredEvidence: evidenceList(own(source, 'requiredEvidence')),
  });
};

const reviewContextSource = (modelInput, capsule) => ({
  changedPaths: firstProjectedList(projectPathList, own(modelInput, 'changedPaths'), own(own(capsule, 'subject'), 'changedPaths')),
  reviewScope: projectReviewScope(own(modelInput, 'reviewScope')) || projectReviewScope(own(capsule, 'reviewScope')),
  verificationEvidence: firstProjectedList(evidenceList, own(modelInput, 'verificationEvidence'), own(capsule, 'verificationEvidence')),
});

export const buildModelVisiblePromptView = ({ modelInput = {}, capsule = null } = {}) => {
  const input = isRecord(modelInput) ? modelInput : {};
  const sourceCapsule = isRecord(capsule) ? capsule : {};
  const action = isRecord(own(input, 'action')) ? own(input, 'action') : {};
  const stepCandidate = isRecord(own(action, 'step'))
    ? own(action, 'step')
    : isRecord(own(sourceCapsule, 'workUnit')) ? own(sourceCapsule, 'workUnit') : null;
  const objective = meaningfulText(own(input, 'objective'), own(sourceCapsule, 'objective'));
  const context = reviewContextSource(input, sourceCapsule);
  const actionType = meaningfulText(own(action, 'type'));
  const guidance = meaningfulText(own(action, 'guidance'));
  const hasReviewContext = hasOwn(input, 'changedPaths') || hasOwn(input, 'reviewScope')
    || hasOwn(input, 'verificationEvidence') || isRecord(own(sourceCapsule, 'subject'))
    || isRecord(own(sourceCapsule, 'reviewScope')) || hasOwn(sourceCapsule, 'verificationEvidence');
  const currentWork = (stepCandidate || actionType || guidance || hasReviewContext)
    ? projectCurrentWork({
      type: actionType,
      guidance,
      objective: meaningfulText(own(stepCandidate, 'objective'), objective),
      allowedPaths: own(stepCandidate, 'allowedPaths'),
      forbiddenPaths: own(stepCandidate, 'forbiddenPaths'),
      expectedOutputs: own(stepCandidate, 'expectedOutputs'),
      ...(hasOwn(input, 'changedPaths') || isRecord(own(sourceCapsule, 'subject')) ? { changedPaths: context.changedPaths } : {}),
      ...(context.reviewScope ? { reviewScope: context.reviewScope } : {}),
      ...(hasOwn(input, 'verificationEvidence') || hasOwn(sourceCapsule, 'verificationEvidence') ? { verificationEvidence: context.verificationEvidence } : {}),
    })
    : null;
  const inputVerification = isRecord(own(input, 'verification')) ? own(input, 'verification') : {};
  const requiredEvidence = firstProjectedList(
    evidenceList,
    own(input, 'requiredEvidence'),
    own(action, 'obligations'),
    own(inputVerification, 'pending'),
    own(own(sourceCapsule, 'verification'), 'obligations'),
  );
  return assertModelVisiblePromptBudget(sanitizePromptView({
    objective,
    acceptance: firstProjectedList(acceptanceList, own(input, 'acceptance'), own(sourceCapsule, 'acceptance')),
    constraints: firstProjectedList(stringList, own(input, 'constraints'), own(sourceCapsule, 'constraints')),
    currentWork,
    relevantProjectKnowledge: knowledgeValue(own(input, 'knowledge')) || knowledgeValue(own(own(sourceCapsule, 'repositoryContext'), 'knowledgeRecords')),
    requiredEvidence,
  }));
};

// This is the only text projection sent to a provider. Sanitize again at the
// message boundary so a custom launcher cannot bypass the six-field contract
// by supplying a hand-built prompt object.
export const buildModelVisiblePromptMessage = ({ prompt = {}, review = false } = {}) => {
  const safePrompt = sanitizePromptView(prompt);
  return [
    review
      ? 'Perform the independent Kernel review described below.'
      : 'Perform the bounded Kernel worker action described below.',
    'Inspect the current workspace only within the declared work context.',
    'Do not invoke Kernel next/report commands, do not delegate, and do not claim completion authority.',
    review
      ? 'A pass verdict requires every reviewed acceptance claim to be supported by the current files and evidence.'
      : 'Use exact identifiers from requiredEvidence when reporting verification and do not invent replacements.',
    'Return only the JSON object required by the configured output schema.',
    '',
    'MODEL VISIBLE CONTEXT',
    JSON.stringify(safePrompt, null, 2),
  ].join('\n');
};

export const MODEL_VISIBLE_CAPSULE_FIELDS = Object.freeze([
  'role', 'objective', 'acceptance', 'constraints', 'nonGoals',
  'workUnit', 'repositoryContext', 'verification', 'permissions',
  'changedPaths', 'verificationEvidence', 'reviewScope',
]);

// Present in the persisted capsule, never in the view.
export const CONTROL_ONLY_CAPSULE_FIELDS = Object.freeze([
  'capsuleId', 'stepId', 'runId', 'routeDecisionId', 'admissionId', 'mutationRevision',
  'workspaceIdentity', 'provenance', 'capsuleDigest', 'createdAt', 'observedAt', 'leaseId',
]);

// A reviewer capsule has no implementer workUnit/repositoryContext/verification;
// its allowed review context is projected separately below.
export const buildModelCapsuleView = (capsule = {}, { role = null } = {}) => {
  const source = isRecord(capsule) ? capsule : {};
  const objective = meaningfulText(own(source, 'objective'));
  const view = {
    role: meaningfulText(role, own(source, 'role')) || null,
    objective,
    acceptance: acceptanceList(own(source, 'acceptance')),
    constraints: stringList(own(source, 'constraints')),
    nonGoals: stringList(own(source, 'nonGoals')),
    permissions: projectPermissions(own(source, 'permissions')),
  };
  const workUnit = projectWorkUnit(own(source, 'workUnit'), objective);
  if (workUnit) view.workUnit = workUnit;
  const repositoryContext = projectRepositoryContext(own(source, 'repositoryContext'));
  if (repositoryContext) view.repositoryContext = repositoryContext;
  const verification = own(source, 'verification');
  if (isRecord(verification)) view.verification = Object.freeze({ obligations: evidenceList(own(verification, 'obligations')) });
  const subject = own(source, 'subject');
  if (isRecord(subject)) view.changedPaths = projectPathList(own(subject, 'changedPaths'));
  if (hasOwn(source, 'verificationEvidence')) view.verificationEvidence = evidenceList(own(source, 'verificationEvidence'));
  const reviewScope = projectReviewScope(own(source, 'reviewScope'));
  if (reviewScope) view.reviewScope = reviewScope;
  return Object.freeze(view);
};

const CONTROL_ONLY_PROMPT_FIELDS = new Set([
  ...CONTROL_ONLY_CAPSULE_FIELDS,
  'executionContract', 'executionCapsule', 'route', 'routeDecision', 'admission', 'provider',
  'lease', 'control', 'modelPolicy', 'reviewSubject', 'workspaceIdentity', 'provenance',
  'capsuleDigest', 'accounting', 'attestation', 'parentSessionId', 'actorSessionId',
]);

// Used by the envelope tests: proves the projection dropped everything the
// model must not see, including a forbidden key nested below an approved field.
export const findControlMetadataLeaks = (view) => {
  const seen = new Set();
  const visited = new Set();
  const walk = (value) => {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    let entries = [];
    try { entries = Object.entries(value); } catch { return; }
    for (const [key, child] of entries) {
      if (CONTROL_ONLY_PROMPT_FIELDS.has(key)) seen.add(key);
      walk(child);
    }
  };
  walk(view);
  return [...seen].sort();
};
