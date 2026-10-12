import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { CLAUDE_AGENT_FOR_ROLE } from '../src/host/kernel/adapters/claude.js';

const templateRoot = new URL('../package/profile-templates/claude/.claude/agents/', import.meta.url);

test('every Kernel role the adapter names has a shipped Claude agent template', async () => {
  const files = await readdir(templateRoot);
  for (const agent of Object.values(CLAUDE_AGENT_FOR_ROLE)) {
    assert.ok(files.includes(`${agent}.md`), `missing template for ${agent}`);
  }
});

test('agent templates are compact I/O contracts, not personas, and pin no provider model', async () => {
  for (const agent of Object.values(CLAUDE_AGENT_FOR_ROLE)) {
    const body = await readFile(new URL(`${agent}.md`, templateRoot), 'utf8');
    assert.match(body, new RegExp(`^name: ${agent}$`, 'm'), agent);
    for (const heading of ['## Role', '## Inputs', '## Outputs', '## Rules']) {
      assert.ok(body.includes(heading), `${agent} is missing ${heading}`);
    }
    // No provider model id, and no `model:` frontmatter key: the Host registry
    // supplies the model so the template stays provider-neutral.
    assert.doesNotMatch(body, /^model:/m, agent);
    assert.doesNotMatch(body, /gpt-\d|claude-(?:opus|sonnet|haiku)|gemini-|o[34]-mini/i, agent);
    // Kernel model-class vocabulary must not leak into a model-visible file.
    assert.doesNotMatch(body, /frontier_reasoning|value_coding|modelClass/, agent);
    // §11.1: 200-400 tokens. ~4 bytes per token gives a practical ceiling.
    assert.ok(body.length <= 1800, `${agent} is ${body.length} bytes; keep the contract compact`);
  }
});

test('the reviewer template stays read-only and routes findings by category', async () => {
  const reviewer = await readFile(new URL('kernel-reviewer.md', templateRoot), 'utf8');
  assert.match(reviewer, /read-only/i);
  assert.match(reviewer, /requiredAction/);
  assert.match(reviewer, /replan/);
});

test('the implementer template keeps proof execution with the Kernel', async () => {
  const implementer = await readFile(new URL('kernel-implementer.md', templateRoot), 'utf8');
  assert.match(implementer, /allowedPaths/);
  assert.match(implementer, /Kernel executes them/i);
  assert.match(implementer, /Do not report success/i);
});

test('the templates live under the packaged Claude profile template root', () => {
  const relative = path.relative(process.cwd(), new URL('kernel-planner.md', templateRoot).pathname.replace(/^\/(\w:)/, '$1')).replaceAll(path.sep, '/');
  assert.match(relative, /^package\/profile-templates\/claude\/\.claude\/agents\//);
});
