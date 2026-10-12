import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveProviderPromptPolicy, normalizeProviderCacheCapabilities,
  DEFAULT_PROVIDER_CACHE_CAPABILITIES, CACHE_MISS_REASONS, MODEL_ESCALATION_REASONS,
} from '../src/host/kernel/provider-prompt-policy.js';
import { COMMON_PROMPT_REVISION } from '../src/host/kernel/prompts/common-execution.js';

test('every provider capability defaults to false', () => {
  for (const value of Object.values(DEFAULT_PROVIDER_CACHE_CAPABILITIES)) assert.equal(value, false);
  const normalized = normalizeProviderCacheCapabilities({});
  assert.deepEqual(normalized, DEFAULT_PROVIDER_CACHE_CAPABILITIES);
});

test('a truthy-but-not-true capability is still treated as unsupported', () => {
  // "1" or "yes" from a config file must not be read as a declared capability.
  const normalized = normalizeProviderCacheCapabilities({ supportsPromptCache: 'yes', supportsCacheReadTokens: 1 });
  assert.equal(normalized.supportsPromptCache, false);
  assert.equal(normalized.supportsCacheReadTokens, false);
});

test('the policy names one common revision and a provider-specific one', () => {
  const claude = resolveProviderPromptPolicy({ provider: 'claude' });
  const codex = resolveProviderPromptPolicy({ provider: 'codex' });
  assert.equal(claude.commonPromptRevision, COMMON_PROMPT_REVISION);
  assert.equal(codex.commonPromptRevision, COMMON_PROMPT_REVISION);
  assert.notEqual(claude.providerPromptRevision, codex.providerPromptRevision);
});

test('an unknown provider gets no provider prompt revision instead of a guess', () => {
  assert.equal(resolveProviderPromptPolicy({ provider: 'mystery' }).providerPromptRevision, null);
});

test('delegation is default-deny for every provider and role', () => {
  for (const provider of ['claude', 'codex', 'mystery']) {
    for (const role of ['planner', 'implementer', 'reviewer']) {
      const policy = resolveProviderPromptPolicy({ provider, role });
      assert.equal(policy.allowNestedDelegation, false);
      assert.equal(policy.maxNestedAgents, 0);
    }
  }
});

test('a reviewer and a T3 turn both demand a fresh session', () => {
  assert.equal(resolveProviderPromptPolicy({ provider: 'claude', role: 'reviewer' }).requiresFreshSession, true);
  assert.equal(resolveProviderPromptPolicy({ provider: 'claude', role: 'implementer', riskTier: 'T3' }).requiresFreshSession, true);
  assert.equal(resolveProviderPromptPolicy({ provider: 'claude', role: 'implementer', riskTier: 'T1' }).requiresFreshSession, false);
});

test('persisted reasoning is gated on capability, role, and risk', () => {
  const capable = { supportsPersistedReasoning: true };
  assert.equal(resolveProviderPromptPolicy({ provider: 'codex', role: 'implementer', capabilities: capable }).reasoningPolicy.persistedReasoning, 'all_turns');
  assert.equal(resolveProviderPromptPolicy({ provider: 'codex', role: 'reviewer', capabilities: capable }).reasoningPolicy.persistedReasoning, 'current_turn');
  assert.equal(resolveProviderPromptPolicy({ provider: 'codex', role: 'implementer', riskTier: 'T3', capabilities: capable }).reasoningPolicy.persistedReasoning, 'current_turn');
  assert.equal(resolveProviderPromptPolicy({ provider: 'codex', role: 'implementer' }).reasoningPolicy.persistedReasoning, 'current_turn');
});

test('the diagnostic vocabularies are closed sets', () => {
  assert.ok(CACHE_MISS_REASONS.includes('provider-unsupported'));
  assert.ok(CACHE_MISS_REASONS.includes('usage-unreported'));
  assert.ok(MODEL_ESCALATION_REASONS.includes('repeated-failure'));
  assert.equal(new Set(CACHE_MISS_REASONS).size, CACHE_MISS_REASONS.length);
});
