import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { installKernelAccountRoot } from '../scripts/kernel/profile-install.mjs';
import { doctorKernelProfile } from '../scripts/kernel/profile-doctor.mjs';

const digest = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

test('Kernel account-root profile replaces Relay command skills and preserves user data', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kernel-account-root-profile-'));
  const targetRoot = path.join(home, '.codex');
  const runtimeHome = path.join(home, '.moon-relay-kernel');
  const sourceRoot = process.cwd();
  const relaySkills = ['commit-moonshot', 'moonshot-architecture', 'moonshot-orchestrator', 'moonshot-phase-runner', 'moonshot-plan-writer', 'product-orchestrator', 'session-logger'];
  const preservedAuth = path.join(targetRoot, 'auth.json');
  const preservedSession = path.join(targetRoot, 'sessions', 'session.jsonl');

  await mkdir(path.join(targetRoot, 'skills', '.system'), { recursive: true });
  await writeFile(path.join(targetRoot, 'skills', '.system', 'SKILL.md'), '# system\n');
  await mkdir(path.join(targetRoot, 'skills', 'keep-local'), { recursive: true });
  await writeFile(path.join(targetRoot, 'skills', 'keep-local', 'SKILL.md'), '# keep\n');
  for (const name of relaySkills) {
    await mkdir(path.join(targetRoot, 'skills', name), { recursive: true });
    await writeFile(path.join(targetRoot, 'skills', name, 'SKILL.md'), `# ${name}\n`);
  }
  await writeFile(path.join(targetRoot, 'AGENTS.md'), '# Relay account guidance\n');
  await writeFile(path.join(targetRoot, 'config.toml'), 'model = "gpt-5.6-luna"\n\n[mcp_servers.example]\ncommand = "example"\n');
  await writeFile(path.join(targetRoot, 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'user-hook' }] }] } }));
  await writeFile(preservedAuth, '{"preserve":true}\n');
  await mkdir(path.dirname(preservedSession), { recursive: true });
  await writeFile(preservedSession, 'session\n');
  const authBefore = await digest(preservedAuth);
  const sessionBefore = await digest(preservedSession);

  const result = await installKernelAccountRoot({ sourceRoot, runtime: 'codex', targetRoot, runtimeHome });
  assert.equal(result.status, 'installed');
  assert.deepEqual(result.retiredRelaySkills, relaySkills);
  assert.ok(result.backupPath);
  assert.equal(await digest(preservedAuth), authBefore);
  assert.equal(await digest(preservedSession), sessionBefore);

  const skills = (await readdir(path.join(targetRoot, 'skills'))).sort();
  assert.deepEqual(skills, ['.system', 'architecture-artifacts', 'codebase-master-guide', 'codebase-understanding', 'explain-diff-html', 'keep-local', 'kernel-commit', 'moon-relay-kernel', 'product-definition', 'project-memory', 'ui-audit']);
  assert.match(await readFile(path.join(targetRoot, 'AGENTS.md'), 'utf8'), /command skillset defaults to the Kernel catalog/);
  const config = await readFile(path.join(targetRoot, 'config.toml'), 'utf8');
  assert.match(config, /This project runs under Moon Relay Kernel/);
  assert.match(config, /Do not force unselected ordinary Codex tasks into Kernel/);
  assert.match(config, /\[mcp_servers\.example\]/);
  const hooks = JSON.parse(await readFile(path.join(targetRoot, 'hooks.json'), 'utf8'));
  assert.equal(hooks.hooks.SessionStart.length, 2);
  assert.ok(hooks.hooks.SessionStart.some((entry) => entry.hooks?.some((hook) => hook.command === 'user-hook')));
  assert.ok(hooks.hooks.SessionStart.some((entry) => entry.hooks?.some((hook) => hook.command.replaceAll('\\', '/').match(/\/bin\/kernel['"]?\s+assert-track\s+--project-only\s+--allow-non-kernel\s+--json/))));
  assert.equal(await readFile(path.join(result.backupPath, 'AGENTS.md'), 'utf8'), '# Relay account guidance\n');

  const doctor = await doctorKernelProfile({ targetRoot, runtime: 'codex' });
  assert.equal(doctor.status, 'ready');
  assert.equal(doctor.effective, 'kernel');
  assert.equal(doctor.managedFileCount, 29);

  const manifestBefore = await readFile(result.manifestPath, 'utf8');
  const second = await installKernelAccountRoot({ sourceRoot, runtime: 'codex', targetRoot, runtimeHome });
  assert.equal(second.status, 'already_current');
  assert.equal(await readFile(result.manifestPath, 'utf8'), manifestBefore);

  const targetStats = await stat(targetRoot);
  assert.ok(targetStats.isDirectory());
});

test('Kernel account-root profile reprojects when the canonical source skill changes', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'kernel-account-root-refresh-'));
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-account-root-source-'));
  const targetRoot = path.join(home, '.codex');
  const runtimeHome = path.join(home, '.moon-relay-kernel');
  try {
    await mkdir(path.join(sourceRoot, 'package', 'kernel', 'profiles'), { recursive: true });
    await mkdir(path.join(sourceRoot, 'skills'), { recursive: true });
    await cp(path.join(process.cwd(), 'package', 'kernel', 'profiles', 'codex'), path.join(sourceRoot, 'package', 'kernel', 'profiles', 'codex'), { recursive: true });
    await cp(path.join(process.cwd(), 'skills', 'moon-relay-kernel'), path.join(sourceRoot, 'skills', 'moon-relay-kernel'), { recursive: true });

    await installKernelAccountRoot({ sourceRoot, runtime: 'codex', targetRoot, runtimeHome });
    const sourceSkill = path.join(sourceRoot, 'skills', 'moon-relay-kernel', 'SKILL.md');
    await writeFile(sourceSkill, `${await readFile(sourceSkill, 'utf8')}\n# source drift marker\n`);

    const refreshed = await installKernelAccountRoot({ sourceRoot, runtime: 'codex', targetRoot, runtimeHome });
    assert.equal(refreshed.status, 'reinstalled');
    assert.match(await readFile(path.join(targetRoot, 'skills', 'moon-relay-kernel', 'SKILL.md'), 'utf8'), /source drift marker/);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
  }
});
