// Host prompt envelope (Wave 3). Compiles one turn into ordered segments plus
// the identity a provider cache and a session lineage are keyed on.

import { createHash } from 'node:crypto';
import { canonicalJson } from '../../shared/canonical-digest.js';
import {
  COMMON_EXECUTION_PROMPT,
  COMMON_PROMPT_REVISION,
} from './prompts/common-execution.js';
import { CLAUDE_PROVIDER_PROMPT } from './prompts/claude-opus-5.js';
import { CODEX_PROVIDER_PROMPT } from './prompts/codex-gpt-5p6.js';
import { validateHostExecutionContract } from '../../contracts/host-execution-contract.js';
import {
  renderToolManifestSegment,
  type ToolManifest,
} from './tool-manifest.js';
import {
  resolveProviderPromptPolicy,
  type ProviderCacheCapabilities,
} from './provider-prompt-policy.js';

type UnknownRecord = Record<string, unknown>;

export const ENVELOPE_SCHEMA_VERSION = 2;

export const SEGMENT_KINDS = Object.freeze([
  'tool-stable',
  'common-host-stable',
  'provider-stable',
  'project-stable',
  'run-stable',
  'volatile',
] as const);

export type SegmentKind = (typeof SEGMENT_KINDS)[number];

export const PREFIX_EXCLUDED_FIELDS = Object.freeze([
  'runId',
  'stepId',
  'capsuleId',
  'timestamp',
  'workspaceIdentity',
  'mutationRevision',
  'routeDecisionId',
  'admissionId',
  'evidence',
  'toolResult',
] as const);

export interface PromptSegment {
  kind: SegmentKind;
  provider?: string;
  content: string;
  digest: string;
  cacheable: boolean;
  tokenEstimate: number;
}

export interface PromptSegmentMeasurement {
  kind: SegmentKind;
  digest: string;
  cacheable: boolean;
  renderedBytes: number;
  tokenEstimate: number;
  loaded: boolean;
  includedVerbatimInProviderMessage: boolean;
}

export interface PromptEnvelopeMeasurement {
  segments: readonly Readonly<PromptSegmentMeasurement>[];
  renderedPromptBytes: number;
  renderedPromptTokenEstimate: number;
  cacheablePromptBytes: number;
  cacheablePromptTokenEstimate: number;
  providerMessageBytes: number | null;
  providerMessageTokenEstimate: number | null;
  providerMessageDigest: string | null;
}

export interface PromptCacheIdentity {
  provider: string;
  surface: string;
  role: string;
  resolvedModel: unknown;
  resolvedEffort: unknown;
  toolSchemaDigest: string | null;
  commonHostStableDigest: string;
  providerStableDigest: string;
  projectStableDigest: string;
  runStableDigest: string;
  prefixDigest: string;
}

interface SegmentContent {
  content?: unknown;
}

export interface PromptContextSegments {
  projectStable?: SegmentContent;
  runStable?: SegmentContent;
  volatile?: SegmentContent;
  [key: string]: unknown;
}

export interface PromptModelPolicy {
  executionClass?: unknown;
  modelClass?: (unknown) | undefined;
  resolvedModel?: unknown;
  resolvedEffort?: unknown;
  speedMode?: unknown;
  policyRevision?: unknown;
}

export interface PromptControl {
  runId?: (unknown) | undefined;
  stepId?: (unknown) | undefined;
  capsuleId?: (unknown) | undefined;
  routeDecisionId?: unknown;
  admissionId?: unknown;
  mutationRevision?: unknown;
  [key: string]: unknown;
}

export interface PromptEnvelope {
  schemaVersion: 2;
  segments: readonly Readonly<PromptSegment>[];
  cacheIdentity: Readonly<PromptCacheIdentity>;
  modelPolicy: Readonly<{
    executionClass: unknown;
    modelClass: unknown;
    resolvedModel: unknown;
    resolvedEffort: unknown;
    speedMode: unknown;
    policyRevision: unknown;
    reasoningContext: string;
    delegationMode: 'bounded' | 'none';
  }>;
  cachePolicy: Readonly<{
    requestedMode: string;
    providerMode: string;
    ttlClass: string;
    unsupportedReason: string | null;
  }>;
  commonPromptRevision: string;
  providerPromptRevision: string | null;
  control: Readonly<{
    runId: unknown;
    stepId: unknown;
    capsuleId: unknown;
    routeDecisionId: unknown;
    admissionId: unknown;
    mutationRevision: unknown;
  }>;
}


const recordOf = (value: unknown): UnknownRecord | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
);

const semanticError = (field: string, reason = 'invalid'): never => {
  throw new TypeError(`prompt_semantic_field_${reason}:${field}`);
};

const requireOwn = (record: UnknownRecord, key: string, field: string): unknown => {
  if (!Object.hasOwn(record, key)) semanticError(field, 'missing');
  return record[key];
};

const requiredText = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) semanticError(field);
  return value as string;
};

const requiredStringList = (value: unknown, field: string): readonly string[] => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    semanticError(field);
  }
  return Object.freeze([...(value as string[])]);
};

const requiredArray = (value: unknown, field: string): readonly unknown[] => {
  if (!Array.isArray(value)) semanticError(field);
  return Object.freeze([...(value as unknown[])]);
};

const normalizedWorkUnit = (value: unknown) => {
  const workUnit = recordOf(value);
  if (!workUnit) semanticError('context.workUnit');
  return Object.freeze({
    objective: requiredText(workUnit?.objective, 'context.workUnit.objective'),
    allowedPaths: requiredStringList(workUnit?.allowedPaths, 'constraints.scope.allowedPaths'),
    forbiddenPaths: requiredStringList(workUnit?.forbiddenPaths, 'constraints.scope.forbiddenPaths'),
    expectedOutputs: requiredStringList(workUnit?.expectedOutputs, 'context.workUnit.expectedOutputs'),
  });
};

const assertWorkUnitMatches = (
  modelContext: UnknownRecord,
  workUnit: ReturnType<typeof normalizedWorkUnit>,
): void => {
  const current = modelContext.currentWork;
  if (current === undefined || current === null) return;
  const currentWork = recordOf(current);
  if (!currentWork) semanticError('context.currentWorkUnit');
  for (const field of ['objective', 'allowedPaths', 'forbiddenPaths', 'expectedOutputs'] as const) {
    const observed = currentWork?.[field];
    if (observed === undefined) continue;
    const expected = workUnit[field];
    const normalized = Array.isArray(expected)
      ? requiredStringList(observed, `context.currentWorkUnit.${field}`)
      : requiredText(observed, `context.currentWorkUnit.${field}`);
    if (JSON.stringify(normalized) !== JSON.stringify(expected)) {
      semanticError(`context.currentWorkUnit.${field}`, 'source_mismatch');
    }
  }
};

export const buildCommonPromptRequest = ({
  hostExecutionContract,
  modelContext,
  toolManifest,
}: {
  hostExecutionContract: unknown;
  modelContext: unknown;
  toolManifest: ToolManifest;
}) => {
  const contract = validateHostExecutionContract(hostExecutionContract);
  const context = recordOf(modelContext);
  if (!context) semanticError('context');
  if (!toolManifest || toolManifest.schemaVersion !== 1 || !Array.isArray(toolManifest.tools)) {
    semanticError('context.availableTools');
  }

  const workUnit = normalizedWorkUnit(contract.workUnit);
  assertWorkUnitMatches(context as UnknownRecord, workUnit);

  const acceptance = requiredArray(
    requireOwn(context as UnknownRecord, 'acceptance', 'doneWhen.acceptance'),
    'doneWhen.acceptance',
  );
  for (const entry of acceptance) {
    if (typeof entry === 'string' ? !entry.trim() : !requiredText(recordOf(entry)?.statement, 'doneWhen.acceptance')) {
      semanticError('doneWhen.acceptance');
    }
  }

  const knowledge = requireOwn(
    context as UnknownRecord,
    'relevantProjectKnowledge',
    'context.relevantProjectKnowledge',
  );
  if (knowledge !== null && typeof knowledge !== 'object') {
    semanticError('context.relevantProjectKnowledge');
  }

  const tools = Object.freeze(toolManifest.tools.map((tool) => {
    requiredText(tool?.name, 'context.availableTools');
    requiredText(tool?.schemaDigest, 'context.availableTools');
    if (typeof tool?.description !== 'string') semanticError('context.availableTools');
    return Object.freeze({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      schemaDigest: tool.schemaDigest,
    });
  }));

  return Object.freeze({
    goal: Object.freeze({
      objective: requiredText(
        requireOwn(context as UnknownRecord, 'objective', 'goal.objective'),
        'goal.objective',
      ),
    }),
    context: Object.freeze({
      workUnit,
      relevantProjectKnowledge: knowledge,
      availableTools: tools,
    }),
    constraints: Object.freeze({
      task: requiredStringList(
        requireOwn(context as UnknownRecord, 'constraints', 'constraints.task'),
        'constraints.task',
      ),
      scope: Object.freeze({
        allowedPaths: workUnit.allowedPaths,
        forbiddenPaths: workUnit.forbiddenPaths,
      }),
      mutationAuthority: requiredText(
        contract.permissions,
        'constraints.mutationAuthority',
      ),
    }),
    doneWhen: Object.freeze({
      acceptance,
      requiredVerification: requiredArray(requireOwn(
        context as UnknownRecord,
        'requiredEvidence',
        'doneWhen.requiredVerification',
      ), 'doneWhen.requiredVerification'),
      completionCondition: Object.freeze({
        authority: 'kernel' as const,
        acceptanceRequired: true as const,
        verificationRequired: true as const,
      }),
    }),
  });
};

const digest = (text: unknown): string => (
  `sha256:${createHash('sha256')
    .update(String(text ?? ''))
    .digest('hex')}`
);

const estimateTokens = (text: unknown): number => (
  Math.ceil(String(text ?? '').length / 4)
);

const PROVIDER_PROMPT: Readonly<Record<string, string>> = Object.freeze({
  claude: CLAUDE_PROVIDER_PROMPT,
  codex: CODEX_PROVIDER_PROMPT,
});

const makeSegment = (
  kind: SegmentKind,
  content: unknown,
  {
    cacheable,
    provider = null,
  }: {
    cacheable: boolean;
    provider?: string | null;
  },
): Readonly<PromptSegment> => Object.freeze({
  kind,
  ...(provider ? { provider } : {}),
  content: String(content ?? ''),
  digest: digest(content),
  cacheable,
  tokenEstimate: estimateTokens(content),
});

export const buildPrefixDigest = ({
  provider,
  surface,
  role,
  resolvedModel,
  resolvedEffort,
  toolSchemaDigest,
  commonHostStableDigest,
  providerStableDigest,
  projectStableDigest,
  runStableDigest,
}: {
  provider?: unknown;
  surface?: unknown;
  role?: unknown;
  resolvedModel?: unknown;
  resolvedEffort?: unknown;
  toolSchemaDigest?: unknown;
  commonHostStableDigest?: unknown;
  providerStableDigest?: unknown;
  projectStableDigest?: unknown;
  runStableDigest?: unknown;
} = {}): string => (
  `sha256:${createHash('sha256').update(canonicalJson({
    provider: provider ?? null,
    surface: surface ?? null,
    role: role ?? null,
    resolvedModel: resolvedModel ?? null,
    resolvedEffort: resolvedEffort ?? null,
    toolSchemaDigest: toolSchemaDigest ?? null,
    commonHostStableDigest: commonHostStableDigest ?? null,
    providerStableDigest: providerStableDigest ?? null,
    projectStableDigest: projectStableDigest ?? null,
    runStableDigest: runStableDigest ?? null,
  })).digest('hex')}`
);

export const buildPromptEnvelope = ({
  provider = 'generic',
  surface = null,
  role = 'implementer',
  action = 'implement',
  riskTier = 'T1',
  toolManifest,
  contextSegments = {},
  modelPolicy = {},
  capabilities = {},
  control = {},
  env = process.env,
}: {
  provider?: (string) | undefined;
  surface?: (string | null) | undefined;
  role?: (string) | undefined;
  action?: (string) | undefined;
  riskTier?: (string) | undefined;
  toolManifest: ToolManifest;
  contextSegments?: PromptContextSegments;
  modelPolicy?: PromptModelPolicy;
  capabilities?: ProviderCacheCapabilities;
  control?: PromptControl;
  env?: NodeJS.ProcessEnv;
}): Readonly<PromptEnvelope> => {
  const policy = resolveProviderPromptPolicy({
    provider,
    role,
    riskTier,
    action,
    capabilities,
    env,
  });

  const segments = [
    makeSegment(
      'tool-stable',
      renderToolManifestSegment(toolManifest),
      { cacheable: true },
    ),
    makeSegment(
      'common-host-stable',
      COMMON_EXECUTION_PROMPT,
      { cacheable: true },
    ),
    makeSegment(
      'provider-stable',
      PROVIDER_PROMPT[provider] || '',
      { cacheable: true, provider },
    ),
    makeSegment(
      'project-stable',
      contextSegments.projectStable?.content || '',
      { cacheable: true },
    ),
    makeSegment(
      'run-stable',
      contextSegments.runStable?.content || '',
      { cacheable: true },
    ),
    makeSegment(
      'volatile',
      contextSegments.volatile?.content || '',
      { cacheable: false },
    ),
  ] as const;

  const byKind = Object.fromEntries(
    segments.map((segment) => [segment.kind, segment]),
  ) as Record<SegmentKind, Readonly<PromptSegment>>;

  const cacheIdentityBase = {
    provider,
    surface: surface || provider,
    role,
    resolvedModel: modelPolicy.resolvedModel ?? null,
    resolvedEffort: modelPolicy.resolvedEffort ?? null,
    toolSchemaDigest: toolManifest.toolSchemaDigest ?? null,
    commonHostStableDigest: byKind['common-host-stable'].digest,
    providerStableDigest: byKind['provider-stable'].digest,
    projectStableDigest: byKind['project-stable'].digest,
    runStableDigest: byKind['run-stable'].digest,
  };

  return Object.freeze({
    schemaVersion: ENVELOPE_SCHEMA_VERSION as 2,
    segments: Object.freeze(segments),
    cacheIdentity: Object.freeze({
      ...cacheIdentityBase,
      prefixDigest: buildPrefixDigest(cacheIdentityBase),
    }),
    modelPolicy: Object.freeze({
      executionClass: modelPolicy.executionClass ?? null,
      modelClass: modelPolicy.modelClass ?? null,
      resolvedModel: modelPolicy.resolvedModel ?? null,
      resolvedEffort: modelPolicy.resolvedEffort ?? null,
      speedMode: modelPolicy.speedMode ?? null,
      policyRevision: modelPolicy.policyRevision ?? null,
      reasoningContext: policy.reasoningPolicy.persistedReasoning,
      delegationMode: policy.allowNestedDelegation ? 'bounded' : 'none',
    }),
    cachePolicy: policy.cachePolicy,
    commonPromptRevision: COMMON_PROMPT_REVISION,
    providerPromptRevision: policy.providerPromptRevision,
    control: Object.freeze({
      runId: control.runId ?? null,
      stepId: control.stepId ?? null,
      capsuleId: control.capsuleId ?? null,
      routeDecisionId: control.routeDecisionId ?? null,
      admissionId: control.admissionId ?? null,
      mutationRevision: control.mutationRevision ?? null,
    }),
  });
};

export const renderCacheablePrompt = (
  envelope: PromptEnvelope,
): string => envelope.segments
  .filter((segment) => segment.cacheable)
  .map((segment) => segment.content)
  .filter(Boolean)
  .join('\n\n');

export const renderFullPrompt = (
  envelope: PromptEnvelope,
): string => envelope.segments
  .map((segment) => segment.content)
  .filter(Boolean)
  .join('\n\n');

export const measurePromptEnvelope = (
  envelope: PromptEnvelope,
  { providerMessage = null }: { providerMessage?: string | null } = {},
): Readonly<PromptEnvelopeMeasurement> => {
  const fullPrompt = renderFullPrompt(envelope);
  const cacheablePrompt = renderCacheablePrompt(envelope);
  const normalizedProviderMessage = typeof providerMessage === 'string'
    ? providerMessage
    : null;

  return Object.freeze({
    segments: Object.freeze(envelope.segments.map((segment) => Object.freeze({
      kind: segment.kind,
      digest: segment.digest,
      cacheable: segment.cacheable,
      renderedBytes: Buffer.byteLength(segment.content, 'utf8'),
      tokenEstimate: segment.tokenEstimate,
      loaded: segment.content.length > 0,
      includedVerbatimInProviderMessage: Boolean(
        normalizedProviderMessage
        && segment.content.length > 0
        && normalizedProviderMessage.includes(segment.content),
      ),
    }))),
    renderedPromptBytes: Buffer.byteLength(fullPrompt, 'utf8'),
    renderedPromptTokenEstimate: estimateTokens(fullPrompt),
    cacheablePromptBytes: Buffer.byteLength(cacheablePrompt, 'utf8'),
    cacheablePromptTokenEstimate: estimateTokens(cacheablePrompt),
    providerMessageBytes: normalizedProviderMessage === null
      ? null
      : Buffer.byteLength(normalizedProviderMessage, 'utf8'),
    providerMessageTokenEstimate: normalizedProviderMessage === null
      ? null
      : estimateTokens(normalizedProviderMessage),
    providerMessageDigest: normalizedProviderMessage === null
      ? null
      : digest(normalizedProviderMessage),
  });
};

export const findControlLeaks = (
  envelope: PromptEnvelope,
): string[] => {
  const prompt = renderFullPrompt(envelope);
  return Object.entries(envelope.control)
    .filter(([, value]) => (
      value !== null
      && value !== undefined
      && String(value).length >= 6
      && prompt.includes(String(value))
    ))
    .map(([field]) => field)
    .sort();
};
