// Host usage receipt builder (§6.3 / §16.1). Its whole job is to report what
// really happened, including "I could not do what the Kernel asked". A Host
// that silently upgrades its own status is worse than one that cannot route.

import { buildReceiptId, hashSessionId, normalizeModelUsageReceipt } from '../../kernel/run/model-route-contract.mjs';

// The requested class was applied only when the registry resolved an explicit
// model AND the Host can prove which model actually answered.
const resolveEnforcementStatus = ({ resolution, capabilities, strategy, dispatch }) => {
  if (dispatch.status === 'failed') return 'failed';
  if (dispatch.enforcementStatus === 'failed') return 'failed';
  if (strategy === 'unsupported' || !capabilities.supportsResolvedModelIdentity) return 'unsupported';
  if (dispatch.status === 'unsupported') return 'unsupported';
  if (!resolution.model || resolution.enforcementIntent !== 'enforced') return 'advisory';
  if (!dispatch.resolvedModel) return 'advisory';
  if (dispatch.resolvedModel !== resolution.model) return 'fallback';
  if (resolution.effort && dispatch.resolvedEffort !== resolution.effort) return 'fallback';
  return 'enforced';
};

const countOrNull = (value, allowed) => (allowed && Number.isInteger(value) && value >= 0 ? value : null);

// Cache read/write counts are only trusted when the Host declared it can
// observe them. A provider that reports nothing leaves them null and the miss
// reason `usage-unreported`, which is a different diagnosis from a real miss.
const resolveCacheTelemetry = ({ capabilities, dispatch, cacheContext }) => {
  const readAllowed = capabilities.supportsCacheReadTokens === true;
  const writeAllowed = capabilities.supportsCacheWriteTokens === true;
  const read = readAllowed ? countOrNull(dispatch.cacheReadInputTokens ?? dispatch.cachedInputTokens, true) : null;
  const write = writeAllowed ? countOrNull(dispatch.cacheWriteInputTokens, true) : null;
  let missReason = cacheContext.cacheMissReason ?? null;
  if (!missReason) {
    if (capabilities.supportsPromptCache !== true) missReason = 'provider-unsupported';
    else if (read === null) missReason = 'usage-unreported';
    else if (read === 0) missReason = 'cold-prefix';
  }
  return { read, write, missReason };
};

export const buildUsageReceipt = ({ decision, capabilities, strategy, resolution, dispatch = {}, capsule = null, admission = null, attemptId = null, bindingId = null, actorSessionId, parentSessionId = null, startedAt = null, finishedAt = null, cacheContext = {}, envelope = null, sessionLineage = null } = {}) => {
  if (!decision) throw new Error('a usage receipt requires the route decision it answers');
  if (decision.modelClass === 'kernel') throw new Error('kernel-owned actions run no provider model and produce no usage receipt');
  const actor = hashSessionId(actorSessionId);
  if (!actor) throw new Error('a usage receipt requires the Host session that performed the turn');
  const enforcementStatus = resolveEnforcementStatus({ resolution, capabilities, strategy, dispatch });
  const tokensAllowed = capabilities.supportsUsageTokens === true;
  const cache = resolveCacheTelemetry({ capabilities, dispatch, cacheContext });
  return normalizeModelUsageReceipt({
    receiptId: buildReceiptId({ decisionId: decision.decisionId, actorSessionId: actor, startedAt: startedAt || '' }),
    decisionId: decision.decisionId,
    runId: decision.runId,
    hostSurface: capabilities.surface,
    actorSessionId: actor,
    parentSessionId: hashSessionId(parentSessionId),
    attemptId,
    bindingId,
    // Only an identity the Host actually observed is recorded. Echoing the
    // requested model back would turn a wish into evidence.
    resolvedModel: dispatch.resolvedModel || null,
    resolvedEffort: dispatch.resolvedEffort || null,
    requestedModel: resolution.model || null,
    requestedEffort: resolution.effort || null,
    // Resolution is not observation. A Host that only reports a resolved
    // value cannot claim that the provider terminal/rollout actually emitted
    // the same identity; the Kernel will keep the receipt advisory/fallback
    // until both observed fields are present.
    observedModel: dispatch.observedModel || null,
    observedEffort: dispatch.observedEffort || null,
    role: decision.role || null,
    actionKind: decision.actionKind || null,
    workProfile: decision.workProfile || null,
    dispatchMechanism: dispatch.dispatchMechanism || dispatch.invocation?.mechanism || null,
    enforcementReason: dispatch.enforcementReason || null,
    fallbackReason: dispatch.fallbackReason || null,
    // Lineage: which bounded context the worker ran on (K1), which admission
    // permitted the dispatch (K3), and which step it belongs to (K2).
    capsuleId: capsule?.capsuleId || null,
    capsuleDigest: capsule?.provenance?.capsuleDigest || null,
    stepId: capsule?.stepId || null,
    admissionId: admission?.admissionId || null,
    admissionDigest: admission?.digest || null,
    enforcementStatus,
    resultStatus: dispatch.resultStatus || (dispatch.status === 'failed' ? 'failed' : 'completed'),
    startedAt,
    finishedAt,
    wallClockMs: countOrNull(dispatch.wallClockMs, true),
    inputTokens: countOrNull(dispatch.inputTokens, tokensAllowed),
    cachedInputTokens: countOrNull(dispatch.cachedInputTokens, tokensAllowed),
    outputTokens: countOrNull(dispatch.outputTokens, tokensAllowed),
    costMicros: countOrNull(dispatch.costMicros, tokensAllowed),
    // Wave 8: cache and routing economics. The prefix digest is what makes a
    // hit or miss attributable to a specific prompt shape rather than to "the
    // cache", so it travels with the numbers.
    provider: capabilities.surface || null,
    surface: capabilities.surface || null,
    speedMode: dispatch.speedMode ?? cacheContext.speedMode ?? null,
    reasoningContext: envelope?.modelPolicy?.reasoningContext ?? null,
    reasoningMode: dispatch.reasoningMode ?? null,
    delegationMode: envelope?.modelPolicy?.delegationMode ?? null,
    sessionLineageId: sessionLineage?.sessionLineageId ?? null,
    previousResponseIdDigest: dispatch.previousResponseId ? hashSessionId(dispatch.previousResponseId) : null,
    promptPrefixDigest: envelope?.cacheIdentity?.prefixDigest ?? null,
    promptCacheKeyDigest: cacheContext.promptCacheKeyDigest ?? null,
    cacheMode: envelope?.cachePolicy?.requestedMode ?? cacheContext.cacheMode ?? null,
    cacheTtl: envelope?.cachePolicy?.ttlClass ?? null,
    cacheMissReason: cache.missReason,
    modelEscalationReason: cacheContext.modelEscalationReason ?? null,
    eligiblePrefixTokens: countOrNull(cacheContext.eligiblePrefixTokens, true),
    uncachedInputTokens: countOrNull(dispatch.uncachedInputTokens, tokensAllowed),
    cacheReadInputTokens: cache.read,
    cacheWriteInputTokens: cache.write,
    reasoningTokens: countOrNull(dispatch.reasoningTokens, tokensAllowed),
  });
};
