import test from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_PROVIDER_PROMPT, CODEX_PROMPT_REVISION, buildCodexProviderSegment } from '../src/host/kernel/prompts/codex-gpt-5p6.js';
import { COMMON_EXECUTION_PROMPT } from '../src/host/kernel/prompts/common-execution.js';
import { CLAUDE_PROVIDER_PROMPT } from '../src/host/kernel/prompts/claude-opus-5.js';

test('the Codex provider prompt is byte-stable', () => {
  assert.equal(new Set(Array.from({ length: 5 }, () => buildCodexProviderSegment())).size, 1);
  assert.equal(CODEX_PROMPT_REVISION, 'kernel-codex-gpt-5p6.v1');
});

test('it defers execution settings to the configuration rather than the prompt', () => {
  assert.match(CODEX_PROVIDER_PROMPT, /Use the configured model, reasoning effort, sandbox, and approval policy/);
  assert.match(CODEX_PROVIDER_PROMPT, /Do not restate or override them in the prompt/);
});

test('it separates durable AGENTS.md guidance from the current task prompt', () => {
  assert.match(CODEX_PROVIDER_PROMPT, /Keep AGENTS\.md for durable repository guidance/);
  assert.match(CODEX_PROVIDER_PROMPT, /goal, context, constraints, and done conditions/);
});

test('it states the session rule without repeating the common contract', () => {
  assert.match(CODEX_PROVIDER_PROMPT, /Preserve the current implementer session/);
  assert.doesNotMatch(CODEX_PROVIDER_PROMPT, /work unit at its declared scope/);
  assert.notEqual(CODEX_PROVIDER_PROMPT, COMMON_EXECUTION_PROMPT);
  assert.notEqual(CODEX_PROVIDER_PROMPT, CLAUDE_PROVIDER_PROMPT);
});

test('no model id, reasoning effort, or fast-mode setting appears in the prompt', () => {
  assert.doesNotMatch(CODEX_PROVIDER_PROMPT, /gpt-5\.6/i);
  assert.doesNotMatch(CODEX_PROVIDER_PROMPT, /model_reasoning_effort|xhigh|\bmax\b/i);
  assert.doesNotMatch(CODEX_PROVIDER_PROMPT, /fast[_\s-]?mode/i);
});
