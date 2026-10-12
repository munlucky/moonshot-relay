import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROVIDER_CACHE_CAPABILITIES, normalizeProviderCacheCapabilities, resolveProviderPromptPolicy } from '../src/host/kernel/provider-prompt-policy.js';
import { CLAUDE_CAPABILITIES } from '../src/host/kernel/adapters/claude.js';
import { CODEX_CAPABILITIES } from '../src/host/kernel/adapters/codex.js';
import { FALLBACK_CAPABILITIES } from '../src/host/kernel/adapters/fable.js';

test('the shared default is that nothing is supported', () => {
  assert.deepEqual(Object.values(DEFAULT_PROVIDER_CACHE_CAPABILITIES), Object.values(DEFAULT_PROVIDER_CACHE_CAPABILITIES).map(() => false));
});

test('Claude declares explicit caching with separate read and write counts', () => {
  const caps = normalizeProviderCacheCapabilities(CLAUDE_CAPABILITIES);
  assert.equal(caps.supportsPromptCache, true);
  assert.equal(caps.supportsExplicitCacheBreakpoints, true);
  assert.equal(caps.supportsCacheReadTokens, true);
  assert.equal(caps.supportsCacheWriteTokens, true);
  assert.equal(resolveProviderPromptPolicy({ provider: 'claude', capabilities: CLAUDE_CAPABILITIES }).cachePolicy.providerMode, 'explicit');
});

test('Codex declares only session continuation', () => {
  const caps = normalizeProviderCacheCapabilities(CODEX_CAPABILITIES);
  assert.equal(caps.supportsSessionContinuation, true);
  assert.equal(caps.supportsPromptCache, false);
  assert.equal(resolveProviderPromptPolicy({ provider: 'codex', capabilities: CODEX_CAPABILITIES }).cachePolicy.providerMode, 'none');
});

test('a surface that declares nothing gets nothing', () => {
  const caps = normalizeProviderCacheCapabilities({ ...DEFAULT_PROVIDER_CACHE_CAPABILITIES, ...FALLBACK_CAPABILITIES });
  for (const value of Object.values(caps)) assert.equal(value, false);
});

test('an implicit-cache Host is distinguished from an explicit-cache Host', () => {
  const implicit = resolveProviderPromptPolicy({ provider: 'other', capabilities: { supportsPromptCache: true } });
  assert.equal(implicit.cachePolicy.providerMode, 'implicit');
  assert.equal(implicit.cachePolicy.unsupportedReason, null);
});
