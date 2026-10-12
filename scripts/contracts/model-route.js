// Generated from src/contracts/model-route.ts. Edit the source and run npm run build.
import { KERNEL_CONTRACT_ENUMS } from './schema-definitions.generated.js';
import { parseKernelContract } from './schema-codec.js';
// Kernel→Host model route contract (§6.1). The Kernel decides a LOGICAL model
// class and records the decision; the Host maps that class onto a provider
// model. Nothing provider-shaped — credentials, prompt text, reasoning, raw
// output — may cross this boundary, so the decision is a closed, checked record.
import { createHash } from 'node:crypto';
import { REVIEW_ACTIONS } from './review.js';
import { EXECUTION_CLASSES, LEGACY_MODEL_CLASSES, executionClassForAction, executionClassFromLegacyModelClass, legacyModelClassForExecutionClass, normalizeExecutionClass, } from './execution-class.js';
import { ModelRouteContractError, normalizeWorkProfile, } from './model-execution.js';
export const ACTION_KINDS = Object.freeze(KERNEL_CONTRACT_ENUMS['kernel.model-route']['actionKind']);
// Deprecated compatibility export. New Kernel contracts use executionClass;
// this name remains readable until the Host consumers are migrated in the
// later decomplexification waves.
export const MODEL_CLASSES = LEGACY_MODEL_CLASSES;
export { EXECUTION_CLASSES };
export const ROLES = Object.freeze(KERNEL_CONTRACT_ENUMS['kernel.model-route']['role']);
export const PERMISSIONS = Object.freeze(KERNEL_CONTRACT_ENUMS['kernel.model-route']['permissions']);
export const RISK_TIERS = Object.freeze(KERNEL_CONTRACT_ENUMS['kernel.model-route']['riskTier']);
export const BUILD_ACTIONS = ['implement', 'debug'];
export { REVIEW_ACTIONS };
// Host-only or secret-bearing fields. A decision carrying any of them is
// rejected rather than trimmed, so a leak fails closed instead of silently.
const FORBIDDEN_DECISION_FIELDS = [
    'apiKey',
    'apiKeys',
    'authorization',
    'credentials',
    'secret',
    'secrets',
    'prompt',
    'promptText',
    'messages',
    'transcript',
    'chainOfThought',
    'reasoning',
    'requestBody',
    'stdout',
    'stderr',
    'env',
    'environment',
    'providerModel',
    'resolvedModel',
];
const fail = (code, message) => {
    throw new ModelRouteContractError(code, message);
};
const isMember = (values, value) => (typeof value === 'string'
    && values.includes(value));
const positiveInt = (value, fallbackValue) => (Number.isInteger(value) && Number(value) >= 0
    ? Number(value)
    : fallbackValue);
export const buildDecisionId = ({ runId = 'run', attemptNumber = 1, sequence = 0, actionKind = 'implement', } = {}) => ('route-'
    + createHash('sha256')
        .update(`${runId}|${attemptNumber}|${sequence}|${actionKind}`)
        .digest('hex')
        .slice(0, 24));
// A route decision is only usable once it is closed and provider-free.
export const normalizeModelRouteDecision = (decision = {}) => {
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
        fail('kernel_model_route_invalid', 'model route decision must be an object');
    }
    for (const field of FORBIDDEN_DECISION_FIELDS) {
        if (Object.hasOwn(decision, field)) {
            fail('kernel_model_route_forbidden_field', `model route decision must not carry host/provider field: ${field}`);
        }
    }
    if (!decision.decisionId
        || !/^route-[a-f0-9]{8,64}$/.test(String(decision.decisionId))) {
        fail('kernel_model_route_invalid', 'model route decision requires a route-<hex> decisionId');
    }
    if (!decision.runId) {
        fail('kernel_model_route_invalid', 'model route decision requires a runId');
    }
    if (!isMember(ACTION_KINDS, decision.actionKind)) {
        fail('kernel_model_action_invalid', `actionKind must be one of: ${ACTION_KINDS.join(', ')}`);
    }
    const actionKind = decision.actionKind;
    if (Object.hasOwn(decision, 'modelClass')
        && !isMember(MODEL_CLASSES, decision.modelClass)) {
        fail('kernel_model_class_invalid', `modelClass must be one of: ${MODEL_CLASSES.join(', ')}`);
    }
    let executionClass = null;
    if (Object.hasOwn(decision, 'executionClass')) {
        try {
            executionClass = normalizeExecutionClass(decision.executionClass);
        }
        catch (error) {
            fail('kernel_execution_class_invalid', error instanceof Error ? error.message : String(error));
        }
    }
    else if (Object.hasOwn(decision, 'modelClass')) {
        try {
            executionClass = executionClassFromLegacyModelClass(decision.modelClass);
        }
        catch (error) {
            fail('kernel_model_class_invalid', error instanceof Error ? error.message : String(error));
        }
    }
    else {
        const profile = decision.workProfile;
        const complexity = profile
            && typeof profile === 'object'
            && !Array.isArray(profile)
            ? profile.complexity
            : null;
        executionClass = executionClassForAction(decision.actionKind, { complexity });
    }
    const modelClass = (Object.hasOwn(decision, 'modelClass')
        ? String(decision.modelClass)
        : legacyModelClassForExecutionClass(executionClass));
    if (Object.hasOwn(decision, 'executionClass')
        && Object.hasOwn(decision, 'modelClass')
        && legacyModelClassForExecutionClass(executionClass) !== modelClass) {
        fail('kernel_model_route_invalid', 'executionClass and modelClass are incongruent');
    }
    if (!isMember(ROLES, decision.role)) {
        fail('kernel_model_route_invalid', `role must be one of: ${ROLES.join(', ')}`);
    }
    const role = decision.role;
    if (!isMember(PERMISSIONS, decision.permissions)) {
        fail('kernel_model_route_invalid', `permissions must be one of: ${PERMISSIONS.join(', ')}`);
    }
    const permissions = decision.permissions;
    if (!isMember(RISK_TIERS, decision.riskTier)) {
        fail('kernel_model_route_invalid', `riskTier must be one of: ${RISK_TIERS.join(', ')}`);
    }
    const riskTier = decision.riskTier;
    const reasonCodes = Array.isArray(decision.reasonCodes)
        ? decision.reasonCodes.map(String).filter(Boolean)
        : [];
    if (reasonCodes.length === 0) {
        fail('kernel_model_route_invalid', 'model route decision requires at least one reason code');
    }
    if (!decision.policyRevision) {
        fail('kernel_model_route_invalid', 'model route decision requires a policyRevision');
    }
    const workProfile = normalizeWorkProfile(decision.workProfile, { actionKind });
    return Object.freeze(parseKernelContract('kernel.model-route', {
        schemaVersion: 1,
        decisionId: String(decision.decisionId),
        runId: String(decision.runId),
        attemptNumber: positiveInt(decision.attemptNumber, 1),
        replanCount: positiveInt(decision.replanCount, 0),
        planRevision: positiveInt(decision.planRevision, 1),
        obligationId: decision.obligationId
            ? String(decision.obligationId)
            : null,
        actionKind,
        role,
        executionClass,
        modelClass,
        riskTier,
        independentContextRequired: decision.independentContextRequired === true,
        workProfile,
        permissions,
        reasonCodes: Object.freeze(reasonCodes),
        policyRevision: String(decision.policyRevision),
        createdAt: decision.createdAt
            ? String(decision.createdAt)
            : new Date().toISOString(),
    }));
};
