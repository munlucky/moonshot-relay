import test from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_PROVIDER_PROMPT, CLAUDE_PROMPT_REVISION, buildClaudeProviderSegment } from '../src/host/kernel/prompts/claude-opus-5.js';
import { COMMON_EXECUTION_PROMPT } from '../src/host/kernel/prompts/common-execution.js';

test('the Claude provider prompt is byte-stable', () => {
  const renders = Array.from({ length: 5 }, () => buildClaudeProviderSegment());
  assert.equal(new Set(renders).size, 1);
  assert.equal(renders[0], CLAUDE_PROVIDER_PROMPT);
  assert.equal(CLAUDE_PROMPT_REVISION, 'kernel-claude-opus-5.v1');
});

test('it carries only Claude-specific policy', () => {
  assert.match(CLAUDE_PROVIDER_PROMPT, /Keep thinking enabled/);
  assert.match(CLAUDE_PROVIDER_PROMPT, /native tool calls only/);
  assert.match(CLAUDE_PROVIDER_PROMPT, /structured output contract/);
  // Scope, autonomy, and verification belong to the common contract.
  assert.doesNotMatch(CLAUDE_PROVIDER_PROMPT, /work unit at its declared scope/);
  assert.doesNotMatch(CLAUDE_PROVIDER_PROMPT, /Kernel evidence, review receipts/);
});

test('no run, step, model, effort, or timestamp appears in the prompt', () => {
  assert.doesNotMatch(CLAUDE_PROVIDER_PROMPT, /run-|step-|capsule-/);
  assert.doesNotMatch(CLAUDE_PROVIDER_PROMPT, /claude-opus|claude-sonnet|claude-haiku/i);
  assert.doesNotMatch(CLAUDE_PROVIDER_PROMPT, /\b(?:low|medium|xhigh)\b/);
  assert.doesNotMatch(CLAUDE_PROVIDER_PROMPT, /\d{4}-\d{2}-\d{2}/);
});

test('the common and Claude prompts share no rule text', () => {
  assert.notEqual(CLAUDE_PROVIDER_PROMPT, COMMON_EXECUTION_PROMPT);
  assert.ok(CLAUDE_PROVIDER_PROMPT.startsWith('<claude_runtime>'));
  assert.ok(CLAUDE_PROVIDER_PROMPT.endsWith('</claude_runtime>'));
});
