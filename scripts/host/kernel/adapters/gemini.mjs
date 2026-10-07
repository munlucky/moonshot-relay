// Gemini execution is a Host concern. A concrete launcher must declare the
// mechanisms it enforces; a CLI name alone proves no execution capability.
import { buildModelVisiblePromptMessage, buildModelVisiblePromptView } from '../model-capsule-view.mjs';
import { admitHostExecutionContract, validateHostExecutionContract } from '../../../kernel/run/host-execution-contract.mjs';

export const createGeminiAdapter = ({ launch = null, capabilities = {} } = {}) => {
  const available = typeof launch === 'function';
  const readOnly = available && capabilities.supportsReadOnlyReview === true;
  const resolved = Object.freeze({
    ...capabilities,
    surface: 'gemini',
    supportsSessionModelOverride: available,
    supportsSubagentModel: available,
    supportsIndependentContext: available,
    supportsReadOnlyReview: readOnly,
    supportsResolvedModelIdentity: available,
    supportsUsageTokens: available,
    supportsPromptCache: false,
    supportsSessionContinuation: false,
    semantic: Object.freeze({
      freshContext: available,
      workspaceWrite: available && capabilities.workspaceWrite === true,
      workspaceIsolation: available && capabilities.workspaceIsolation === true,
      parallelExecution: available && capabilities.parallelExecution === true,
      independentReview: readOnly,
      modelSelection: available,
    }),
  });
  return {
    surface: 'gemini', capabilities: resolved,
    ownerDirectAvailable: false, ownerDirectDefault: false,
    nativeDelegationAvailable: available,
    async dispatch({ decision, resolution = {}, hostExecutionContract, executionCapsule = null,
      modelInput = {}, workingDirectory = null, environment = null }) {
      validateHostExecutionContract(hostExecutionContract);
      const admission = admitHostExecutionContract(hostExecutionContract, resolved);
      if (!available || admission.decision !== 'admitted') return {
        status: 'blocked', resultStatus: 'blocked', resolvedModel: null,
        actorSessionId: null, errorCode: 'gemini_host_capability_unavailable',
        failureCategory: 'host', admission,
      };
      const prompt = buildModelVisiblePromptView({ modelInput, capsule: executionCapsule });
      const result = await launch({
        model: resolution.model || null,
        message: buildModelVisiblePromptMessage({ prompt, review: decision.role === 'reviewer' }),
        modelVisiblePrompt: prompt,
        workingDirectory, environment,
        readOnly: decision.permissions === 'read_only',
        freshContext: true,
      });
      // Observe session/model/tokens from the actual result. Requested settings
      // are not evidence that the provider executed them.
      return {
        status: result?.status || 'failed',
        resultStatus: result?.resultStatus || result?.status || 'failed',
        requestedModel: resolution.model || null,
        resolvedModel: result?.resolvedModel || null,
        observedModel: result?.resolvedModel || null,
        observedEffort: null, resolvedEffort: null,
        actorSessionId: result?.sessionId || null,
        dispatchMechanism: 'gemini-fresh-process',
        report: decision.role === 'reviewer' ? null : result?.report || null,
        outcome: decision.role === 'reviewer' ? result?.outcome || null : null,
        inputTokens: result?.inputTokens ?? null,
        outputTokens: result?.outputTokens ?? null,
        cachedInputTokens: result?.cachedInputTokens ?? null,
        wallClockMs: result?.wallClockMs ?? null,
        errorCode: result?.errorCode || null,
        errorSummary: result?.errorSummary || null,
      };
    },
  };
};
