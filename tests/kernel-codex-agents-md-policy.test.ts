import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { auditAgentsMarkdown, resolveAgentsPrecedence, MAX_AGENTS_MD_BYTES } from '../src/host/kernel/codex-agents-policy.js';

test('the packaged Kernel AGENTS.md is a clean repository contract', async () => {
  const text = await readFile('package/profile-templates/codex/AGENTS.md', 'utf8');
  const audit = auditAgentsMarkdown(text);
  assert.deepEqual(audit.violations, [], JSON.stringify(audit.violations));
  assert.ok(audit.bytes <= MAX_AGENTS_MD_BYTES);
});

test('it declares structure, commands, constraints, do-not rules, and done criteria', async () => {
  const text = await readFile('package/profile-templates/codex/AGENTS.md', 'utf8');
  for (const heading of ['Repository Structure', 'Commands', 'Engineering Constraints', 'Do Not', 'Done and Verification']) {
    assert.match(text, new RegExp(`## ${heading}`));
  }
});

test('a model id, reasoning effort, or fast-mode setting is a violation', () => {
  assert.ok(auditAgentsMarkdown('Use gpt-5.6-sol for planning.').violations.some((v) => v.id === 'model-id'));
  assert.ok(auditAgentsMarkdown('model_reasoning_effort = "high"').violations.some((v) => v.id === 'reasoning-effort'));
  assert.ok(auditAgentsMarkdown('Enable fast mode for this repo.').violations.some((v) => v.id === 'fast-mode'));
  assert.ok(auditAgentsMarkdown('## Current Task\nFix the parser.').violations.some((v) => v.id === 'current-task'));
  assert.ok(auditAgentsMarkdown('Set cache_control on the last block.').violations.some((v) => v.id === 'provider-cache-config'));
});

test('every violation explains itself', () => {
  for (const violation of auditAgentsMarkdown('Use gpt-5.6-sol and set model_reasoning_effort = "max".').violations) {
    assert.ok(violation.reason.length > 10, `violation ${violation.id} has no usable reason`);
  }
});

test('an oversized file is flagged so procedure moves into a Skill', () => {
  const audit = auditAgentsMarkdown('x'.repeat(MAX_AGENTS_MD_BYTES + 1));
  assert.ok(audit.violations.some((v) => v.id === 'oversized'));
  const violation = audit.violations.find((v) => v.id === 'oversized');
  assert.ok(violation);
  assert.match(violation.reason, /Skill|separate document/);
});

test('the nearest AGENTS.md wins for a given path', () => {
  const files = ['AGENTS.md', 'scripts/AGENTS.md', 'scripts/kernel/AGENTS.md', 'tests/AGENTS.md'];
  assert.deepEqual(resolveAgentsPrecedence(files, 'scripts/host/kernel/context-segments.js'), [
    'scripts/AGENTS.md',
    'AGENTS.md',
  ]);
  assert.deepEqual(resolveAgentsPrecedence(files, 'bin/cli.mjs'), ['AGENTS.md']);
});

test('the Codex contract preserves supported compatibility safely', async () => {
  const text = await readFile('package/profile-templates/codex/AGENTS.md', 'utf8');

  assert.match(text, /declared compatibility windows/i);
  assert.match(text, /supported runtimes/i);
  assert.match(text, /user data/i);
  assert.match(text, /additive schema and database migrations/i);
  assert.match(text, /explicit, versioned replacement or migration path/i);
  assert.match(text, /support window has ended/i);
  assert.match(text, /rollback path are verified/i);

  assert.doesNotMatch(text, /do not preserve backward compatibility/i);
  assert.doesNotMatch(text, /instead of adding compatibility layers, fallbacks, or migrations/i);
});
