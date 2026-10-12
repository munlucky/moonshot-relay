import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { COMMON_EXECUTION_PROMPT, findVagueInstructions } from '../src/host/kernel/prompts/common-execution.js';
import { CLAUDE_PROVIDER_PROMPT } from '../src/host/kernel/prompts/claude-opus-5.js';
import { CODEX_PROVIDER_PROMPT } from '../src/host/kernel/prompts/codex-gpt-5p6.js';

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

test('stable prompts stay inside their byte budget', () => {
  assert.ok(bytes(COMMON_EXECUTION_PROMPT) <= 1200, `common prompt is ${bytes(COMMON_EXECUTION_PROMPT)} bytes`);
  assert.ok(bytes(CLAUDE_PROVIDER_PROMPT) <= 800, `claude prompt is ${bytes(CLAUDE_PROVIDER_PROMPT)} bytes`);
  assert.ok(bytes(CODEX_PROVIDER_PROMPT) <= 800, `codex prompt is ${bytes(CODEX_PROVIDER_PROMPT)} bytes`);
});

test('the audit records a real before/after comparison', async () => {
  const before = JSON.parse(await readFile('artifacts/kernel-prompt-audit/prompt-size-before.json', 'utf8'));
  const after = JSON.parse(await readFile('artifacts/kernel-prompt-audit/prompt-size-after.json', 'utf8'));
  assert.equal(before.commonExecutionPromptBytes, 0, 'the baseline had no consolidated common prompt');
  assert.equal(after.commonExecutionPromptBytes, bytes(COMMON_EXECUTION_PROMPT));
  assert.equal(after.duplicatedCommonRulesInProviderPrompts, 0);
});

test('vague instructions are detected rather than tolerated', () => {
  assert.deepEqual(findVagueInstructions(COMMON_EXECUTION_PROMPT), []);
  assert.ok(findVagueInstructions('please double-check your work').length > 0);
  assert.ok(findVagueInstructions('반드시 다시 확인해').length > 0);
});
