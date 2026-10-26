import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { COMMON_EXECUTION_PROMPT } from '../src/host/kernel/prompts/common-execution.js';
import { CLAUDE_PROVIDER_PROMPT } from '../src/host/kernel/prompts/claude-opus-5.js';
import { CODEX_PROVIDER_PROMPT } from '../src/host/kernel/prompts/codex-gpt-5p6.js';

// Surfaces the Kernel Host actually loads. Relay-mode skills are out of scope.
const FILE_SURFACES = [
  'skills/moon-relay-kernel/SKILL.md',
  'package/profile-templates/claude/.claude/agents/kernel-planner.md',
  'package/profile-templates/claude/.claude/agents/kernel-implementer.md',
  'package/profile-templates/claude/.claude/agents/kernel-reviewer.md',
  'package/profile-templates/codex/AGENTS.md',
];

const LEGACY_PATTERNS = [
  /always plan first/i, /always verify/i, /verify again/i, /double[-\s]?check/i,
  /recheck before responding/i, /review your own (answer|response)/i,
  /use a subagent to verify/i, /always delegate/i,
  /run the full (suite|test suite) after every change/i,
  /do not preserve backward compatibility/i,
  /remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations/i,
  /do not accept a stopgap that only works for now/i,
  /explain every step/i, /report every tool call/i,
  /do not think/i, /do not reason/i,
  /항상\s*먼저\s*계획/, /반드시\s*다시\s*검증/, /응답\s*전에\s*재확인/,
  /서브에이전트에게\s*검증/, /모든\s*수정\s*후\s*전체\s*테스트/,
  /작업\s*과정을\s*계속\s*설명/, /사고하지\s*(마|말)/, /추론하지\s*(마|말)/,
];

test('no Kernel prompt surface carries a legacy instruction', async () => {
  const offenders = [];
  for (const surface of FILE_SURFACES) {
    const text = await readFile(surface, 'utf8');
    for (const pattern of LEGACY_PATTERNS) if (pattern.test(text)) offenders.push(`${surface}: ${pattern}`);
  }
  for (const [name, text] of [['common', COMMON_EXECUTION_PROMPT], ['claude', CLAUDE_PROVIDER_PROMPT], ['codex', CODEX_PROVIDER_PROMPT]]) {
    for (const pattern of LEGACY_PATTERNS) if (pattern.test(text)) offenders.push(`${name}: ${pattern}`);
  }
  assert.deepEqual(offenders, []);
});

test('Kernel authority rules survive the cleanup', async () => {
  const skill = await readFile('skills/moon-relay-kernel/SKILL.md', 'utf8');
  assert.match(skill, /Do not mutate outside the current work unit/i);
  assert.match(skill, /Kernel executes trusted proof or reuses exact fresh evidence/i);
  assert.match(skill, /Independent judgment obligations use trusted review receipts/i);
  assert.match(skill, /Local checks may support implementation feedback, but they do not replace Kernel evidence/i);
  assert.match(skill, /A Run is complete only when the latest canonical continuation returns/i);
  assert.doesNotMatch(skill, /report only after all required evidence is recorded/i);

  const implementer = await readFile('package/profile-templates/claude/.claude/agents/kernel-implementer.md', 'utf8');
  assert.match(implementer, /allowedPaths/);
  assert.match(implementer, /Do not report success/i);
});

test('model-facing Kernel guidance consumes report continuation without an immediate next round trip', async () => {
  const skill = await readFile('skills/moon-relay-kernel/SKILL.md', 'utf8');
  const qwen = await readFile('package/kernel/profiles/ade/QWEN.md', 'utf8');

  assert.match(skill, /Consume the returned `next` continuation instead of issuing an extra advance call/i);
  assert.match(skill, /latest canonical continuation returns `action\.type = "done"`/i);
  assert.match(skill, /Do not call `next` again only to reconfirm it/i);
  assert.doesNotMatch(skill, /run is done only when `kernel next` returns/i);

  assert.match(qwen, /Continue from the canonical `next` returned by that report/i);
  assert.doesNotMatch(qwen, /then call `kernel next` again/i);
});

test('Kernel skill asks for semantic contract meaning instead of internal wiring', async () => {
  const skill = await readFile('skills/moon-relay-kernel/SKILL.md', 'utf8');

  assert.match(skill, /send semantic contract data: objective, acceptance, constraints, non-goals, and known bounded mutation scope/i);
  assert.match(skill, /Kernel owns internal acceptance IDs, obligation wiring, revisions, and digests/i);
  assert.match(skill, /Omit unknown scope instead of declaring an empty allowlist/i);
  assert.match(skill, /Do not manufacture Kernel internal IDs/i);
  assert.doesNotMatch(skill, /supply bounded steps with acceptance IDs/i);
});

test('Kernel skill keeps recovery authority out of model bookkeeping', async () => {
  const skill = await readFile('skills/moon-relay-kernel/SKILL.md', 'utf8');

  assert.match(skill, /Provider model selection, execution mechanism, delegation, session freshness, and concurrency are Host-owned/i);
  assert.match(skill, /use the returned recovery\/diagnosis state/i);
  assert.match(skill, /Repair the owning cause; do not create fallback completion or edit runtime DB\/receipts/i);
  assert.match(skill, /Refresh `next` only when a new canonical state is needed/i);
  assert.doesNotMatch(skill, /Retain the last diagnosis capsule and pass .* on each diagnostic retry/i);
});

test('provider prompts do not restate the common execution contract', () => {
  // A rule duplicated into both provider prompts costs bytes in every provider
  // prefix and makes one revision invalidate the other's cache.
  const commonSentences = COMMON_EXECUTION_PROMPT
    .replace(/<\/?kernel_execution>/g, '')
    .split(/\n\s*\n/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part.length > 30);
  for (const provider of [CLAUDE_PROVIDER_PROMPT, CODEX_PROVIDER_PROMPT]) {
    const normalized = provider.replace(/\s+/g, ' ');
    for (const sentence of commonSentences) {
      assert.ok(!normalized.includes(sentence), `provider prompt repeats a common rule: ${sentence.slice(0, 48)}`);
    }
  }
});
