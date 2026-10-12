import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const TEMPLATES = ['kernel-planner', 'kernel-implementer', 'kernel-reviewer'];
const read = (name: string) => readFile(`package/profile-templates/claude/.claude/agents/${name}.md`, 'utf8');

test('Claude agent templates stay under the 1,800-byte ceiling', async () => {
  for (const name of TEMPLATES) {
    const size = Buffer.byteLength(await read(name), 'utf8');
    assert.ok(size <= 1800, `${name}.md is ${size} bytes`);
  }
});

test('templates name no provider model and no Kernel model-class vocabulary', async () => {
  for (const name of TEMPLATES) {
    const text = await read(name);
    assert.doesNotMatch(text, /claude-(opus|sonnet|haiku)|gpt-5|o[34]-mini/i, `${name} pins a provider model`);
    assert.doesNotMatch(text, /frontier_reasoning|value_coding/, `${name} leaks Kernel model-class vocabulary`);
  }
});

test('each role keeps its structured output contract', async () => {
  assert.match(await read('kernel-planner'), /approvedDesign|currentSlice/);
  const implementer = await read('kernel-implementer');
  for (const field of ['changedPaths', 'verifications', 'risks', 'blocker']) assert.match(implementer, new RegExp(field));
  const reviewer = await read('kernel-reviewer');
  for (const field of ['verdict', 'findings', 'severity', 'category']) assert.match(reviewer, new RegExp(field));
});
