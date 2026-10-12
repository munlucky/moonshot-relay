import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCodexFastModePolicy } from '../src/host/kernel/codex-model-policy.js';
import { CODEX_PROVIDER_PROMPT } from '../src/host/kernel/prompts/codex-gpt-5p6.js';

test('interactive work may use fast mode', () => {
  for (const workContext of ['interactive-urgent-fix', 'short-debug-loop', 'user-waiting-exploration']) {
    assert.equal(resolveCodexFastModePolicy({ workContext }).speedMode, 'fast', workContext);
  }
});

test('batch, nightly review, and benchmark work stay on standard speed', () => {
  for (const workContext of ['batch', 'nightly-review', 'cost-priority', 'replay-benchmark']) {
    assert.equal(resolveCodexFastModePolicy({ workContext }).speedMode, 'standard', workContext);
  }
});

test('fast mode is delivered as an execution setting, never as prompt text', () => {
  const policy = resolveCodexFastModePolicy({ workContext: 'interactive-urgent-fix' });
  assert.equal(policy.deliveredAs, 'execution-setting');
  assert.equal(policy.includedInPrompt, false);
  assert.doesNotMatch(CODEX_PROVIDER_PROMPT, /fast[_\s-]?mode/i);
});

test('an unknown credit multiplier is recorded as null rather than assumed', () => {
  const policy = resolveCodexFastModePolicy({ workContext: 'interactive-urgent-fix', authMode: 'chatgpt-login' });
  assert.equal(policy.authMode, 'chatgpt-login');
  assert.equal(policy.creditMultiplierKnown, null);
  assert.equal(resolveCodexFastModePolicy({}).authMode, null);
});
