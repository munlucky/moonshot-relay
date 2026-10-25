import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('provider-neutral guideline does not own GPT-specific pricing or model names', async () => {
  const text = await readFile(path.join(root, 'docs/public/guidelines/provider-neutral-model-routing.md'), 'utf8');
  assert.equal(/gpt-5\.6|272000|240000|Luna|Terra|Sol/i.test(text), false);
  assert.match(text, /provider adapter/i);
});

test('Codex-specific policy is isolated under the provider namespace', async () => {
  const text = await readFile(path.join(root, 'rules/providers/codex-gpt-5-6-cost-policy.yaml'), 'utf8');
  assert.match(text, /provider: codex/);
  assert.match(text, /billingGuardThreshold: 272000/);
  assert.match(text, /autoCompactTokenLimit: 240000/);
});

test('Codex discovery keeps provider-specific model policy out of always-loaded profile instructions', async () => {
  const codex = await readFile(path.join(root, 'package/profile-templates/codex/.codex/AGENTS.md'), 'utf8');
  const claude = await readFile(path.join(root, 'package/profile-templates/claude/.claude/CLAUDE.md'), 'utf8');
  const qwen = await readFile(path.join(root, 'package/profile-templates/qwen/.qwen/QWEN.md'), 'utf8');
  assert.match(codex, /Provider\/model selection is Host-owned/);
  assert.doesNotMatch(codex, /codex-gpt-5-6-cost-control|gpt-[0-9]|272000|240000/i);
  assert.doesNotMatch(claude, /codex-gpt-5-6-cost-control|gpt-5\.6-luna|272000/);
  assert.doesNotMatch(qwen, /codex-gpt-5-6-cost-control|gpt-5\.6-luna|272000/);
});
