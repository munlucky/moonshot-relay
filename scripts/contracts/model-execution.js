// Generated from src/contracts/model-execution.ts. Edit the source and run npm run build.
import { KERNEL_CONTRACT_ENUMS } from './schema-definitions.generated.js';
import { parseKernelContract } from './schema-codec.js';
import { createHash } from 'node:crypto';
import { executionClassForAction, normalizeExecutionClass, } from './execution-class.js';
export const WORK_PROFILE_COMPLEXITIES = Object.freeze(KERNEL_CONTRACT_ENUMS['kernel.model-route']['workProfile.complexity']);
export const ENFORCEMENT_STRATEGIES = Object.freeze([
    'subagent',
    'session',
    'advisory',
    'unsupported',
]);
export const ENFORCEMENT_STATUSES = Object.freeze(KERNEL_CONTRACT_ENUMS['kernel.model-usage']['enforcementStatus']);
export const RESULT_STATUSES = Object.freeze(KERNEL_CONTRACT_ENUMS['kernel.model-usage']['resultStatus']);
export const CACHE_MODES = Object.freeze(KERNEL_CONTRACT_ENUMS['kernel.model-usage']['cacheMode']);
export const CACHE_MISS_REASONS = Object.freeze(KERNEL_CONTRACT_ENUMS['kernel.model-usage']['cacheMissReason']);
export const MODEL_ESCALATION_REASONS = Object.freeze(KERNEL_CONTRACT_ENUMS['kernel.model-usage']['modelEscalationReason']);
export class ModelRouteContractError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'ModelRouteContractError';
        this.code = code;
    }
}
const fail = (code, message) => {
    throw new ModelRouteContractError(code, message);
};
const asRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {});
const normalizeComplexity = (value) => {
    const aliases = Object.freeze({
        'routine-batch': 'routine',
        simple: 'standard',
    });
    const raw = String(value);
    const normalized = aliases[raw] ?? raw;
    if (!WORK_PROFILE_COMPLEXITIES.includes(normalized)) {
        fail('kernel_work_profile_invalid', `workProfile.complexity must be one of: ${WORK_PROFILE_COMPLEXITIES.join(', ')}`);
    }
    return normalized;
};
const executionClassForWorkProfile = (profile, { actionKind = 'implement' } = {}) => {
    if (Object.hasOwn(profile, 'executionClass')) {
        return normalizeExecutionClass(profile.executionClass);
    }
    return executionClassForAction(actionKind, { complexity: profile.complexity });
};
export const normalizeWorkProfile = (profile = null, { actionKind = 'implement' } = {}) => {
    if (profile === null || profile === undefined)
        return null;
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        fail('kernel_work_profile_invalid', 'workProfile must be an object or null');
    }
    const input = asRecord(profile);
    for (const field of ['model', 'effort', 'provider', 'providerModel', 'resolvedModel', 'resolvedEffort']) {
        if (Object.hasOwn(input, field)) {
            fail('kernel_work_profile_forbidden_field', `workProfile must not carry provider field: ${field}`);
        }
    }
    const complexity = normalizeComplexity(input.complexity ?? 'standard');
    const executionClass = executionClassForWorkProfile(input, { actionKind });
    if (executionClass === null && !['prove', 'close'].includes(actionKind)) {
        fail('kernel_work_profile_invalid', `workProfile.executionClass is required for action: ${actionKind}`);
    }
    const booleanField = (name, fallback = false) => {
        const value = input[name];
        if (value === undefined)
            return fallback;
        if (typeof value !== 'boolean') {
            fail('kernel_work_profile_invalid', `workProfile.${name} must be boolean`);
        }
        return value === true;
    };
    return Object.freeze({
        executionClass,
        complexity,
        repeatedFailure: booleanField('repeatedFailure'),
        independentContextRequired: booleanField('independentContextRequired'),
        parallelizable: booleanField('parallelizable'),
    });
};
export const buildExecutionAssignmentId = (decisionId = null) => {
    const value = String(decisionId || '');
    return /^route-[a-f0-9]{8,64}$/.test(value)
        ? `assignment-${value.slice('route-'.length)}`
        : null;
};
export const normalizeHostCapabilities = (capabilities = {}) => {
    if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
        fail('kernel_host_capability_invalid', 'host capabilities must be an object');
    }
    const input = asRecord(capabilities);
    if (!input.surface) {
        fail('kernel_host_capability_invalid', 'host capabilities require a surface');
    }
    const flag = (name) => input[name] === true;
    return Object.freeze({
        schemaVersion: 1,
        surface: String(input.surface),
        supportsSubagentModel: flag('supportsSubagentModel'),
        supportsSessionModelOverride: flag('supportsSessionModelOverride'),
        supportsIndependentContext: flag('supportsIndependentContext'),
        supportsCrossSurfaceReview: flag('supportsCrossSurfaceReview') || flag('supportsIndependentContext'),
        supportsReadOnlyReview: flag('supportsReadOnlyReview'),
        supportsUsageTokens: flag('supportsUsageTokens'),
        supportsResolvedModelIdentity: flag('supportsResolvedModelIdentity'),
    });
};
export const resolveEnforcementStrategy = (capabilities, decision = null) => {
    const host = normalizeHostCapabilities(capabilities);
    if (decision && (decision.executionClass === null || decision.modelClass === 'kernel')) {
        return 'unsupported';
    }
    if (!host.supportsResolvedModelIdentity) {
        return host.supportsSubagentModel || host.supportsSessionModelOverride
            ? 'advisory'
            : 'unsupported';
    }
    if (host.supportsSubagentModel)
        return 'subagent';
    if (host.supportsSessionModelOverride)
        return 'session';
    return 'advisory';
};
const SESSION_ID = /^sha256:[a-f0-9]{64}$/;
const optionalCount = (value, field) => {
    if (value === null || value === undefined)
        return null;
    if (!Number.isInteger(value) || Number(value) < 0) {
        fail('kernel_model_usage_invalid', `${field} must be a non-negative integer or null`);
    }
    return Number(value);
};
const optionalEnum = (value, allowed, field) => {
    if (value === null || value === undefined || value === '')
        return null;
    if (!allowed.includes(String(value))) {
        fail('kernel_model_usage_invalid', `${field} must be one of: ${allowed.join(', ')}`);
    }
    return String(value);
};
const optionalText = (value) => (value === null || value === undefined || value === '' ? null : String(value));
export const buildReceiptId = ({ decisionId, actorSessionId, startedAt = '', } = {}) => ('usage-' + createHash('sha256')
    .update(`${decisionId}|${actorSessionId}|${startedAt}`)
    .digest('hex')
    .slice(0, 24));
export const normalizeModelUsageReceipt = (receipt = {}) => {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
        fail('kernel_model_usage_invalid', 'model usage receipt must be an object');
    }
    const input = asRecord(receipt);
    if (!input.decisionId || !/^route-[a-f0-9]{8,64}$/.test(String(input.decisionId))) {
        fail('kernel_model_usage_invalid', 'model usage receipt requires the route-<hex> decisionId it answers');
    }
    if (!input.runId) {
        fail('kernel_model_usage_invalid', 'model usage receipt requires a runId');
    }
    if (!input.hostSurface) {
        fail('kernel_model_usage_invalid', 'model usage receipt requires a hostSurface');
    }
    if (!SESSION_ID.test(String(input.actorSessionId || ''))) {
        fail('kernel_model_usage_session_invalid', 'actorSessionId must be a sha256:<hex> digest so raw session identifiers never persist');
    }
    if (input.parentSessionId && !SESSION_ID.test(String(input.parentSessionId))) {
        fail('kernel_model_usage_session_invalid', 'parentSessionId must be a sha256:<hex> digest when provided');
    }
    if (input.attemptId
        && !/^attempt-[a-f0-9-]{8,96}$/.test(String(input.attemptId))) {
        fail('kernel_model_usage_invalid', 'attemptId must match attempt-<hex-or-uuid>');
    }
    if (!ENFORCEMENT_STATUSES.includes(input.enforcementStatus)) {
        fail('kernel_model_usage_invalid', `enforcementStatus must be one of: ${ENFORCEMENT_STATUSES.join(', ')}`);
    }
    if (!RESULT_STATUSES.includes(input.resultStatus)) {
        fail('kernel_model_usage_invalid', `resultStatus must be one of: ${RESULT_STATUSES.join(', ')}`);
    }
    const resolvedModel = input.resolvedModel ? String(input.resolvedModel) : null;
    if (!resolvedModel && input.enforcementStatus === 'enforced') {
        fail('kernel_model_usage_enforcement_unproven', 'enforcementStatus "enforced" requires the resolved provider model the Host actually used');
    }
    const requestedModel = input.requestedModel ? String(input.requestedModel) : null;
    const requestedEffort = input.requestedEffort
        ? String(input.requestedEffort).toLowerCase()
        : null;
    const resolvedEffort = input.resolvedEffort
        ? String(input.resolvedEffort).toLowerCase()
        : null;
    const observedModel = input.observedModel ? String(input.observedModel) : null;
    const observedEffort = input.observedEffort
        ? String(input.observedEffort).toLowerCase()
        : null;
    const modernModelIdentity = Boolean(requestedModel || observedModel);
    const modernEffortIdentity = Boolean(requestedEffort || observedEffort);
    if (input.enforcementStatus === 'enforced' && modernModelIdentity && !observedModel) {
        fail('kernel_model_usage_enforcement_unproven', 'enforcementStatus "enforced" requires an observed provider model equal to the requested model');
    }
    if (input.enforcementStatus === 'enforced' && modernEffortIdentity && !observedEffort) {
        fail('kernel_model_usage_enforcement_unproven', 'enforcementStatus "enforced" requires an observed reasoning effort equal to the requested effort');
    }
    if (input.enforcementStatus === 'enforced' && (modernModelIdentity || modernEffortIdentity)) {
        if (requestedModel && resolvedModel !== requestedModel) {
            fail('kernel_model_usage_enforcement_unproven', 'enforcementStatus "enforced" requires the resolved provider model to equal the requested model');
        }
        if (requestedEffort && requestedEffort !== resolvedEffort) {
            fail('kernel_model_usage_enforcement_unproven', 'enforcementStatus "enforced" requires the resolved reasoning effort to equal the requested effort');
        }
        if (requestedModel && observedModel !== requestedModel) {
            fail('kernel_model_usage_enforcement_unproven', 'enforcementStatus "enforced" requires an observed provider model equal to the requested model');
        }
        if (requestedEffort && observedEffort !== requestedEffort) {
            fail('kernel_model_usage_enforcement_unproven', 'enforcementStatus "enforced" requires an observed reasoning effort equal to the requested effort');
        }
        if (modernModelIdentity && observedModel !== resolvedModel) {
            fail('kernel_model_usage_enforcement_unproven', 'enforcementStatus "enforced" requires observed and resolved provider models to agree');
        }
        if (modernEffortIdentity
            && requestedEffort
            && observedEffort !== resolvedEffort) {
            fail('kernel_model_usage_enforcement_unproven', 'enforcementStatus "enforced" requires observed and resolved reasoning effort to agree');
        }
    }
    const startedAt = input.startedAt ? String(input.startedAt) : null;
    const cacheReadInputTokens = optionalCount(input.cacheReadInputTokens ?? input.cachedInputTokens ?? null, 'cacheReadInputTokens');
    const cachedInputTokens = optionalCount(input.cachedInputTokens ?? input.cacheReadInputTokens ?? null, 'cachedInputTokens');
    return Object.freeze(parseKernelContract('kernel.model-usage', {
        schemaVersion: 1,
        receiptId: String(input.receiptId
            || buildReceiptId({
                decisionId: input.decisionId,
                actorSessionId: input.actorSessionId,
                startedAt,
            })),
        decisionId: String(input.decisionId),
        runId: String(input.runId),
        hostSurface: String(input.hostSurface),
        actorSessionId: String(input.actorSessionId),
        parentSessionId: input.parentSessionId ? String(input.parentSessionId) : null,
        resolvedModel,
        resolvedEffort,
        requestedModel,
        requestedEffort,
        observedModel,
        observedEffort,
        executionProfileRevision: optionalText(input.executionProfileRevision),
        role: optionalText(input.role),
        actionKind: optionalText(input.actionKind),
        workProfile: normalizeWorkProfile(input.workProfile, { actionKind: String(input.actionKind || 'implement') }),
        dispatchMechanism: optionalText(input.dispatchMechanism),
        enforcementReason: optionalText(input.enforcementReason),
        fallbackReason: optionalText(input.fallbackReason),
        attemptId: input.attemptId ? String(input.attemptId) : null,
        bindingId: input.bindingId ? String(input.bindingId) : null,
        capsuleId: input.capsuleId ? String(input.capsuleId) : null,
        capsuleDigest: input.capsuleDigest ? String(input.capsuleDigest) : null,
        admissionId: input.admissionId ? String(input.admissionId) : null,
        admissionDigest: input.admissionDigest ? String(input.admissionDigest) : null,
        stepId: input.stepId ? String(input.stepId) : null,
        enforcementStatus: input.enforcementStatus,
        resultStatus: input.resultStatus,
        startedAt,
        finishedAt: input.finishedAt ? String(input.finishedAt) : null,
        wallClockMs: optionalCount(input.wallClockMs, 'wallClockMs'),
        inputTokens: optionalCount(input.inputTokens, 'inputTokens'),
        cachedInputTokens,
        outputTokens: optionalCount(input.outputTokens, 'outputTokens'),
        costMicros: optionalCount(input.costMicros, 'costMicros'),
        provider: optionalText(input.provider),
        surface: optionalText(input.surface),
        speedMode: optionalText(input.speedMode),
        reasoningContext: optionalText(input.reasoningContext),
        reasoningMode: optionalText(input.reasoningMode),
        delegationMode: optionalText(input.delegationMode),
        sessionLineageId: optionalText(input.sessionLineageId),
        previousResponseIdDigest: optionalText(input.previousResponseIdDigest),
        promptPrefixDigest: optionalText(input.promptPrefixDigest),
        promptCacheKeyDigest: optionalText(input.promptCacheKeyDigest),
        cacheMode: optionalEnum(input.cacheMode, CACHE_MODES, 'cacheMode'),
        cacheTtl: optionalText(input.cacheTtl),
        cacheMissReason: optionalEnum(input.cacheMissReason, CACHE_MISS_REASONS, 'cacheMissReason'),
        modelEscalationReason: optionalEnum(input.modelEscalationReason, MODEL_ESCALATION_REASONS, 'modelEscalationReason'),
        eligiblePrefixTokens: optionalCount(input.eligiblePrefixTokens ?? null, 'eligiblePrefixTokens'),
        uncachedInputTokens: optionalCount(input.uncachedInputTokens ?? null, 'uncachedInputTokens'),
        cacheReadInputTokens,
        cacheWriteInputTokens: optionalCount(input.cacheWriteInputTokens ?? null, 'cacheWriteInputTokens'),
        reasoningTokens: optionalCount(input.reasoningTokens ?? null, 'reasoningTokens'),
        createdAt: input.createdAt ? String(input.createdAt) : new Date().toISOString(),
    }));
};
export const hashSessionId = (value) => {
    if (value === null || value === undefined || value === '')
        return null;
    const normalized = String(value);
    return SESSION_ID.test(normalized)
        ? normalized
        : 'sha256:' + createHash('sha256').update(normalized).digest('hex');
};
