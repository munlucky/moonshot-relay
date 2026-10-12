// Provider prompt policy (Wave 3 / Wave 7). Resolves which prompt revisions,
// delegation limits, reasoning policy, and cache mechanics apply to one turn.
//
// Every capability defaults to false. A Host that forgets to declare support is
// treated as unable, and the turn falls back to the plain path with
// `provider-unsupported` in telemetry.

import { COMMON_PROMPT_REVISION } from './prompts/common-execution.js';
import { CLAUDE_PROMPT_REVISION } from './prompts/claude-opus-5.js';
import { CODEX_PROMPT_REVISION } from './prompts/codex-gpt-5p6.js';
import { DEFAULT_MAX_NESTED_AGENTS } from './common-model-policy.js';
import {
  CACHE_MODES,
  CACHE_MISS_REASONS,
  MODEL_ESCALATION_REASONS,
} from '../../contracts/model-execution.js';

export { CACHE_MODES, CACHE_MISS_REASONS, MODEL_ESCALATION_REASONS };

export type CacheMode = (typeof CACHE_MODES)[number];

export const PROVIDER_CACHE_MODES = Object.freeze([
  'none',
  'implicit',
  'explicit',
] as const);
export type ProviderCacheMode = (typeof PROVIDER_CACHE_MODES)[number];

export const OPENAI_RESPONSES_SERIALIZATION = 'openai-responses' as const;

export const resolveProviderPromptSerialization = (
  provider: unknown,
): typeof OPENAI_RESPONSES_SERIALIZATION | null => (
  String(provider) === 'openai'
    ? OPENAI_RESPONSES_SERIALIZATION
    : null
);

export interface ProviderCacheCapabilities {
  supportsPromptCache?: boolean;
  supportsExplicitCacheBreakpoints?: boolean;
  supportsCacheReadTokens?: boolean;
  supportsCacheWriteTokens?: boolean;
  supportsSessionContinuation?: boolean;
  supportsPersistedReasoning?: boolean;
  supportsProgrammaticToolCalling?: boolean;
  supportsProMode?: boolean;
  supportsFastMode?: boolean;
  supportsUltra?: boolean;
  supportsAdaptiveThinking?: boolean;
}

export type NormalizedProviderCacheCapabilities = Readonly<
  Required<ProviderCacheCapabilities>
>;

export const DEFAULT_PROVIDER_CACHE_CAPABILITIES: NormalizedProviderCacheCapabilities = Object.freeze({
  supportsPromptCache: false,
  supportsExplicitCacheBreakpoints: false,
  supportsCacheReadTokens: false,
  supportsCacheWriteTokens: false,
  supportsSessionContinuation: false,
  supportsPersistedReasoning: false,
  supportsProgrammaticToolCalling: false,
  supportsProMode: false,
  supportsFastMode: false,
  supportsUltra: false,
  supportsAdaptiveThinking: false,
});

const CAPABILITY_KEYS = Object.freeze(
  Object.keys(DEFAULT_PROVIDER_CACHE_CAPABILITIES) as Array<
    keyof ProviderCacheCapabilities
  >,
);

export const normalizeProviderCacheCapabilities = (
  capabilities: Partial<Record<keyof ProviderCacheCapabilities, unknown>> = {},
): NormalizedProviderCacheCapabilities => {
  const normalized = Object.fromEntries(
    CAPABILITY_KEYS.map((flag) => [flag, capabilities[flag] === true]),
  ) as Required<ProviderCacheCapabilities>;
  return Object.freeze(normalized);
};

export const PROVIDER_PROMPT_REVISION: Readonly<Record<string, string>> = Object.freeze({
  claude: CLAUDE_PROMPT_REVISION,
  codex: CODEX_PROMPT_REVISION,
});

const readMode = (
  value: unknown,
  fallback: CacheMode = 'shadow',
): CacheMode => (
  CACHE_MODES.includes(String(value) as CacheMode)
    ? String(value) as CacheMode
    : fallback
);

export interface OptimizationModes {
  cacheMode: CacheMode;
  modelPolicyMode: CacheMode;
  codexModelPolicyMode: CacheMode;
  claude: CacheMode;
  codex: CacheMode;
}

export const resolveOptimizationModes = (
  env: NodeJS.ProcessEnv = process.env,
): Readonly<OptimizationModes> => {
  const cacheMode = readMode(env.MOON_RELAY_KERNEL_CACHE_MODE);
  const genericModelPolicyMode = readMode(env.MOON_RELAY_KERNEL_MODEL_POLICY_MODE);
  const codexModelPolicyMode = readMode(
    env.MOON_RELAY_KERNEL_CODEX_MODEL_POLICY_MODE
      ?? (
        env.MOON_RELAY_KERNEL_MODEL_POLICY_MODE !== undefined
          ? env.MOON_RELAY_KERNEL_MODEL_POLICY_MODE
          : 'on'
      ),
  );
  return Object.freeze({
    cacheMode,
    modelPolicyMode: genericModelPolicyMode,
    codexModelPolicyMode,
    claude: readMode(
      env.MOON_RELAY_KERNEL_CLAUDE_OPTIMIZATION,
      cacheMode,
    ),
    codex: readMode(
      env.MOON_RELAY_KERNEL_CODEX_OPTIMIZATION,
      cacheMode,
    ),
  });
};

export const resolveProviderOptimizationMode = (
  provider: unknown,
  env: NodeJS.ProcessEnv = process.env,
): CacheMode => {
  const modes = resolveOptimizationModes(env);
  const normalized = String(provider);
  if (normalized === 'claude') return modes.claude;
  if (normalized === 'codex') return modes.codex;
  return modes.cacheMode;
};

interface ResolvedCachePolicy {
  requestedMode: CacheMode;
  providerMode: ProviderCacheMode;
  ttlClass: 'default';
  unsupportedReason: string | null;
}

const resolveCachePolicy = ({
  capabilities,
  requestedMode,
}: {
  capabilities: ProviderCacheCapabilities;
  requestedMode: CacheMode;
}): ResolvedCachePolicy => {
  const caps = normalizeProviderCacheCapabilities(capabilities);
  if (!caps.supportsPromptCache) {
    return {
      requestedMode,
      providerMode: 'none',
      ttlClass: 'default',
      unsupportedReason: 'provider-unsupported',
    };
  }
  return {
    requestedMode,
    providerMode: caps.supportsExplicitCacheBreakpoints ? 'explicit' : 'implicit',
    ttlClass: 'default',
    unsupportedReason: null,
  };
};

const HIGH_RISK_SHAPES = Object.freeze([
  'security',
  'authentication',
  'authorization',
  'payment',
  'migration',
  'data-loss',
  'irreversible',
] as const);

export const resolveProviderPromptPolicy = ({
  provider = 'generic',
  role = 'implementer',
  riskTier = 'T1',
  action: _action = 'implement',
  capabilities = {},
  env = process.env,
}: {
  provider?: string;
  role?: string;
  riskTier?: string;
  action?: string;
  capabilities?: ProviderCacheCapabilities;
  env?: NodeJS.ProcessEnv;
} = {}) => {
  const requestedMode = resolveProviderOptimizationMode(provider, env);
  const caps = normalizeProviderCacheCapabilities(capabilities);
  const highRisk = riskTier === 'T3';

  return Object.freeze({
    schemaVersion: 1 as const,
    provider,
    commonPromptRevision: COMMON_PROMPT_REVISION,
    providerPromptRevision: PROVIDER_PROMPT_REVISION[provider] || null,
    allowNestedDelegation: false,
    maxNestedAgents: DEFAULT_MAX_NESTED_AGENTS,
    requiresFreshSession: role === 'reviewer' || highRisk,
    reasoningPolicy: Object.freeze({
      persistedReasoning: caps.supportsPersistedReasoning
        && role === 'implementer'
        && !highRisk
        ? 'all_turns'
        : 'current_turn',
      supported: caps.supportsPersistedReasoning,
    }),
    cachePolicy: Object.freeze(
      resolveCachePolicy({
        capabilities: caps,
        requestedMode,
      }),
    ),
    outputPolicy: Object.freeze({
      structuredOutputRequired: true,
      allowProseAroundStructuredOutput: false,
    }),
    capabilities: caps,
    highRiskShapes: HIGH_RISK_SHAPES,
  });
};
