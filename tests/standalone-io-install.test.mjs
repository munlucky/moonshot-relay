import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
const installer = path.resolve('scripts/install-account-root-harness.mjs');
const manifestName = '.moonshot-relay-install-manifest.json';
async function fixture() {
 const base = await mkdtemp(path.join(os.tmpdir(), 'io-install-'));
 const home = path.join(base, 'custom codex home'), common = path.join(base, 'common runtime');
 const payload = path.join(base, 'payload'), profile = path.join(payload, 'codex/profile/.codex');
 await cp(path.resolve('package/profile-templates/codex/.codex'), profile, { recursive: true });
 await mkdir(home, { recursive: true });
 const run = (args = [], nodeArgs = []) => spawnSync(process.execPath, [...nodeArgs, installer, '--runtime', 'codex', '--codex-io-only', '--skip-common', '--payload-root', payload, '--codex-home', home, '--moonshot-home', common, '--json', ...args], { encoding: 'utf8' });
 return { base, home, common, payload, profile, run };
}
test('I/O installation merges only owned hooks, preserves user settings/skills, upgrades and downgrades', async () => {
 const f = await fixture();
 try {
  const user = { matcher: '^Bash$', hooks: [{ type: 'command', command: 'user-command' }] };
  await writeFile(path.join(f.home, 'hooks.json'), JSON.stringify({ description: 'user-owned', hooks: { PreToolUse: [user], Stop: [] } }));
  await writeFile(path.join(f.home, 'AGENTS.md'), 'user profile');
  await writeFile(path.join(f.home, 'config.toml'), 'model = "user-model"');
  await mkdir(path.join(f.home, 'skills/keep'), { recursive: true });
  await writeFile(path.join(f.home, 'skills/keep/SKILL.md'), 'user skill');
  for (const args of [[], [], ['--io-reader-min-lines', '400']]) {
   const r = f.run(args); assert.equal(r.status, 0, r.stderr);
   const hooks = JSON.parse(await readFile(path.join(f.home, 'hooks.json'), 'utf8'));
   assert.equal(hooks.description, 'user-owned');
   assert.deepEqual(hooks.hooks.PreToolUse[0], user);
   assert.equal(hooks.hooks.PreToolUse.length, 2);
   assert.equal(await readFile(path.join(f.home, 'AGENTS.md'), 'utf8'), 'user profile');
   assert.equal(await readFile(path.join(f.home, 'config.toml'), 'utf8'), 'model = "user-model"');
   assert.equal(await readFile(path.join(f.home, 'skills/keep/SKILL.md'), 'utf8'), 'user skill');
   const script = await readFile(path.join(f.home, 'hooks/moonshot-reader.mjs'), 'utf8');
   assert.ok(script.includes(JSON.stringify(f.common)));
   assert.ok(!script.includes('__MOONSHOT'));
   const skill = await readFile(path.join(f.home, 'skills/io-writer/SKILL.md'), 'utf8');
   assert.ok(skill.includes(f.common.replaceAll('\\', '/')));
   assert.match(skill, /io-write - --apply/);
   assert.match(skill, /explicit delegation or evaluation/);
  }
  assert.match(await readFile(path.join(f.home, 'hooks/moonshot-reader.mjs'), 'utf8'), /main\(runtimeHome, 400\)/);
  // An older payload removes exactly the owned definition and files.
  await rm(path.join(f.profile, 'hooks.json'));
  await rm(path.join(f.profile, 'hooks'), { recursive: true });
  await rm(path.join(f.profile, 'skills/io-writer'), { recursive: true });
  const old = f.run(); assert.equal(old.status, 0, old.stderr);
  const hooks = JSON.parse(await readFile(path.join(f.home, 'hooks.json'), 'utf8'));
  assert.deepEqual(hooks.hooks.PreToolUse, [user]);
  await assert.rejects(readFile(path.join(f.home, 'hooks/moonshot-reader.mjs')));
  assert.equal(await readFile(path.join(f.home, 'skills/keep/SKILL.md'), 'utf8'), 'user skill');
 } finally { await rm(f.base, { recursive: true, force: true }); }
});
test('empty account installs; modified/unowned hooks or scripts are never claimed', async () => {
 for (const mode of ['modified-hook', 'modified-script', 'unowned']) {
  const f = await fixture();
  try {
   if (mode !== 'unowned') assert.equal(f.run().status, 0);
   if (mode === 'modified-script') await writeFile(path.join(f.home, 'hooks/moonshot-reader.mjs'), '// user modified');
   else {
    const hooks = mode === 'unowned' ? { hooks: { PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'node custom/moonshot-reader.mjs' }] }] } } : JSON.parse(await readFile(path.join(f.home, 'hooks.json'), 'utf8'));
    if (mode === 'modified-hook') hooks.hooks.PreToolUse[0].hooks[0].timeout = 9;
    await writeFile(path.join(f.home, 'hooks.json'), JSON.stringify(hooks));
   }
   const before = await readFile(path.join(f.home, 'hooks.json'), 'utf8');
   const result = f.run();
   assert.notEqual(result.status, 0, mode);
   assert.match(result.stderr, /ownership_conflict|unowned_registration/);
   assert.equal(await readFile(path.join(f.home, 'hooks.json'), 'utf8'), before);
  } finally { await rm(f.base, { recursive: true, force: true }); }
 }
});
test('an I/O write failure restores shared hooks, owned scripts and the previous manifest', async () => {
 const f = await fixture();
 try {
  assert.equal(f.run().status, 0);
  const paths = ['hooks.json', 'hooks/moonshot-reader.mjs', 'skills/io-writer/SKILL.md', manifestName];
  const before = await Promise.all(paths.map(p => readFile(path.join(f.home, p), 'utf8')));
  const injection = path.join(f.base, 'fail-write.mjs');
  await writeFile(injection, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const write=fs.promises.writeFile;let failed=false;fs.promises.writeFile=async(file,...args)=>{if(!failed&&String(file).replaceAll('\\\\','/').endsWith('skills/io-writer/SKILL.md')){failed=true;throw new Error('injected_io_write_failure');}return write(file,...args);};syncBuiltinESMExports();`);
  const result = f.run(['--io-reader-min-lines', '500'], ['--import', pathToFileURL(injection).href]);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /injected_io_write_failure/);
  assert.deepEqual(await Promise.all(paths.map(p => readFile(path.join(f.home, p), 'utf8'))), before);
 } finally { await rm(f.base, { recursive: true, force: true }); }
});
