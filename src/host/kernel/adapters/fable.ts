// Fable / generic Host adapter (§11.3). Model override is not verified on this
// surface, so it declares nothing it cannot prove and reports `unsupported`.
// Work still proceeds on the current model — it is simply not counted as
// routed. Assuming an unverified capability is the failure mode this prevents.

import {
  buildModelVisiblePromptMessage,
  buildModelVisiblePromptView,
} from '../model-capsule-view.js';

type UnknownRecord = Record<string, unknown>;

interface FableDecision {
  modelClass?: unknown;
  permissions?: unknown;
  role?: unknown;
}

interface FableResolution {
  model?: unknown;
}

interface FableDispatchInput {
  decision: FableDecision;
  resolution: FableResolution;
  strategy?: unknown;
  executionCapsule?: unknown;
  modelInput?: UnknownRecord;
}

interface FableLaunchInput {
  message: string;
  modelVisiblePrompt: unknown;
  prompt: unknown;
}

type FableLaunch = (input: FableLaunchInput) => Promise<unknown> | unknown;

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);

const buildPromptView = buildModelVisiblePromptView;
const buildPromptMessage = buildModelVisiblePromptMessage;

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

export const createFableAdapter = ({
  surface = 'fable',
  capabilities = {},
  launch = null,
}: {
  surface?: string;
  capabilities?: UnknownRecord;
  launch?: FableLaunch | null;
} = {}) => {
  const resolved = { ...FALLBACK_CAPABILITIES, ...capabilities, surface };
  return {
    surface,
    capabilities: resolved,
    async dispatch({
      decision,
      resolution,
      strategy: _strategy,
      executionCapsule = null,
      modelInput = {},
    }: FableDispatchInput) {
      const advisory = {
        requestedModelClass: decision.modelClass,
        advisoryModel: resolution.model,
        permissions: decision.permissions,
      };
      if (!launch) {
        return {
          status: 'unsupported',
          resultStatus: 'completed',
          resolvedModel: null,
          advisory,
        };
      }
      const modelVisiblePrompt = buildPromptView({
        modelInput,
        capsule: executionCapsule,
      });
      const result = asRecord(await launch({
        message: buildPromptMessage({
          prompt: modelVisiblePrompt,
          review: decision.role === 'reviewer',
        }),
        modelVisiblePrompt,
        prompt: modelVisiblePrompt,
      }));
      return {
        status: String(result.status || 'unsupported'),
        resultStatus: String(result.resultStatus || 'completed'),
        resolvedModel: result.resolvedModel ?? null,
        actorSessionId: result.sessionId ? String(result.sessionId) : null,
        advisory,
      };
    },
  };
};
