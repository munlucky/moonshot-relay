// Provider prompt policy (Wave 3 / Wave 7). Resolves which prompt revisions,
// delegation limits, reasoning policy, and cache mechanics apply to one turn.
//
// Every capability defaults to false. A Host that forgets to declare support is
// treated as unable, and the turn falls back to the plain path with
// `provider-unsupported` in telemetry — the alternative, assuming support
// because the provider's documentation mentions a feature, produces requests
// that fail at dispatch and telemetry that lies about why.

import { COMMON_PROMPT_REVISION } from './prompts/common-execution.mjs';
import { CLAUDE_PROMPT_REVISION } from './prompts/claude-opus-5.mjs';
import { CODEX_PROMPT_REVISION } from './prompts/codex-gpt-5p6.mjs';
import { DEFAULT_MAX_NESTED_AGENTS } from './common-model-policy.mjs';

export const CACHE_MODES = Object.freeze(['off', 'shadow', 'on']);
export const PROVIDER_CACHE_MODES = Object.freeze(['none', 'implicit', 'explicit']);

export const DEFAULT_PROVIDER_CACHE_CAPABILITIES = Object.freeze({
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
});

export const normalizeProviderCacheCapabilities = (capabilities = {}) =>
  Object.freeze(Object.fromEntries(
    Object.keys(DEFAULT_PROVIDER_CACHE_CAPABILITIES).map((flag) => [flag, capabilities[flag] === true]),
  ));

export const PROVIDER_PROMPT_REVISION = Object.freeze({
  claude: CLAUDE_PROMPT_REVISION,
  codex: CODEX_PROMPT_REVISION,
});

export const CACHE_MISS_REASONS = Object.freeze([
  'cold-prefix', 'tool-schema-changed', 'common-prefix-changed', 'provider-prefix-changed',
  'project-prefix-changed', 'run-prefix-changed', 'model-changed', 'effort-changed',
  'speed-mode-changed', 'session-reset', 'provider-unsupported', 'usage-unreported', 'unknown',
]);

export const MODEL_ESCALATION_REASONS = Object.freeze([
  'risk-tier', 'complexity', 'repeated-failure', 'review-policy', 'user-request',
  'quality-regression', 'provider-fallback', 'unknown',
]);

const readMode = (value, fallback = 'shadow') => (CACHE_MODES.includes(String(value)) ? String(value) : fallback);

// Rollout is per provider on purpose: an explicit per-provider setting always
// wins, so a Claude regression can be rolled back with CLAUDE_OPTIMIZATION=off
// without touching Codex. But an operator who sets only the general
// MOON_RELAY_KERNEL_CACHE_MODE switch still expects it to take effect, so an
// *unset* provider variable inherits the resolved cache mode as its default
// rather than a hardcoded 'shadow' that could never be overridden by it.
export const resolveOptimizationModes = (env = process.env) => {
  const cacheMode = readMode(env.MOON_RELAY_KERNEL_CACHE_MODE);
  const genericModelPolicyMode = readMode(env.MOON_RELAY_KERNEL_MODEL_POLICY_MODE);
  // The final Kernel Codex profile is on by default, while an explicit
  // provider-specific or generic switch can still roll it back to shadow/off.
  // Claude continues to read the generic modelPolicyMode below and is not
  // changed by this Codex-only default.
  const codexModelPolicyMode = readMode(
    env.MOON_RELAY_KERNEL_CODEX_MODEL_POLICY_MODE
      ?? (env.MOON_RELAY_KERNEL_MODEL_POLICY_MODE !== undefined ? env.MOON_RELAY_KERNEL_MODEL_POLICY_MODE : 'on'),
  );
  return Object.freeze({
    cacheMode,
    modelPolicyMode: genericModelPolicyMode,
    codexModelPolicyMode,
    claude: readMode(env.MOON_RELAY_KERNEL_CLAUDE_OPTIMIZATION, cacheMode),
    codex: readMode(env.MOON_RELAY_KERNEL_CODEX_OPTIMIZATION, cacheMode),
  });
};

export const resolveProviderOptimizationMode = (provider, env = process.env) => {
  const modes = resolveOptimizationModes(env);
  return modes[String(provider)] ?? modes.cacheMode;
};

const resolveCachePolicy = ({ capabilities, requestedMode }) => {
  const caps = normalizeProviderCacheCapabilities(capabilities);
  if (!caps.supportsPromptCache) {
    return { requestedMode, providerMode: 'none', ttlClass: 'default', unsupportedReason: 'provider-unsupported' };
  }
  return {
    requestedMode,
    providerMode: caps.supportsExplicitCacheBreakpoints ? 'explicit' : 'implicit',
    ttlClass: 'default',
    unsupportedReason: null,
  };
};

const HIGH_RISK_SHAPES = Object.freeze(['security', 'authentication', 'authorization', 'payment', 'migration', 'data-loss', 'irreversible']);

export const resolveProviderPromptPolicy = ({
  provider = 'generic',
  role = 'implementer',
  riskTier = 'T1',
  action = 'implement',
  capabilities = {},
  env = process.env,
} = {}) => {
  const requestedMode = resolveProviderOptimizationMode(provider, env);
  const caps = normalizeProviderCacheCapabilities(capabilities);
  const highRisk = riskTier === 'T3';

  return Object.freeze({
    schemaVersion: 1,
    provider,
    commonPromptRevision: COMMON_PROMPT_REVISION,
    providerPromptRevision: PROVIDER_PROMPT_REVISION[provider] || null,
    allowNestedDelegation: false,
    maxNestedAgents: DEFAULT_MAX_NESTED_AGENTS,
    // A reviewer that inherits the implementer's session is not independent,
    // whatever the cache would save.
    requiresFreshSession: role === 'reviewer' || highRisk,
    reasoningPolicy: Object.freeze({
      // Persisted reasoning only helps while the goal and priorities hold; a
      // role change or an independent review must not inherit it.
      persistedReasoning: caps.supportsPersistedReasoning && role === 'implementer' && !highRisk ? 'all_turns' : 'current_turn',
      supported: caps.supportsPersistedReasoning,
    }),
    cachePolicy: Object.freeze(resolveCachePolicy({ capabilities: caps, requestedMode })),
    outputPolicy: Object.freeze({
      structuredOutputRequired: true,
      allowProseAroundStructuredOutput: false,
    }),
    capabilities: caps,
    highRiskShapes: HIGH_RISK_SHAPES,
  });
};
