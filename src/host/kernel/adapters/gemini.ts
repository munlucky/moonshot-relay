// Gemini execution is a Host concern. A concrete launcher must declare the
// mechanisms it enforces; a CLI name alone proves no execution capability.

import {
  buildModelVisiblePromptMessage,
  buildModelVisiblePromptView,
} from '../model-capsule-view.js';
import {
  admitHostExecutionContract,
  validateHostExecutionContract,
} from '../../../contracts/host-execution-contract.js';

type UnknownRecord = Record<string, unknown>;

interface GeminiCapabilities extends UnknownRecord {
  supportsReadOnlyReview?: boolean;
  workspaceWrite?: boolean;
  workspaceIsolation?: boolean;
  parallelExecution?: boolean;
}

interface GeminiDecision {
  role?: unknown;
  permissions?: unknown;
}

interface GeminiResolution {
  model?: unknown;
}

interface GeminiLaunchRequest {
  model: string | null;
  message: string;
  modelVisiblePrompt: unknown;
  workingDirectory: string | null;
  environment: NodeJS.ProcessEnv | null;
  readOnly: boolean;
  freshContext: true;
}

type GeminiLaunch = (request: GeminiLaunchRequest) => Promise<unknown> | unknown;

interface GeminiDispatchInput {
  decision?: GeminiDecision;
  resolution?: GeminiResolution;
  hostExecutionContract?: unknown;
  executionCapsule?: unknown;
  modelInput?: UnknownRecord;
  workingDirectory?: string | null;
  environment?: NodeJS.ProcessEnv | null;
}

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);

// Bind its actual Host adapter inputs at one seam.
const buildPromptView = buildModelVisiblePromptView;
const buildPromptMessage = buildModelVisiblePromptMessage;

export const createGeminiAdapter = ({
  launch = null,
  capabilities = {},
}: {
  launch?: GeminiLaunch | null;
  capabilities?: GeminiCapabilities;
} = {}) => {
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
    surface: 'gemini',
    capabilities: resolved,
    ownerDirectAvailable: false,
    ownerDirectDefault: false,
    nativeDelegationAvailable: available,

    async dispatch({
      decision = {},
      resolution = {},
      hostExecutionContract,
      executionCapsule = null,
      modelInput = {},
      workingDirectory = null,
      environment = null,
    }: GeminiDispatchInput) {
      validateHostExecutionContract(hostExecutionContract);
      const admission = admitHostExecutionContract(
        hostExecutionContract,
        resolved,
      );
      if (!available || !launch || admission.decision !== 'admitted') {
        return {
          status: 'blocked',
          resultStatus: 'blocked',
          resolvedModel: null,
          actorSessionId: null,
          errorCode: 'gemini_host_capability_unavailable',
          failureCategory: 'host',
          admission,
        };
      }

      const prompt = buildPromptView({
        modelInput,
        capsule: executionCapsule,
      });
      const result = asRecord(await launch({
        model: resolution.model ? String(resolution.model) : null,
        message: buildPromptMessage({
          prompt,
          review: decision.role === 'reviewer',
        }),
        modelVisiblePrompt: prompt,
        workingDirectory,
        environment,
        readOnly: decision.permissions === 'read_only',
        freshContext: true,
      }));

      // Observe session/model/tokens from the actual result. Requested settings
      // are not evidence that the provider executed them.
      const observedModel = result.resolvedModel
        ? String(result.resolvedModel)
        : null;
      return {
        status: String(result.status || 'failed'),
        resultStatus: String(result.resultStatus || result.status || 'failed'),
        requestedModel: resolution.model ? String(resolution.model) : null,
        resolvedModel: observedModel,
        observedModel,
        observedEffort: null,
        resolvedEffort: null,
        actorSessionId: result.sessionId ? String(result.sessionId) : null,
        dispatchMechanism: 'gemini-fresh-process',
        report: decision.role === 'reviewer' ? null : result.report || null,
        outcome: decision.role === 'reviewer' ? result.outcome || null : null,
        inputTokens: result.inputTokens ?? null,
        outputTokens: result.outputTokens ?? null,
        cachedInputTokens: result.cachedInputTokens ?? null,
        wallClockMs: result.wallClockMs ?? null,
        errorCode: result.errorCode ? String(result.errorCode) : null,
        errorSummary: result.errorSummary ? String(result.errorSummary) : null,
      };
    },
  };
};
