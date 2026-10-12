// Generated from src/contracts/work-unit-scope.ts. Edit the source and run npm run build.
import path from 'node:path';
export const WORK_UNIT_SCOPE_ERROR_CODES = Object.freeze({
    missing: 'work-unit-scope-missing',
    workspaceWide: 'work-unit-scope-unbounded',
});
export const WORK_UNIT_SCOPE_NEXT_ACTION = 'revise-task-contract-with-scoped-allowedPaths';
const IMPLEMENTATION_ACTIONS = new Set(['implement', 'fix']);
const WORKSPACE_WIDE_PATTERNS = new Set(['*', '**']);
const DURABLE_STEP_FIELDS = ['stepId', 'sequence', 'planRevision'];
export const normalizeWorkUnitAllowedPaths = (allowedPaths) => (Array.isArray(allowedPaths)
    ? [...new Set(allowedPaths.map((entry) => String(entry).trim()).filter(Boolean))]
    : []);
export const isWorkspaceWideScope = (allowedPaths) => normalizeWorkUnitAllowedPaths(allowedPaths)
    .some((entry) => WORKSPACE_WIDE_PATTERNS.has(entry));
export const classifyWorkUnitScope = ({ allowedPaths = [], strict = false, } = {}) => {
    const normalized = normalizeWorkUnitAllowedPaths(allowedPaths);
    const invalidPath = normalized.find((candidate) => {
        const norm = candidate.replaceAll('\\', '/');
        return norm.startsWith('../') || norm === '..' || norm.includes('/../') || path.isAbsolute(candidate);
    });
    if (invalidPath) {
        return {
            valid: false,
            scopeState: 'invalid',
            reason: 'path-traversal',
            errorCode: 'contract-path-invalid',
            allowedPaths: normalized,
            nextAction: 'remove-traversal-paths',
            message: `Allowed paths must be repository-relative and cannot traverse outside project root: ${invalidPath}`,
        };
    }
    if (normalized.length === 0) {
        if (strict) {
            return {
                valid: false,
                scopeState: 'missing',
                reason: 'missing',
                errorCode: WORK_UNIT_SCOPE_ERROR_CODES.missing,
                allowedPaths: normalized,
                nextAction: WORK_UNIT_SCOPE_NEXT_ACTION,
                message: 'Ordinary implementation/fix dispatch requires one or more explicit repository-relative allowedPaths; declare a bounded work-unit scope before dispatch.',
            };
        }
        return {
            valid: true,
            scopeState: 'provisional',
            provisional: true,
            reason: 'empty-allowed-paths',
            errorCode: null,
            allowedPaths: [],
            nextAction: null,
            message: 'Provisional scope granted for Turn 0 execution within verified worktree boundary.',
        };
    }
    const workspaceWide = normalized.filter((entry) => WORKSPACE_WIDE_PATTERNS.has(entry));
    if (workspaceWide.length > 0) {
        if (strict) {
            return {
                valid: false,
                scopeState: 'workspace-wide',
                reason: 'workspace-wide',
                errorCode: WORK_UNIT_SCOPE_ERROR_CODES.workspaceWide,
                allowedPaths: normalized,
                workspaceWide,
                nextAction: WORK_UNIT_SCOPE_NEXT_ACTION,
                message: `Ordinary implementation/fix dispatch requires a bounded allowedPaths list; replace workspace-wide ${workspaceWide.join(', ')} with the specific repository paths this work unit may change.`,
            };
        }
        return {
            valid: true,
            scopeState: 'provisional',
            provisional: true,
            reason: 'workspace-wide',
            errorCode: null,
            allowedPaths: normalized,
            workspaceWide,
            nextAction: null,
            message: 'Provisional workspace-wide scope granted for Turn 0 execution within verified worktree boundary.',
        };
    }
    return {
        valid: true,
        scopeState: 'bounded',
        provisional: false,
        reason: null,
        errorCode: null,
        allowedPaths: normalized,
    };
};
export const requiresImplementationWorkUnitScope = ({ contract = null, step = null, } = {}) => {
    const source = contract && typeof contract === 'object' ? contract : {};
    const declaredSteps = Array.isArray(source.steps) && source.steps.length > 0;
    const durableNonSyntheticStep = Boolean(step
        && step.synthetic !== true
        && DURABLE_STEP_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(step, field)));
    return declaredSteps || durableNonSyntheticStep || source.strictBoundedScope === true;
};
export const resolveWorkUnitAllowedPaths = ({ step = null, contract = null, } = {}) => {
    const source = step && Object.prototype.hasOwnProperty.call(step, 'allowedPaths')
        ? step.allowedPaths
        : contract?.allowedPaths;
    return normalizeWorkUnitAllowedPaths(source);
};
export const inspectWorkUnitScope = ({ step = null, contract = null, strict = false, } = {}) => {
    const allowedPaths = resolveWorkUnitAllowedPaths({ step, contract });
    const requiresScope = requiresImplementationWorkUnitScope({ contract, step });
    const isStrict = strict || contract?.strictBoundedScope === true || requiresScope;
    if (!requiresScope && !isStrict) {
        return {
            valid: true,
            required: false,
            provisional: true,
            reason: null,
            errorCode: null,
            allowedPaths,
        };
    }
    return {
        ...classifyWorkUnitScope({ allowedPaths, strict: isStrict }),
        required: true,
    };
};
export class WorkUnitScopeError extends Error {
    code;
    errorCode;
    reason;
    allowedPaths;
    nextAction;
    scope;
    recoverable;
    blockingClass;
    constructor(scope) {
        super(scope.message || scope.errorCode || 'work unit scope invalid');
        this.name = 'WorkUnitScopeError';
        this.code = scope.errorCode;
        this.errorCode = scope.errorCode;
        this.reason = scope.reason;
        this.allowedPaths = scope.allowedPaths;
        this.nextAction = scope.nextAction || null;
        this.scope = scope;
        this.recoverable = scope.reason !== 'path-traversal' && scope.reason !== 'out-of-root';
        this.blockingClass = this.recoverable ? 'completion' : 'safety';
    }
}
export const assertImplementationWorkUnitScope = ({ step = null, contract = null, actionType = 'implement', } = {}) => {
    if (!IMPLEMENTATION_ACTIONS.has(String(actionType)))
        return inspectWorkUnitScope({ step, contract });
    const scope = inspectWorkUnitScope({ step, contract });
    if (!scope.valid)
        throw new WorkUnitScopeError(scope);
    return scope;
};
export const assertBoundedWorkUnitScope = assertImplementationWorkUnitScope;
export const workUnitScopeFailure = (error) => {
    const candidate = error && typeof error === 'object' ? error : {};
    const scope = candidate.scope || candidate;
    const errorCode = candidate.errorCode || candidate.code || scope.errorCode || WORK_UNIT_SCOPE_ERROR_CODES.missing;
    return {
        errorCode,
        failureCode: errorCode,
        errorSummary: candidate.message || scope.message || String(error),
        nextAction: candidate.nextAction || scope.nextAction || WORK_UNIT_SCOPE_NEXT_ACTION,
        scopeReason: candidate.reason || scope.reason || null,
        allowedPaths: candidate.allowedPaths || scope.allowedPaths || [],
        workspaceWide: candidate.workspaceWide || scope.workspaceWide || [],
        recoverable: candidate.recoverable ?? true,
        blockingClass: candidate.blockingClass || 'completion',
    };
};
