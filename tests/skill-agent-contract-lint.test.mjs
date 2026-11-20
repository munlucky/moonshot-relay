import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { lintSkillsAndAgents } from '../scripts/lint-skills.mjs';

const root = process.cwd();

const writeJson = (target, value) => writeFile(target, `${JSON.stringify(value, null, 2)}\n`);

test('skill and agent lint passes for current public runtime surface', async () => {
  const result = await lintSkillsAndAgents({ repoRoot: root });

  assert.equal(result.status, 'pass', JSON.stringify(result.findings.filter((finding) => finding.severity === 'blocking'), null, 2));
  assert.ok(result.publicSkills.includes('moonshot-phase-runner'));
});

test('skill and agent lint fails for missing public headings and agent output contract', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'skill-lint-'));
  await mkdir(path.join(temp, 'package'), { recursive: true });
  await mkdir(path.join(temp, 'skills', 'public-skill'), { recursive: true });
  await mkdir(path.join(temp, 'agents'), { recursive: true });
  await writeJson(path.join(temp, 'package', 'runtime-surface.json'), {
    publicRuntimeSkills: ['public-skill'],
  });
  await writeFile(path.join(temp, 'skills', 'public-skill', 'SKILL.md'), `---
name: public-skill
description: Fixture
---

# Public Skill

## Role

Only role exists.
`);
  await writeFile(path.join(temp, 'skills', 'public-skill', 'SKILL.ko.md'), '# 공개 스킬\n\n## 역할\n');
  await writeFile(path.join(temp, 'agents', 'bad-agent.md'), '# Bad Agent\n\n## Role\n\nNo input or output.\n');

  const result = await lintSkillsAndAgents({ repoRoot: temp });

  assert.equal(result.status, 'fail');
  assert.ok(result.findings.some((finding) => finding.code === 'skill.public_heading_missing'));
  assert.ok(result.findings.some((finding) => finding.code === 'agent.heading_missing'));
  assert.ok(result.findings.some((finding) => finding.code === 'agent.output_heading_missing'));
});

test('skill and agent lint blocks profile-local paths presented as durable source', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'skill-lint-profile-ref-'));
  await mkdir(path.join(temp, 'package'), { recursive: true });
  await mkdir(path.join(temp, 'skills', 'public-skill'), { recursive: true });
  await mkdir(path.join(temp, 'agents'), { recursive: true });
  await writeJson(path.join(temp, 'package', 'runtime-surface.json'), {
    publicRuntimeSkills: ['public-skill'],
  });
  await writeFile(path.join(temp, 'skills', 'public-skill', 'SKILL.md'), `---
name: public-skill
description: Fixture
---

# Public Skill

## Purpose

Fixture.

## Required flow

Edit .claude/skills as durable source.

## Hard rules

Do not skip.

## Required Evidence

Report it.

## References

- source
`);
  const result = await lintSkillsAndAgents({ repoRoot: temp });

  assert.equal(result.status, 'fail');
  assert.ok(result.findings.some((finding) => finding.code === 'skill.profile_local_source_reference_blocking'));
});

test('public skill lint enforces workflow and explicit-utility heading topology', async () => {
  const result = await lintSkillsAndAgents({ repoRoot: root });
  assert.equal(result.status, 'pass');
  assert.equal(result.findings.some((finding) => finding.code === 'skill.public_routing_heading_missing'), false);
});

test('public Korean variants block typed topology and frontmatter policy drift', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'skill-lint-ko-parity-'));
  await mkdir(path.join(temp, 'package'), { recursive: true });
  await mkdir(path.join(temp, 'skills', 'public-skill'), { recursive: true });
  await mkdir(path.join(temp, 'agents'), { recursive: true });
  await writeJson(path.join(temp, 'package', 'runtime-surface.json'), { publicRuntimeSkills: ['public-skill'] });
  const base = `---\nname: public-skill\ndescription: Fixture\ntriggers:\n  - exact\n---\n\n# Skill\n\n## Use When\n\nx\n\n## Route Away\n\nx\n\n## Role\n\nx\n\n## Procedure\n\nx\n\n## Hard Stops\n\n- Do not drift.\n\n## Output Contract\n\n- evidence\n\n## References\n\n- source\n`;
  await writeFile(path.join(temp, 'skills/public-skill/SKILL.md'), base);
  await writeFile(path.join(temp, 'skills/public-skill/SKILL.ko.md'), base.replace('  - exact', '  - changed').replace('## Procedure', '## 잘못된 절차'));
  const result = await lintSkillsAndAgents({ repoRoot: temp });
  assert.ok(result.findings.some((finding) => finding.code === 'skill.translation_heading_drift' && finding.severity === 'blocking'));
  assert.ok(result.findings.some((finding) => finding.code === 'skill.translation_policy_drift' && finding.severity === 'blocking'));
});

test('identical Korean topology and frontmatter cannot hide opposite policy text', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'skill-lint-ko-opposite-'));
  await mkdir(path.join(temp, 'package'), { recursive: true }); await mkdir(path.join(temp, 'skills/public-skill'), { recursive: true }); await mkdir(path.join(temp, 'agents'), { recursive: true });
  await writeJson(path.join(temp, 'package/runtime-surface.json'), { publicRuntimeSkills: ['public-skill'] });
  const source = await readFile(path.join(root, 'skills/moonshot-orchestrator/SKILL.md'), 'utf8');
  const fixture = source.replace(/name: moonshot-orchestrator/g, 'name: public-skill').replace(/moonshot-orchestrator\.policy/g, 'public-skill.policy');
  await writeFile(path.join(temp, 'skills/public-skill/SKILL.md'), fixture);
  await writeFile(path.join(temp, 'skills/public-skill/SKILL.ko.md'), fixture.replace('Do not broaden scope beyond the user request.', 'Always broaden scope beyond the user request.'));
  const result = await lintSkillsAndAgents({ repoRoot: temp });
  assert.ok(result.findings.some((finding) => finding.code === 'skill.translation_policy_binding_drift' && finding.severity === 'blocking'));
});

test('skill and agent lint CLI reports pass for source checkout', () => {
  const result = spawnSync(process.execPath, [
    'scripts/lint-skills.mjs',
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'pass', JSON.stringify(payload.findings.filter((finding) => finding.severity === 'blocking'), null, 2));
});

test('public lint blocks budget, invocation metadata, conditional loading, and trigger fixture gaps', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'skill-lint-quality-gates-'));
  await mkdir(path.join(temp, 'package'), { recursive: true });
  await mkdir(path.join(temp, 'catalog'), { recursive: true });
  await mkdir(path.join(temp, 'skills', 'public-skill'), { recursive: true });
  await mkdir(path.join(temp, 'agents'), { recursive: true });
  await writeJson(path.join(temp, 'package/runtime-surface.json'), { publicRuntimeSkills: ['public-skill'] });
  await writeJson(path.join(temp, 'catalog/moonshot-catalog.json'), { publicEntrypoints: [{ name: 'public-skill' }] });
  await writeFile(path.join(temp, 'skills/public-skill/SKILL.md'), `---\nname: public-skill\ndescription: Fixture\ndeepReferences:\n  - missing.md\n---\n# Fixture\n## Use When\nFixture.\n## Route Away\nFixture.\n## Role\nFixture.\n## Procedure\nFixture.\n## Hard Stops\n- Do not drift.\n## Output Contract\n- evidence\n`);
  const result = await lintSkillsAndAgents({ repoRoot: temp });
  for (const code of ['skill.token_budget_missing', 'skill.invocation_metadata_missing', 'skill.conditional_loading_missing', 'skill.trigger_fixture_missing', 'skill.deep_reference_missing']) {
    assert.ok(result.findings.some((finding) => finding.code === code && finding.severity === 'blocking'), code);
  }
});

test('baseline warning fingerprints make new warnings blocking without rewriting legacy findings', async () => {
  const baseline = await lintSkillsAndAgents({ repoRoot: root });
  const result = await lintSkillsAndAgents({ repoRoot: root, baselineFindingFingerprints: ['not-a-current-fingerprint'] });
  assert.equal(baseline.status, 'pass');
  assert.equal(result.status, 'fail');
  assert.ok(result.newFindingCount > 0);
});

test('warning ratchet fails closed when the reviewed registry is missing or explicit baseline is empty', async () => {
  const missing = await lintSkillsAndAgents({ repoRoot: root, carryForwardPath: path.join(root, 'does-not-exist.json') });
  assert.ok(missing.findings.some((finding) => finding.code === 'skill.warning_baseline_missing'));
  const empty = await lintSkillsAndAgents({ repoRoot: root, baselineFindingFingerprints: [] });
  assert.ok(empty.findings.some((finding) => finding.code === 'skill.warning_baseline_empty'));
});

test('accepted P04 exact token budget rejects a real public skill overrun', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'skill-token-ratchet-'));
  for (const relative of ['package', 'catalog', 'agents', 'tools/evals', 'tests/fixtures/skill-routing']) await mkdir(path.join(temp, relative), { recursive: true });
  await cp(path.join(root, 'skills/session-logger'), path.join(temp, 'skills/session-logger'), { recursive: true });
  await cp(path.join(root, 'package/runtime-surface.json'), path.join(temp, 'package/runtime-surface.json'));
  await cp(path.join(root, 'catalog/moonshot-catalog.json'), path.join(temp, 'catalog/moonshot-catalog.json'));
  await cp(path.join(root, 'tools/evals/skill-lint-carry-forward.json'), path.join(temp, 'tools/evals/skill-lint-carry-forward.json'));
  await cp(path.join(root, 'tests/fixtures/skill-routing/public-entrypoint-cases.json'), path.join(temp, 'tests/fixtures/skill-routing/public-entrypoint-cases.json'));
  const target = path.join(temp, 'skills/session-logger/SKILL.md');
  await writeFile(target, `${await readFile(target, 'utf8')}\n${'additional audit fixture content '.repeat(48)}`);
  const result = await lintSkillsAndAgents({ repoRoot: temp });
  assert.ok(result.findings.some((finding) => finding.code === 'skill.token_budget_exceeded' && finding.skill === 'session-logger'));
});
