// Generated from schemas/kernel.model-usage.schema.json. Edit the schema and run build:contracts.

export interface KernelModelUsage {
  schemaVersion: 1;
  receiptId: string;
  decisionId: string;
  runId: string;
  hostSurface: string;
  actorSessionId: string;
  parentSessionId: null | string;
  resolvedModel: null | string;
  resolvedEffort: null | string;
  requestedModel: null | string;
  requestedEffort: null | string;
  observedModel: null | string;
  observedEffort: null | string;
  executionProfileRevision?: null | string;
  role: null | string;
  actionKind: null | string;
  workProfile: null | {
    executionClass: null | 'planning' | 'complex_implementation' | 'review' | 'standard';
    complexity: 'standard' | 'routine' | 'complex' | 'large-refactor';
    repeatedFailure: boolean;
    independentContextRequired: boolean;
    parallelizable: boolean;
  };
  dispatchMechanism: null | string;
  enforcementReason: null | string;
  fallbackReason: null | string;
  attemptId: null | string;
  bindingId: null | string;
  capsuleId: null | string;
  capsuleDigest: null | string;
  admissionId: null | string;
  admissionDigest: null | string;
  stepId: null | string;
  enforcementStatus: 'enforced' | 'fallback' | 'advisory' | 'unsupported' | 'failed';
  resultStatus: 'failed' | 'completed' | 'interrupted' | 'abandoned';
  startedAt: null | string;
  finishedAt: null | string;
  wallClockMs: null | number;
  inputTokens: null | number;
  cachedInputTokens: null | number;
  outputTokens: null | number;
  costMicros: null | number;
  provider: null | string;
  surface: null | string;
  speedMode: null | string;
  reasoningContext: null | string;
  reasoningMode: null | string;
  delegationMode: null | string;
  sessionLineageId: null | string;
  previousResponseIdDigest: null | string;
  promptPrefixDigest: null | string;
  promptCacheKeyDigest: null | string;
  cacheMode: null | ('off' | 'shadow' | 'on');
  cacheTtl: null | string;
  cacheMissReason:
    | null
    | (
        | 'cold-prefix'
        | 'tool-schema-changed'
        | 'common-prefix-changed'
        | 'provider-prefix-changed'
        | 'project-prefix-changed'
        | 'run-prefix-changed'
        | 'model-changed'
        | 'effort-changed'
        | 'speed-mode-changed'
        | 'session-reset'
        | 'provider-unsupported'
        | 'usage-unreported'
        | 'unknown'
      );
  modelEscalationReason:
    | null
    | (
        | 'risk-tier'
        | 'complexity'
        | 'repeated-failure'
        | 'review-policy'
        | 'user-request'
        | 'quality-regression'
        | 'provider-fallback'
        | 'unknown'
      );
  eligiblePrefixTokens: null | number;
  uncachedInputTokens: null | number;
  cacheReadInputTokens: null | number;
  cacheWriteInputTokens: null | number;
  reasoningTokens: null | number;
  createdAt: string;
  promptMeasurement?: null | {
    segments: {
      kind: string;
      digest: string;
      cacheable: boolean;
      renderedBytes: number;
      tokenEstimate: number;
      loaded: boolean;
      includedVerbatimInProviderMessage: boolean;
    }[];
    renderedPromptBytes: number;
    renderedPromptTokenEstimate: number;
    cacheablePromptBytes: number;
    cacheablePromptTokenEstimate: number;
    providerMessageBytes: null | number;
    providerMessageTokenEstimate: null | number;
    providerMessageDigest: null | string;
  };
}
