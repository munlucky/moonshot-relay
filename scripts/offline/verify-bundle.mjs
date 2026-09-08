#!/usr/bin/env node

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createHash as sha256 } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultBundleRoot = path.resolve(path.dirname(scriptPath), '..', '..');
const selectedRuntimes = ['claude', 'codex', 'qwen'];

const pathExists = async (target) => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

const listFiles = async (root, prefix = '') => {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, relative));
    else if (entry.isFile()) files.push(relative.replaceAll('\\', '/'));
  }
  return files.sort();
};

const hashFile = async (target) => sha256('sha256').update(await readFile(target)).digest('hex');

const parseArgs = (argv) => {
  const options = { bundleRoot: defaultBundleRoot, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--bundle-root') options.bundleRoot = path.resolve(argv[++index]);
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: Verify-Offline.cmd [--bundle-root <dir>] [--json]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
};

const verifyManifest = async (root, failures) => {
  const manifestPath = path.join(root, 'MANIFEST.sha256');
  const raw = await readFile(manifestPath, 'utf8');
  const expected = new Map();
  for (const line of raw.split(/\r?\n/u).filter(Boolean)) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/u);
    if (!match) failures.push(`invalid manifest line: ${line}`);
    else expected.set(match[2], match[1]);
  }
  const actualFiles = (await listFiles(root)).filter((file) => file !== 'MANIFEST.sha256');
  for (const file of actualFiles) {
    if (!expected.has(file)) failures.push(`unlisted file: ${file}`);
    else if (await hashFile(path.join(root, file)) !== expected.get(file)) failures.push(`sha256 mismatch: ${file}`);
  }
  for (const file of expected.keys()) {
    if (!actualFiles.includes(file)) failures.push(`missing file: ${file}`);
  }
};

const verifyRuntime = async (root, failures, evidence) => {
  const manifestPath = path.join(root, 'payload', 'moonshot-relay', 'profile', 'runtime', 'runtime-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const versionDir = path.join(root, 'payload', 'moonshot-relay', 'profile', 'runtime', 'versions', `${manifest.version}-${manifest.platform}-${manifest.arch}`);
  const nodePath = path.join(versionDir, 'node.exe');
  const nodeOutput = spawnSync(nodePath, ['-p', 'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch,modules:process.versions.modules})'], { encoding: 'utf8' });
  if (nodeOutput.status !== 0) failures.push(`bundled Node failed: ${nodeOutput.stderr || nodeOutput.stdout}`);
  const nodeInfo = JSON.parse(nodeOutput.stdout);
  if (nodeInfo.version !== `v${manifest.version}` || nodeInfo.platform !== 'win32' || nodeInfo.arch !== 'x64' || nodeInfo.modules !== '137') {
    failures.push(`unexpected Node runtime: ${JSON.stringify(nodeInfo)}`);
  }
  const actualChecksum = await hashFile(nodePath);
  if (actualChecksum !== manifest.checksum) failures.push('runtime-manifest checksum mismatch');
  evidence.runtime = { manifest, nodeInfo, nodePath, checksum: actualChecksum };
};

const verifyNativeDependency = async (root, failures, evidence) => {
  const packageJson = path.join(root, 'node_modules', 'better-sqlite3', 'package.json');
  const requireFromBundle = createRequire(path.join(root, 'package.json'));
  try {
    const Database = requireFromBundle('better-sqlite3');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (x TEXT)');
    db.prepare('INSERT INTO t VALUES (?)').run('offline-ok');
    const value = db.prepare('SELECT x FROM t').get().x;
    db.close();
    evidence.nativeDependency = { package: JSON.parse(await readFile(packageJson, 'utf8')).version, value };
    if (value !== 'offline-ok') failures.push('better-sqlite3 smoke returned unexpected value');
  } catch (error) {
    failures.push(`better-sqlite3 smoke failed: ${error.message}`);
  }
};

const verifyPayloadAndDryRun = async (root, failures, evidence) => {
  const forbidden = [];
  for (const directory of ['payload', 'package/profile-templates', 'package/kernel/profiles']) {
    if (!(await pathExists(path.join(root, directory)))) continue;
    for (const file of await listFiles(path.join(root, directory))) {
      if (file.toLowerCase().includes('antigravity')) forbidden.push(`${directory}/${file}`);
    }
  }
  if (forbidden.length) failures.push(`Antigravity payload present: ${forbidden.join(', ')}`);

  for (const runtime of selectedRuntimes) {
    const profile = path.join(root, 'payload', runtime, 'profile', `.${runtime === 'claude' ? 'claude' : runtime}`);
    if (!(await pathExists(profile))) failures.push(`missing ${runtime} profile payload`);
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'moonshot-relay-offline-verify-'));
  try {
    const nodePath = evidence.runtime.nodePath;
    const installer = path.join(root, 'scripts', 'install-account-root-harness.mjs');
    const result = spawnSync(nodePath, [
      installer,
      '--runtime',
      selectedRuntimes.join(','),
      '--source-root',
      root,
      '--payload-root',
      path.join(root, 'payload'),
      '--moonshot-home',
      path.join(tempRoot, 'moonshot'),
      '--claude-home',
      path.join(tempRoot, 'claude'),
      '--codex-home',
      path.join(tempRoot, 'codex'),
      '--qwen-home',
      path.join(tempRoot, 'qwen'),
      '--dry-run',
      '--json',
    ], { cwd: root, encoding: 'utf8', env: { ...process.env, npm_config_offline: 'true' } });
    if (result.status !== 0) failures.push(`offline installer dry-run failed: ${result.stderr || result.stdout}`);
    else {
      const parsed = JSON.parse(result.stdout);
      const installed = parsed.manifests.map((entry) => entry.runtime).sort();
      const expected = ['claude', 'codex', 'moonshot-relay', 'qwen'].sort();
      if (JSON.stringify(installed) !== JSON.stringify(expected)) failures.push(`unexpected dry-run runtimes: ${installed.join(',')}`);
      evidence.installerDryRun = parsed;
    }

    const actualRoot = path.join(tempRoot, 'actual-install');
    const actualMoonshotHome = path.join(actualRoot, 'moonshot');
    const actualInstaller = path.join(root, 'scripts', 'offline', 'install-bundle.mjs');
    const actualResult = spawnSync(nodePath, [
      actualInstaller,
      '--skip-kernel',
      '--skip-provider-profiles',
      '--moonshot-home',
      actualMoonshotHome,
      '--claude-home',
      path.join(actualRoot, 'claude'),
      '--codex-home',
      path.join(actualRoot, 'codex'),
      '--qwen-home',
      path.join(actualRoot, 'qwen'),
      '--json',
    ], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        npm_config_offline: 'true',
        npm_config_registry: 'http://127.0.0.1:9/',
      },
    });
    if (actualResult.status !== 0) {
      failures.push(`offline installer actual run failed: ${actualResult.stderr || actualResult.stdout}`);
    } else {
      const parsed = JSON.parse(actualResult.stdout);
      if (parsed.dependencies?.status !== 'installed') failures.push('offline installer did not install bundled production dependencies');
      const installedPackage = path.join(actualMoonshotHome, 'node_modules', 'better-sqlite3', 'package.json');
      if (!(await pathExists(installedPackage))) failures.push('offline installer omitted better-sqlite3 from the installed common home');
      const smoke = spawnSync(nodePath, ['-e', [
        "const Database = require('better-sqlite3');",
        "const db = new Database(':memory:');",
        "db.exec('CREATE TABLE t (x TEXT)');",
        "db.prepare('INSERT INTO t VALUES (?)').run('installed-offline-ok');",
        "if (db.prepare('SELECT x FROM t').get().x !== 'installed-offline-ok') process.exit(1);",
        'db.close();',
      ].join('')], { cwd: actualMoonshotHome, encoding: 'utf8' });
      if (smoke.status !== 0) failures.push(`installed better-sqlite3 smoke failed: ${smoke.stderr || smoke.stdout}`);
      evidence.installerActual = {
        dependencies: parsed.dependencies,
        relay: parsed.relay,
        installedPackage,
        nativeSmoke: smoke.status === 0,
      };
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};

const main = async () => {
  const { bundleRoot, json } = parseArgs(process.argv.slice(2));
  const failures = [];
  const evidence = { bundleRoot, selectedRuntimes, antigravity: 'excluded' };
  const manifest = JSON.parse(await readFile(path.join(bundleRoot, 'bundle-manifest.json'), 'utf8'));
  if (!manifest.target?.nodeVersion) failures.push('missing target Node version in bundle-manifest');
  if (JSON.stringify(manifest.runtimes) !== JSON.stringify(selectedRuntimes)) failures.push('bundle runtime selection drift');
  await verifyManifest(bundleRoot, failures);
  await verifyRuntime(bundleRoot, failures, evidence);
  await verifyNativeDependency(bundleRoot, failures, evidence);
  await verifyPayloadAndDryRun(bundleRoot, failures, evidence);
  const result = { status: failures.length ? 'failed' : 'passed', failures, evidence };
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(`${result.status}: ${failures.length ? failures.join('; ') : 'offline bundle integrity, runtime, native dependency, payload, and installer dry-run checks passed'}`);
  process.exitCode = failures.length ? 1 : 0;
};

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
