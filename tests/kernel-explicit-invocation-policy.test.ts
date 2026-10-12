import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const canonicalSkillPath = 'skills/moon-relay-kernel/SKILL.md';
const shippedSkillPath = 'package/kernel/profiles/codex/skills/moon-relay-kernel/SKILL.md';

test('Kernel entrypoint metadata is provider-neutral without forcing every task into Kernel', async () => {
  const skill = await readFile(canonicalSkillPath, 'utf8');

  assert.match(skill, /description: Default provider-neutral command-skill entrypoint/);
  assert.match(skill, /Selecting this skill activates Kernel workflow for that task/);
  assert.match(skill, /does not force unselected ordinary tasks into Kernel/);
  assert.match(skill, /The account command skillset defaults to Kernel/);
  assert.match(skill, /for a non-kernel track return `wrong_harness`/);
  assert.match(skill, /kernel next --contract-json <file>/);
  assert.match(skill, /do not bootstrap a fresh session with bare `kernel next`/);
  assert.match(skill, /bare `kernel next` only after a Host binding exists/);
});

test('Codex account guidance makes the Kernel command skillset default without forcing every task into Kernel', async () => {
  const agents = await readFile('package/kernel/profiles/codex/AGENTS.override.md', 'utf8');

  assert.match(agents, /The Codex command skillset defaults to the Kernel catalog/);
  assert.match(agents, /Selecting `moon-relay-kernel` or another Kernel command skill activates Kernel workflow/);
  assert.match(agents, /does not force every Codex task to invoke Kernel/);
  assert.match(agents, /use Kernel runtime-state and completion authority/);
  assert.match(agents, /Do not call or depend on the Relay↔Kernel switcher/);
  assert.doesNotMatch(agents, /Kernel is available but is not active by default/);
  assert.doesNotMatch(agents, /Without an explicit current-user invocation/);
});

test('the profile-shipped Kernel entrypoint matches the canonical default command-skill contract', async () => {
  const canonical = await readFile(canonicalSkillPath, 'utf8');
  assert.equal(await readFile(shippedSkillPath, 'utf8'), canonical);
});
