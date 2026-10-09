// Fable / generic Host adapter (§11.3). Model override is not verified on this
// surface, so it declares nothing it cannot prove and reports `unsupported`.
// Work still proceeds on the current model — it is simply not counted as
// routed. Assuming an unverified capability is the failure mode this prevents.

import { buildModelVisiblePromptMessage, buildModelVisiblePromptView } from '../model-capsule-view.mjs';

export const FALLBACK_CAPABILITIES = Object.freeze({
  surface: 'fable',
  supportsSubagentModel: false,
  supportsSessionModelOverride: false,
  supportsIndependentContext: false,
  supportsUsageTokens: false,
  supportsResolvedModelIdentity: false,
  semantic: Object.freeze({
    freshContext: false,
    workspaceWrite: true,
    workspaceIsolation: false,
    parallelExecution: false,
    independentReview: false,
    modelSelection: false,
  }),
});

export const createFableAdapter = ({ surface = 'fable', capabilities = {}, launch = null } = {}) => {
  const resolved = { ...FALLBACK_CAPABILITIES, ...capabilities, surface };
  return {
    surface,
    capabilities: resolved,
    async dispatch({ decision, resolution, strategy, executionCapsule = null, modelInput = {} }) {
      const advisory = {
        requestedModelClass: decision.modelClass,
        advisoryModel: resolution.model,
        permissions: decision.permissions,
      };
      if (!launch) return { status: 'unsupported', resultStatus: 'completed', resolvedModel: null, advisory };
      const modelVisiblePrompt = buildModelVisiblePromptView({ modelInput, capsule: executionCapsule });
      const result = (await launch({
        message: buildModelVisiblePromptMessage({ prompt: modelVisiblePrompt, review: decision.role === 'reviewer' }),
        modelVisiblePrompt,
        prompt: modelVisiblePrompt,
      })) || {};
      return {
        status: result.status || 'unsupported',
        resultStatus: result.resultStatus || 'completed',
        resolvedModel: result.resolvedModel ?? null,
        actorSessionId: result.sessionId || null,
        advisory,
      };
    },
  };
};
