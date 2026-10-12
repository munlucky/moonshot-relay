// Generated from src/contracts/host-execution-contract.ts. Edit the source and run npm run build.
import { normalizeExecutionClass } from './execution-class.js';
export const HOST_EXECUTION_CONTRACT_SCHEMA_VERSION = 2;
export const HOST_SEMANTIC_CAPABILITY_KEYS = [
    'freshContext',
    'workspaceWrite',
    'workspaceIsolation',
    'parallelExecution',
    'independentReview',
    'modelSelection',
];
export const HOST_OWNED_CONCERNS = [
    'provider',
    'model',
    'reasoningEffort',
    'session',
    'process',
    'worktree',
    'git',
    'prompt',
    'cache',
    'package',
    'profile',
];
const providerFieldNames = new Set([
    'provider', 'providerModel', 'model', 'modelClass', 'resolvedModel', 'requestedModel',
    'effort', 'reasoning', 'reasoningEffort', 'resolvedEffort', 'requestedEffort',
    'apiKey', 'credentials', 'authorization', 'prompt', 'promptText', 'messages',
    'sessionId', 'nativeSessionId', 'worktreeRoot', 'gitState', 'cacheKey',
]);
export class HostExecutionContractError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'HostExecutionContractError';
        this.code = code;
    }
}
const stringOrNull = (value) => (value === null || value === undefined || value === '' ? null : String(value));
const stringList = (value) => (Array.isArray(value) ? value.map(String).filter(Boolean) : []);
const assertProviderNeutral = (value, currentPath = 'contract') => {
    if (value === null || value === undefined)
        return;
    if (Array.isArray(value)) {
        value.forEach((entry, index) => assertProviderNeutral(entry, `${currentPath}[${index}]`));
        return;
    }
    if (typeof value !== 'object')
        return;
    for (const [key, child] of Object.entries(value)) {
        if (providerFieldNames.has(key)) {
            throw new HostExecutionContractError('host_execution_contract_provider_field', `host_execution_contract_provider_field:${currentPath}.${key}`);
        }
        assertProviderNeutral(child, `${currentPath}.${key}`);
    }
};
const semanticRequirements = ({ decision = {}, assignment = null, } = {}) => {
    const resolvedAssignment = assignment || {};
    return Object.freeze({
        freshContext: resolvedAssignment.freshSessionRequired === true || decision.independentContextRequired === true,
        workspaceWrite: decision.permissions === 'workspace_write',
        workspaceIsolation: resolvedAssignment.workProfile?.parallelizable === true || resolvedAssignment.executionMode === 'parallel',
        parallelExecution: resolvedAssignment.executionMode === 'parallel',
        independentReview: decision.role === 'reviewer'
            && (resolvedAssignment.freshSessionRequired === true || decision.independentContextRequired === true),
        modelSelection: resolvedAssignment.modelSelectionRequired === true,
    });
};
const normalizeWorkUnit = (workUnit = {}) => ({
    objective: String(workUnit.objective || ''),
    allowedPaths: stringList(workUnit.allowedPaths),
    forbiddenPaths: stringList(workUnit.forbiddenPaths),
    expectedOutputs: stringList(workUnit.expectedOutputs),
});
export const buildHostExecutionContract = ({ decision = null, assignment = null, capsule = null, attemptId = null, workUnit = null, } = {}) => {
    if (!decision || typeof decision !== 'object') {
        throw new TypeError('host execution contract requires a route decision');
    }
    const executionClass = decision.executionClass === null || decision.executionClass === undefined
        ? null
        : normalizeExecutionClass(decision.executionClass);
    const assignmentWorkProfile = assignment?.workProfile || decision.workProfile || null;
    const contract = {
        schemaVersion: HOST_EXECUTION_CONTRACT_SCHEMA_VERSION,
        runId: stringOrNull(decision.runId),
        decisionId: stringOrNull(decision.decisionId),
        actionKind: stringOrNull(decision.actionKind),
        role: stringOrNull(decision.role),
        permissions: stringOrNull(decision.permissions),
        executionClass,
        workProfile: assignmentWorkProfile
            ? {
                executionClass: assignmentWorkProfile.executionClass ?? executionClass,
                complexity: stringOrNull(assignmentWorkProfile.complexity),
                independentContextRequired: assignmentWorkProfile.independentContextRequired === true,
                parallelizable: assignmentWorkProfile.parallelizable === true,
            }
            : null,
        executionMode: stringOrNull(assignment?.executionMode),
        requirements: semanticRequirements({ decision, assignment }),
        delegation: assignment?.delegation
            ? {
                mode: stringOrNull(assignment.delegation.mode),
                requested: assignment.delegation.requested === true,
            }
            : null,
        freshSessionRequired: assignment?.freshSessionRequired === true
            || decision.independentContextRequired === true,
        workUnit: normalizeWorkUnit(workUnit || capsule?.workUnit || {}),
        capsule: capsule
            ? {
                capsuleId: stringOrNull(capsule.capsuleId),
                capsuleDigest: stringOrNull(capsule.provenance?.capsuleDigest),
                stepId: stringOrNull(capsule.stepId),
            }
            : null,
        attemptId: stringOrNull(attemptId),
    };
    assertProviderNeutral(contract);
    return Object.freeze(contract);
};
export const validateHostExecutionContract = (contract) => {
    if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
        throw new TypeError('host execution contract must be an object');
    }
    const candidate = contract;
    if (candidate.schemaVersion !== HOST_EXECUTION_CONTRACT_SCHEMA_VERSION) {
        throw new HostExecutionContractError('host_execution_contract_schema_invalid', `host_execution_contract_schema_invalid:${String(candidate.schemaVersion)}`);
    }
    if (!candidate.runId || !candidate.decisionId || !candidate.actionKind) {
        throw new HostExecutionContractError('host_execution_contract_identity_missing', 'host_execution_contract_identity_missing');
    }
    if (candidate.executionClass !== null)
        normalizeExecutionClass(candidate.executionClass);
    for (const key of HOST_SEMANTIC_CAPABILITY_KEYS) {
        if (typeof candidate.requirements?.[key] !== 'boolean') {
            throw new HostExecutionContractError('host_execution_contract_requirement_invalid', `host_execution_contract_requirement_invalid:${key}`);
        }
    }
    assertProviderNeutral(candidate);
    return candidate;
};
export const admitHostExecutionContract = (contract, hostCapabilities = {}) => {
    const validated = validateHostExecutionContract(contract);
    const semantic = hostCapabilities.semantic || {};
    const missing = HOST_SEMANTIC_CAPABILITY_KEYS.filter((key) => (validated.requirements[key] === true && semantic[key] !== true));
    return Object.freeze({
        schemaVersion: 1,
        decision: missing.length === 0 ? 'admitted' : 'blocked',
        missingCapabilities: missing,
        rejectionCode: missing.length === 0 ? null : 'host_capability_unavailable',
    });
};
