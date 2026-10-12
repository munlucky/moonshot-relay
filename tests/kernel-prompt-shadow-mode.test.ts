import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOptimizationModes, resolveProviderOptimizationMode, CACHE_MODES } from '../src/host/kernel/provider-prompt-policy.js';
import { buildPromptEnvelope } from '../src/host/kernel/prompt-envelope.js';
import { buildToolManifest } from '../src/host/kernel/tool-manifest.js';

const envelopeFor = (env: NodeJS.ProcessEnv) => buildPromptEnvelope({
  provider: 'claude',
  toolManifest: buildToolManifest([{ name: 'read_file', description: 'Read a file' }]),
  contextSegments: {},
  capabilities: { supportsPromptCache: true, supportsExplicitCacheBreakpoints: true },
  env,
});

test('every mode defaults to shadow when nothing is configured', () => {
  const modes = resolveOptimizationModes({});
  assert.deepEqual(modes, {
    cacheMode: 'shadow',
    modelPolicyMode: 'shadow',
    codexModelPolicyMode: 'on',
    claude: 'shadow',
    codex: 'shadow',
  });
});

test('an unrecognized mode value falls back to shadow rather than turning on', () => {
  assert.equal(resolveOptimizationModes({ MOON_RELAY_KERNEL_CACHE_MODE: 'enabled' }).cacheMode, 'shadow');
  assert.deepEqual([...CACHE_MODES], ['off', 'shadow', 'on']);
});

test('providers are switched independently', () => {
  const env = { MOON_RELAY_KERNEL_CLAUDE_OPTIMIZATION: 'on', MOON_RELAY_KERNEL_CODEX_OPTIMIZATION: 'off' };
  assert.equal(resolveProviderOptimizationMode('claude', env), 'on');
  assert.equal(resolveProviderOptimizationMode('codex', env), 'off');
});

test('the general cache-mode switch takes effect when no provider-specific override is set', () => {
  // Regression: MOON_RELAY_KERNEL_CACHE_MODE=on alone used to have no effect
  // on either provider because their own variables defaulted to a hardcoded
  // 'shadow' rather than inheriting the resolved cache mode.
  const env = { MOON_RELAY_KERNEL_CACHE_MODE: 'on' };
  assert.equal(resolveOptimizationModes(env).claude, 'on');
  assert.equal(resolveOptimizationModes(env).codex, 'on');
  assert.equal(resolveProviderOptimizationMode('claude', env), 'on');
  assert.equal(resolveProviderOptimizationMode('codex', env), 'on');
});

test('an explicit provider override still wins over the general cache mode', () => {
  const env = { MOON_RELAY_KERNEL_CACHE_MODE: 'on', MOON_RELAY_KERNEL_CLAUDE_OPTIMIZATION: 'off' };
  assert.equal(resolveProviderOptimizationMode('claude', env), 'off');
  assert.equal(resolveProviderOptimizationMode('codex', env), 'on');
});

test('shadow mode still computes the envelope so it can be measured', () => {
  const shadow = envelopeFor({ MOON_RELAY_KERNEL_CLAUDE_OPTIMIZATION: 'shadow' });
  assert.equal(shadow.cachePolicy.requestedMode, 'shadow');
  assert.match(shadow.cacheIdentity.prefixDigest, /^sha256:/);
});

test('the requested mode does not change the compiled prompt bytes', () => {
  // Shadow must be observationally identical to off for the model; only the
  // recorded policy differs.
  const off = envelopeFor({ MOON_RELAY_KERNEL_CLAUDE_OPTIMIZATION: 'off' });
  const on = envelopeFor({ MOON_RELAY_KERNEL_CLAUDE_OPTIMIZATION: 'on' });
  assert.deepEqual(off.segments.map((s) => s.digest), on.segments.map((s) => s.digest));
  assert.equal(off.cacheIdentity.prefixDigest, on.cacheIdentity.prefixDigest);
  assert.equal(off.cachePolicy.requestedMode, 'off');
  assert.equal(on.cachePolicy.requestedMode, 'on');
});
