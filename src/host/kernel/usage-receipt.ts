// Host usage receipt builder (§6.3 / §16.1). Its whole job is to report what
// really happened, including "I could not do what the Kernel asked".

import {
  buildReceiptId,
  hashSessionId,
  normalizeModelUsageReceipt,
} from '../../contracts/model-execution.js';

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);

const countOrNull = (value: unknown, allowed: boolean): number | null => (
  allowed && Number.isInteger(value) && Number(value) >= 0
    ? Number(value)
    : null
);

const resolveEnforcementStatus = ({
  resolution,
  capabilities,
  strategy,
  dispatch,
}: {
  resolution: UnknownRecord;
  capabilities: UnknownRecord;
  strategy: unknown;
  dispatch: UnknownRecord;
}) => {
  if (dispatch.status === 'failed') return 'failed';
  if (dispatch.enforcementStatus === 'failed') return 'failed';
  if (
    strategy === 'unsupported'
    || capabilities.supportsResolvedModelIdentity !== true
  ) return 'unsupported';
  if (dispatch.status === 'unsupported') return 'unsupported';
  if (!resolution.model || resolution.enforcementIntent !== 'enforced') {
    return 'advisory';
  }
  if (!dispatch.resolvedModel) return 'advisory';
  if (dispatch.resolvedModel !== resolution.model) return 'fallback';
  if (resolution.effort && dispatch.resolvedEffort !== resolution.effort) {
    return 'fallback';
  }
  // Requested/resolved identity describes Host configuration. It is not
  // evidence of what the provider actually ran. An enforced receipt is only
  // valid when the execution surface also reports the observed identity.
  if (!dispatch.observedModel) return 'advisory';
  if (dispatch.observedModel !== resolution.model) return 'fallback';
  if (resolution.effort && !dispatch.observedEffort) return 'advisory';
  if (
    resolution.effort
    && String(dispatch.observedEffort).toLowerCase()
      !== String(resolution.effort).toLowerCase()
  ) {
    return 'fallback';
  }
  return 'enforced';
};

const resolveCacheTelemetry = ({
  capabilities,
  dispatch,
  cacheContext,
}: {
  capabilities: UnknownRecord;
  dispatch: UnknownRecord;
  cacheContext: UnknownRecord;
}) => {
  const readAllowed = capabilities.supportsCacheReadTokens === true;
  const writeAllowed = capabilities.supportsCacheWriteTokens === true;
  const read = readAllowed
    ? countOrNull(
      dispatch.cacheReadInputTokens ?? dispatch.cachedInputTokens,
      true,
    )
    : null;
  const write = writeAllowed
    ? countOrNull(dispatch.cacheWriteInputTokens, true)
    : null;

  let missReason = cacheContext.cacheMissReason
    ? String(cacheContext.cacheMissReason)
    : null;
  if (!missReason) {
    if (capabilities.supportsPromptCache !== true) {
      missReason = 'provider-unsupported';
    } else if (read === null) {
      missReason = 'usage-unreported';
    } else if (read === 0) {
      missReason = 'cold-prefix';
    }
  }
  return { read, write, missReason };
};

export interface UsageReceiptInput {
  decision: UnknownRecord;
  capabilities: UnknownRecord;
  strategy: unknown;
  resolution: UnknownRecord;
  dispatch?: UnknownRecord;
  capsule?: UnknownRecord | null;
  admission?: UnknownRecord | null;
  attemptId?: unknown;
  bindingId?: unknown;
  actorSessionId: unknown;
  parentSessionId?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
  cacheContext?: UnknownRecord;
  envelope?: UnknownRecord | null;
  sessionLineage?: UnknownRecord | null;
}

export const buildUsageReceipt = ({
  decision,
  capabilities,
  strategy,
  resolution,
  dispatch = {},
  capsule = null,
  admission = null,
  attemptId = null,
  bindingId = null,
  actorSessionId,
  parentSessionId = null,
  startedAt = null,
  finishedAt = null,
  cacheContext = {},
  envelope = null,
  sessionLineage = null,
}: UsageReceiptInput) => {
  if (!decision) {
    throw new Error('a usage receipt requires the route decision it answers');
  }
  if (decision.modelClass === 'kernel') {
    throw new Error(
      'kernel-owned actions run no provider model and produce no usage receipt',
    );
  }

  const actor = hashSessionId(actorSessionId);
  if (!actor) {
    throw new Error(
      'a usage receipt requires the Host session that performed the turn',
    );
  }

  const enforcementStatus = resolveEnforcementStatus({
    resolution,
    capabilities,
    strategy,
    dispatch,
  });
  const tokensAllowed = capabilities.supportsUsageTokens === true;
  const cache = resolveCacheTelemetry({
    capabilities,
    dispatch,
    cacheContext,
  });

  const capsuleRecord = asRecord(capsule);
  const provenance = asRecord(capsuleRecord.provenance);
  const admissionRecord = asRecord(admission);
  const invocation = asRecord(dispatch.invocation);
  const envelopeRecord = asRecord(envelope);
  const modelPolicy = asRecord(envelopeRecord.modelPolicy);
  const cacheIdentity = asRecord(envelopeRecord.cacheIdentity);
  const cachePolicy = asRecord(envelopeRecord.cachePolicy);
  const lineage = asRecord(sessionLineage);

  return normalizeModelUsageReceipt({
    receiptId: buildReceiptId({
      decisionId: decision.decisionId,
      actorSessionId: actor,
      startedAt: startedAt || '',
    }),
    decisionId: decision.decisionId,
    runId: decision.runId,
    hostSurface: capabilities.surface,
    actorSessionId: actor,
    parentSessionId: hashSessionId(parentSessionId),
    attemptId,
    bindingId,
    resolvedModel: dispatch.resolvedModel || null,
    resolvedEffort: dispatch.resolvedEffort || null,
    requestedModel: resolution.model || null,
    requestedEffort: resolution.effort || null,
    observedModel: dispatch.observedModel || null,
    observedEffort: dispatch.observedEffort || null,
    role: decision.role || null,
    actionKind: decision.actionKind || null,
    workProfile: decision.workProfile || null,
    dispatchMechanism:
      dispatch.dispatchMechanism || invocation.mechanism || null,
    enforcementReason: dispatch.enforcementReason || null,
    fallbackReason: dispatch.fallbackReason || null,
    capsuleId: capsuleRecord.capsuleId || null,
    capsuleDigest: provenance.capsuleDigest || null,
    stepId: capsuleRecord.stepId || null,
    admissionId: admissionRecord.admissionId || null,
    admissionDigest: admissionRecord.digest || null,
    enforcementStatus,
    resultStatus:
      dispatch.resultStatus
      || (dispatch.status === 'failed' ? 'failed' : 'completed'),
    startedAt,
    finishedAt,
    wallClockMs: countOrNull(dispatch.wallClockMs, true),
    inputTokens: countOrNull(dispatch.inputTokens, tokensAllowed),
    cachedInputTokens: countOrNull(dispatch.cachedInputTokens, tokensAllowed),
    outputTokens: countOrNull(dispatch.outputTokens, tokensAllowed),
    costMicros: countOrNull(dispatch.costMicros, tokensAllowed),
    provider: capabilities.surface || null,
    surface: capabilities.surface || null,
    speedMode: dispatch.speedMode ?? cacheContext.speedMode ?? null,
    reasoningContext: modelPolicy.reasoningContext ?? null,
    reasoningMode: dispatch.reasoningMode ?? null,
    delegationMode: modelPolicy.delegationMode ?? null,
    sessionLineageId: lineage.sessionLineageId ?? null,
    previousResponseIdDigest: dispatch.previousResponseId
      ? hashSessionId(dispatch.previousResponseId)
      : null,
    promptPrefixDigest: cacheIdentity.prefixDigest ?? null,
    promptCacheKeyDigest: cacheContext.promptCacheKeyDigest ?? null,
    cacheMode: cachePolicy.requestedMode ?? cacheContext.cacheMode ?? null,
    cacheTtl: cachePolicy.ttlClass ?? null,
    cacheMissReason: cache.missReason,
    modelEscalationReason: cacheContext.modelEscalationReason ?? null,
    eligiblePrefixTokens: countOrNull(
      cacheContext.eligiblePrefixTokens,
      true,
    ),
    uncachedInputTokens: countOrNull(
      dispatch.uncachedInputTokens,
      tokensAllowed,
    ),
    cacheReadInputTokens: cache.read,
    cacheWriteInputTokens: cache.write,
    reasoningTokens: countOrNull(
      dispatch.reasoningTokens,
      tokensAllowed,
    ),
  });
};
