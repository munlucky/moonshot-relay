#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..', '..');
const selectedRuntimes = ['claude', 'codex', 'qwen'];

const usage = () => `Usage: node scripts/offline/build-bundle.mjs [--node-runtime <path-to-node-win32-x64>] [--out <directory>] [--zip]`;

const pathExists = async (target) => {
  try {
    await stat(target);
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

const sha256File = async (target) => createHash('sha256').update(await readFile(target)).digest('hex');

const parseArgs = (argv) => {
  const options = {
    nodeRuntime: process.execPath,
    out: path.join(os.tmpdir(), 'moonshot-relay-offline-bundles'),
    zip: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--node-runtime') options.nodeRuntime = path.resolve(argv[++index]);
    else if (arg === '--out') options.out = path.resolve(argv[++index]);
    else if (arg === '--zip') options.zip = true;
    else if (arg === '--no-zip') options.zip = false;
    else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}\n${usage()}`);
  }
  return options;
};

const run = (executable, args, options = {}) => {
  const result = spawnSync(executable, args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    // npm.cmd is a Windows command shim rather than a native executable;
    // Node 24 returns EINVAL when it is spawned without the shell.
    shell: process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(executable),
    env: {
      ...process.env,
      npm_config_offline: 'true',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      ...options.env,
    },
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(executable)} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout || ''}`);
  }
  return result;
};

const probeNode = (nodeRuntime) => {
  const result = run(nodeRuntime, ['-p', 'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch,modules:process.versions.modules})'], { capture: true });
  const info = JSON.parse(result.stdout);
  const cleanVersion = info.version.replace(/^v/u, '');
  if (info.platform !== 'win32' || info.arch !== 'x64' || info.modules !== '137') {
    throw new Error(`Target Node mismatch: expected win32/x64/ABI:137, got ${JSON.stringify(info)}`);
  }
  return { ...info, cleanVersion };
};

const gitHead = () => run('git', ['rev-parse', 'HEAD'], { capture: true }).stdout.trim();

const shouldCopy = (relative) => {
  const portable = relative.replaceAll('\\', '/');
  const top = portable.split('/')[0];
  const allowedTop = new Set([
    'agents', 'bin', 'catalog', 'docs', 'install-claude.ps1', 'install-claude.sh',
    'kernel', 'package', 'package.json', 'package-lock.json', 'rules', 'schemas', 'scripts',
    'skills', 'skills.lock.json', 'templates', 'tools', 'verification.contract.yaml',
    'README.md', 'AGENTS.md', '.claude-plugin', '.codex-plugin',
  ]);
  if (!allowedTop.has(top)) return false;
  if (portable.startsWith('docs/public/') === false && top === 'docs') return false;
  if (portable.startsWith('package/profile-templates/antigravity/')) return false;
  if (portable.startsWith('package/kernel/profiles/antigravity/')) return false;
  if (portable.startsWith('package/antigravity/')) return false;
  if (portable.includes('/profile/.gemini/')) return false;
  if (portable.startsWith('package/claude/profile/') || portable.startsWith('package/codex/profile/') || portable.startsWith('package/qwen/profile/')) return false;
  return true;
};

const copyTrackedSource = async (destinationRoot) => {
  const result = run('git', ['ls-files', '-co', '--exclude-standard', '-z'], { capture: true });
  const files = result.stdout.split('\0').filter(Boolean).filter(shouldCopy);
  for (const relative of files) {
    const source = path.join(repoRoot, relative);
    const destination = path.join(destinationRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { force: true });
  }
  return files;
};

const copyProductionDependencies = async (stageRoot) => {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = run(npm, ['ci', '--omit=dev', '--offline', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: stageRoot, capture: true });
  return { method: 'npm-ci-offline', stdout: result.stdout.slice(-4000), stderr: result.stderr.slice(-4000) };
};

const packOfflineDependencies = async (stageRoot) => {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const destination = path.join(stageRoot, 'offline-deps');
  await mkdir(destination, { recursive: true });
  const lock = JSON.parse(await readFile(path.join(stageRoot, 'package-lock.json'), 'utf8'));
  const dependencyPackages = Object.entries(lock.packages || {})
    .filter(([entry, metadata]) => entry.startsWith('node_modules/') && metadata?.dev !== true)
    .map(([entry, metadata]) => {
      const relativePackagePath = entry.slice('node_modules/'.length);
      const name = relativePackagePath.split('/node_modules/').at(-1);
      if (!metadata?.version) throw new Error(`Missing locked package metadata for offline dependency: ${name}`);
      return {
        entry,
        name,
        version: metadata.version,
        packageRoot: path.join(stageRoot, 'node_modules', relativePackagePath),
      };
    })
    .sort((left, right) => left.entry.localeCompare(right.entry));
  const dependencies = [...new Set(dependencyPackages.map(({ name, version }) => `${name}@${version}`))];
  const packResults = [];
  const packedDependencies = new Set();
  for (const dependency of dependencyPackages) {
    const dependencyId = `${dependency.name}@${dependency.version}`;
    if (packedDependencies.has(dependencyId)) continue;
    packedDependencies.add(dependencyId);
    if (!await pathExists(dependency.packageRoot)) {
      throw new Error(`Missing installed package for offline dependency: ${dependency.entry}`);
    }
    const result = run(npm, [
      'pack',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--pack-destination',
      destination,
      '.',
    ], { cwd: dependency.packageRoot, capture: true });
    packResults.push({ name: dependency.name, version: dependency.version, stdout: result.stdout.slice(-1000), stderr: result.stderr.slice(-1000) });
  }
  const repairTarballs = (await listFiles(destination)).filter((file) => file.toLowerCase().endsWith('.tgz'));
  const repairCommand = repairTarballs
    .map((file) => `.\\offline-deps\\${file}`)
    .join(' ');
  await writeFile(
    path.join(destination, 'README.md'),
    `Offline dependency repair\n\nThe normal bundle already contains node_modules. If repair is needed from the bundle root, install the tarballs together:\n\n  npm install --offline --no-audit --no-fund --ignore-scripts --no-save ${repairCommand}\n\nDo not run npm install without --offline on the closed-network PC.\n`,
    'utf8',
  );
  return { dependencies, repairTarballs, packResults, files: await listFiles(destination) };
};

const buildPayload = async (stageRoot, nodeRuntime) => {
  const builder = path.join(stageRoot, 'package', 'build-package.mjs');
  const out = path.join(stageRoot, 'payload');
  const runtimes = ['moonshot-relay', ...selectedRuntimes];
  const results = [];
  for (const runtime of runtimes) {
    const result = run(nodeRuntime, [builder, '--runtime', runtime, '--out', out, '--clean', '--json'], { cwd: stageRoot, capture: true });
    results.push(JSON.parse(result.stdout));
  }
  return results;
};

const writeBundleGuide = async (stageRoot, manifest) => {
  const repairCommand = manifest.dependencies.repairTarballs
    .map((file) => `.\\offline-deps\\${file}`)
    .join(' ');
  const text = `# Moonshot Relay 폐쇄망 설치 번들\n\n`
    + `- 기준 commit: \`${manifest.source.gitHead}\`\n`
    + `- 대상: Windows x64 / Node v${manifest.target.nodeVersion} / ABI ${manifest.target.modules}\n`
    + `- 설치 프로필: Claude, Codex, Qwen\n`
    + `- Antigravity: 제외\n\n`
    + `## 반입 전\n\n`
    + `1. 이 폴더와 함께 외부 파일 \`*.zip.sha256\`을 복사합니다. 압축파일 내부에 최종 ZIP hash를 넣지 않습니다.\n`
    + `2. 폐쇄망 PC에서 ZIP을 임의의 작업 폴더에 먼저 압축 해제합니다. ZIP 내부에서 실행하지 않습니다.\n`
    + `3. 압축 해제 폴더에서 \`Verify-Offline.cmd\`를 실행합니다. 네트워크를 사용하지 않습니다.\n\n`
    + `## 설치\n\n`
    + `\`Install-Offline.cmd\`를 실행하면 계정 루트에 공통 Relay payload와 Claude/Codex/Qwen 프로필을 설치하고, Kernel provider도 세 프로필만 설치합니다.\n\n`
    + `기본 설치 위치:\n\n`
    + `- \`%USERPROFILE%\\.moonshot-relay\`\n`
    + `- \`%USERPROFILE%\\.claude\`\n`
    + `- \`%USERPROFILE%\\.codex\`\n`
    + `- \`%USERPROFILE%\\.qwen\`\n`
    + `- \`%USERPROFILE%\\.moon-relay-kernel\`\n\n`
    + `경로를 바꾸려면 예를 들어 다음처럼 실행합니다:\n\n`
    + `\`Install-Offline.cmd --moonshot-home D:\\Moonshot\\.moonshot-relay --claude-home D:\\Moonshot\\.claude --codex-home D:\\Moonshot\\.codex --qwen-home D:\\Moonshot\\.qwen --kernel-home D:\\Moonshot\\.moon-relay-kernel\`\n\n`
    + `## npm 의존성 복구\n\n`
    + `정상 설치에는 npm 호출이 필요하지 않으며 번들 안의 \`node_modules\`를 사용합니다. 손상 시에만 아래처럼 오프라인 tarball을 사용합니다:\n\n`
    + `\`npm install --offline --no-audit --no-fund --ignore-scripts --no-save ${repairCommand}\`\n\n`
    + `인터넷 registry, \`npx\`, \`git clone\`은 사용하지 마십시오.\n\n`
    + `브라우저 Playwright/Chromium은 선택적 browserd 기능이며 이 기본 설치의 필수 의존성이 아닙니다.\n`;
  await writeFile(path.join(stageRoot, 'START_HERE_OFFLINE.ko.md'), text, 'utf8');
};

const writeLaunchers = async (stageRoot, nodeVersion) => {
  const nodeRel = `payload\\moonshot-relay\\profile\\runtime\\versions\\${nodeVersion}-win32-x64\\node.exe`;
  await writeFile(path.join(stageRoot, 'Install-Offline.cmd'), `@echo off\r\nsetlocal\r\nset "ROOT=%~dp0"\r\nset "NODE_BIN=node"\r\nif exist "%ROOT%${nodeRel}" set "NODE_BIN=%ROOT%${nodeRel}"\r\n"%NODE_BIN%" "%ROOT%scripts\\offline\\install-bundle.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`, 'utf8');
  await writeFile(path.join(stageRoot, 'Verify-Offline.cmd'), `@echo off\r\nsetlocal\r\nset "ROOT=%~dp0"\r\nset "NODE_BIN=node"\r\nif exist "%ROOT%${nodeRel}" set "NODE_BIN=%ROOT%${nodeRel}"\r\n"%NODE_BIN%" "%ROOT%scripts\\offline\\verify-bundle.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`, 'utf8');
  await writeFile(path.join(stageRoot, 'Install-Offline.ps1'), `param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Args)\n$root = $PSScriptRoot\n$node = Join-Path $root '${nodeRel}'\nif (-not (Test-Path -LiteralPath $node)) { $node = 'node' }\n& $node (Join-Path $root 'scripts\\offline\\install-bundle.mjs') @Args\nexit $LASTEXITCODE\n`, 'utf8');
  await writeFile(path.join(stageRoot, 'Verify-Offline.ps1'), `param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Args)\n$root = $PSScriptRoot\n$node = Join-Path $root '${nodeRel}'\nif (-not (Test-Path -LiteralPath $node)) { $node = 'node' }\n& $node (Join-Path $root 'scripts\\offline\\verify-bundle.mjs') @Args\nexit $LASTEXITCODE\n`, 'utf8');
};

const writeHashes = async (stageRoot) => {
  const files = (await listFiles(stageRoot)).filter((file) => file !== 'MANIFEST.sha256');
  const lines = [];
  for (const file of files) lines.push(`${await sha256File(path.join(stageRoot, file))}  ${file}`);
  await writeFile(path.join(stageRoot, 'MANIFEST.sha256'), `${lines.join('\n')}\n`, 'utf8');
  return { fileCount: files.length, digest: createHash('sha256').update(lines.join('\n')).digest('hex') };
};

const zipBundle = (stageRoot, outRoot) => {
  const zipPath = `${stageRoot}.zip`;
  run('tar', ['-a', '-cf', zipPath, '-C', path.dirname(stageRoot), path.basename(stageRoot)], { cwd: outRoot });
  const hash = createHash('sha256').update(readFileSync(zipPath)).digest('hex').toUpperCase();
  writeFileSync(`${zipPath}.sha256`, `${hash}  ${path.basename(zipPath)}\n`);
  return { zipPath, zipSha256: hash };
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const nodeInfo = probeNode(options.nodeRuntime);
  const targetNodeVersion = nodeInfo.cleanVersion;
  const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
  const bundleName = `moonshot-relay-offline-win32-x64-node${targetNodeVersion}-${stamp}`;
  const stageRoot = path.join(options.out, bundleName);
  await mkdir(options.out, { recursive: true });
  await rm(stageRoot, { recursive: true, force: true });
  await mkdir(stageRoot, { recursive: true });

  const copiedFiles = await copyTrackedSource(stageRoot);
  const dependencyInstall = await copyProductionDependencies(stageRoot);
  const offlineDependencies = await packOfflineDependencies(stageRoot);
  const payload = await buildPayload(stageRoot, options.nodeRuntime);
  const manifest = {
    schemaVersion: 1,
    bundleId: bundleName,
    builtAt: new Date().toISOString(),
    source: { gitHead: gitHead(), repository: 'moonshot-relay' },
    target: { platform: nodeInfo.platform, arch: nodeInfo.arch, nodeVersion: targetNodeVersion, modules: nodeInfo.modules },
    runtimes: selectedRuntimes,
    antigravity: { included: false, installSurface: 'excluded' },
    dependencies: {
      root: offlineDependencies.dependencies,
      repairTarballs: offlineDependencies.repairTarballs,
      nativeSmoke: 'better-sqlite3',
      delivery: 'node_modules plus offline-deps/*.tgz',
    },
    payloadBuild: payload,
    sourceFileCount: copiedFiles.length,
    dependencyInstall,
    excluded: ['Antigravity profile templates and Kernel profiles', 'generated state, caches, evidence, tests, archive, browser binaries'],
  };
  await writeFile(path.join(stageRoot, 'bundle-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeBundleGuide(stageRoot, manifest);
  await writeLaunchers(stageRoot, targetNodeVersion);
  await writeHashes(stageRoot);

  let archive = null;
  if (options.zip) archive = zipBundle(stageRoot, options.out);
  const result = { stageRoot, archive, manifestPath: path.join(stageRoot, 'bundle-manifest.json') };
  console.log(JSON.stringify(result, null, 2));
};

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
