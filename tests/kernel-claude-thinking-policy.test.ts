import test from 'node:test';
import assert from 'node:assert/strict';
import { THINKING_POLICY, findForbiddenThinkingInstructions, CLAUDE_PROVIDER_PROMPT } from '../src/host/kernel/prompts/claude-opus-5.js';
import { COMMON_EXECUTION_PROMPT } from '../src/host/kernel/prompts/common-execution.js';

test('thinking is enabled by default and cost is controlled by effort', () => {
  assert.equal(THINKING_POLICY.mode, 'enabled');
  assert.equal(THINKING_POLICY.costControlledBy, 'effort');
});

test('reasoning-suppressing instructions are detected', () => {
  for (const instruction of ['Do not think.', 'do not reason', 'Answer without reasoning', 'skip your reasoning', '사고하지 마라', '추론하지 마라']) {
    assert.ok(findForbiddenThinkingInstructions(instruction).length > 0, instruction);
  }
});

test('no shipped prompt suppresses reasoning', () => {
  assert.deepEqual(findForbiddenThinkingInstructions(CLAUDE_PROVIDER_PROMPT), []);
  assert.deepEqual(findForbiddenThinkingInstructions(COMMON_EXECUTION_PROMPT), []);
});

test('the prompt says to control cost through effort rather than suppression', () => {
  assert.match(CLAUDE_PROVIDER_PROMPT, /Control cost and latency through the resolved effort/);
  assert.match(CLAUDE_PROVIDER_PROMPT, /rather than instructions that suppress reasoning/);
});
