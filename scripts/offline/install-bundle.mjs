#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { access, cp, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const bundleRoot = path.resolve(path.dirname(scriptPath), '..', '..');
const relayInstaller = path.join(bundleRoot, 'scripts', 'install-account-root-harness.mjs');
const kernelCli = path.join(bundleRoot, 'bin', 'moon-relay-kernel.mjs');
const payloadRoot = path.join(bundleRoot, 'payload');
const defaultMoonshotHome = path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.moonshot-relay');

const usage = () => `Usage: Install-Offline.cmd [--dry-run] [--debug] [--json] [--skip-kernel] [--skip-provider-profiles]
  [--with-common] [--skip-common] [--runtime <claude,codex,qwen,ade>]
  [--moonshot-home <dir>] [--claude-home <dir>] [--codex-home <dir>] [--qwen-home <dir>] [--ade-home <dir>]
  [--kernel-home <dir>] [--no-backup] [--remove-legacy-harness-core]`;

const pathExists = async (target) => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

const parseArgs = (argv) => {
  const options = {
    dryRun: false,
    json: false,
    skipKernel: false,
    skipProviderProfiles: false,
    skipCommon: true,
    runtimes: ['claude', 'codex', 'qwen', ...(process.env.ADE_HOME ? ['ade'] : [])],
    passthrough: [],
    moonshotHome: path.resolve(process.env.MOONSHOT_RELAY_HOME || defaultMoonshotHome),
    kernelHome: process.env.MOON_RELAY_KERNEL_HOME
      || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.moon-relay-kernel'),
    adeHome: process.env.ADE_HOME ? path.resolve(process.env.ADE_HOME) : null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run' || arg === '--debug') {
      options.dryRun = true;
      if (!options.passthrough.includes('--dry-run')) {
        options.passthrough.push('--dry-run');
      }
    } else if (arg === '--json') {
      options.json = true;
      options.passthrough.push(arg);
    } else if (arg === '--skip-kernel') {
      options.skipKernel = true;
    } else if (arg === '--skip-provider-profiles') {
      options.skipProviderProfiles = true;
    } else if (arg === '--skip-common') {
      options.skipCommon = true;
    } else if (arg === '--with-common') {
      options.skipCommon = false;
    } else if (arg === '--runtime') {
      options.runtimes = argv[++index].split(',').map((r) => r.trim()).filter(Boolean);
    } else if (arg === '--kernel-home') {
      options.kernelHome = path.resolve(argv[++index]);
    } else if (arg === '--ade-home') {
      options.adeHome = path.resolve(argv[++index]);
      options.passthrough.push(arg, options.adeHome);
    } else if (['--moonshot-home', '--claude-home', '--codex-home', '--qwen-home'].includes(arg)) {
      const resolved = path.resolve(argv[++index]);
      if (arg === '--moonshot-home') options.moonshotHome = resolved;
      options.passthrough.push(arg, resolved);
    } else if (['--no-backup', '--remove-legacy-harness-core'].includes(arg)) {
      options.passthrough.push(arg);
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }

  const supportedRuntimes = new Set(['claude', 'codex', 'qwen', 'ade']);
  if (options.runtimes.length === 0 || options.runtimes.some((runtime) => !supportedRuntimes.has(runtime))) {
    throw new Error(`Unsupported runtime list: ${options.runtimes.join(',')}`);
  }
  if (options.runtimes.includes('ade') && !options.adeHome) {
    throw new Error('ADE runtime requires --ade-home <dir> or ADE_HOME.');
  }

  return options;
};

const run = (executable, args, options = {}) => {
  const result = spawnSync(executable, args, {
    cwd: bundleRoot,
    encoding: 'utf8',
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
    const detail = options.capture ? (result.stderr || result.stdout) : '';
    throw new Error(`${path.basename(executable)} exited with ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return result;
};

const findPayloadNode = async () => {
  const runtimeRoot = path.join(payloadRoot, 'moonshot-relay', 'profile', 'runtime');
  const manifestPath = path.join(runtimeRoot, 'runtime-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const versionDir = path.join(runtimeRoot, 'versions', `${manifest.version}-${manifest.platform}-${manifest.arch}`);
  const nodePath = manifest.platform === 'win32'
    ? path.join(versionDir, 'node.exe')
    : path.join(versionDir, 'bin', 'node');
  return { manifest, versionDir, nodePath: path.normalize(nodePath) };
};

const installKernel = async (options, nodePath) => {
  if (options.skipKernel || options.dryRun) return { status: options.skipKernel ? 'skipped' : 'dry-run' };

  const kernelArgs = [
    kernelCli,
    'install',
    '--target-root',
    options.kernelHome,
    '--source-root',
    bundleRoot,
    '--runtime-source',
    path.dirname(nodePath),
    '--json',
  ];
  const installed = [run(nodePath, kernelArgs, { capture: true })];

  if (!options.skipProviderProfiles) {
    for (const runtime of options.runtimes) {
      const targetRoot = path.join(options.kernelHome, 'providers', runtime);
      installed.push(run(nodePath, [
        kernelCli,
        'profile-install',
        '--runtime',
        runtime,
        '--target-root',
        targetRoot,
        '--source-root',
        bundleRoot,
        '--json',
      ], { capture: true }));
    }
  }

  return {
    status: 'installed',
    kernelHome: options.kernelHome,
    providerRuntimes: options.skipProviderProfiles ? [] : options.runtimes,
    adeHome: options.adeHome,
    output: installed.map((entry) => entry.stdout ? JSON.parse(entry.stdout) : null),
  };
};

const installProductionDependencies = async (options) => {
  const sourceRoot = path.join(bundleRoot, 'node_modules');
  const targetRoot = path.join(options.moonshotHome, 'node_modules');
  if (!(await pathExists(sourceRoot))) throw new Error(`Missing bundled production dependencies: ${sourceRoot}`);
  if (options.dryRun) return { status: 'dry-run', sourceRoot, targetRoot };
  await mkdir(options.moonshotHome, { recursive: true });
  await cp(sourceRoot, targetRoot, { recursive: true, force: true });
  return { status: 'installed', sourceRoot, targetRoot };
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (!(await pathExists(relayInstaller))) throw new Error(`Missing relay installer: ${relayInstaller}`);
  if (!(await pathExists(payloadRoot))) throw new Error(`Missing materialized payload: ${payloadRoot}`);

  const { nodePath } = await findPayloadNode();
  if (!(await pathExists(nodePath))) throw new Error(`Missing bundled Node runtime: ${nodePath}`);

  const kernel = await installKernel(options, nodePath);
  const relayPassthrough = options.passthrough.filter((arg) => arg !== '--json');
  const relayArgs = [
    relayInstaller,
    '--runtime',
    options.runtimes.join(','),
    '--source-root',
    bundleRoot,
    '--payload-root',
    payloadRoot,
    '--remove-legacy-harness-core',
    '--json',
    ...(options.skipCommon ? ['--skip-common'] : []),
    ...relayPassthrough,
  ];
  const relayResult = run(nodePath, relayArgs, { capture: true });
  const relay = JSON.parse(relayResult.stdout);

  let adeProfile = null;
  if (options.adeHome && options.runtimes.includes('ade') && !options.skipProviderProfiles) {
    const installed = run(nodePath, [
      kernelCli,
      'profile-install',
      '--runtime', 'ade',
      '--target-root', options.adeHome,
      '--source-root', bundleRoot,
      '--json',
    ], { capture: true });
    adeProfile = installed.stdout ? JSON.parse(installed.stdout) : null;
  }

  const dependencies = await installProductionDependencies(options);

  const result = {
    schemaVersion: 1,
    bundleRoot,
    targetNode: nodePath,
    antigravity: 'excluded',
    dependencies,
    kernel,
    relay,
    adeProfile,
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (options.dryRun) {
    console.log('============================================================');
    console.log('[DRY-RUN / DEBUG MODE] Moonshot Relay offline installer');
    console.log('실제 파일 쓰기 작업은 수행되지 않았습니다. (No disk changes made)');
    console.log('============================================================');
    console.log(`번들 소스: ${bundleRoot}`);
    console.log(`내장 Node.js: ${nodePath}`);
    console.log(`Kernel 홈: ${options.kernelHome} (Kernel 엔진 및 필수 페이로드 249개, status: ${kernel.status})`);
    if (options.skipCommon) {
      console.log(`공통 하네스(.moonshot-relay 995개 복사): 제외됨 (미니멀 모드)`);
    } else {
      console.log(`공통 런타임 홈: ${options.moonshotHome}`);
    }
    console.log(`의존성(node_modules): status=${dependencies.status} (${dependencies.sourceRoot} -> ${dependencies.targetRoot})`);
    console.log(`프로필 대상:`);
    for (const manifest of relay.manifests) {
      console.log(`  - [${manifest.runtime}] ${manifest.targetRoot} (설치 예정 파일: ${manifest.copiedCount}개)`);
    }
    if (options.adeHome && options.runtimes.includes('ade')) console.log(`ADE Home: ${options.adeHome}`);
    console.log(`Antigravity: excluded`);
    console.log('============================================================');
    console.log('디버깅 시뮬레이션이 성공적으로 완료되었습니다.');
  } else {
    console.log(`Installed Moonshot Relay offline bundle from ${bundleRoot}`);
    console.log(`Kernel: ${options.kernelHome}`);
    console.log(`Profiles: ${options.runtimes.join(', ')}`);
    if (options.adeHome && options.runtimes.includes('ade')) console.log(`ADE Home: ${options.adeHome}`);
    if (options.skipCommon) {
      console.log(`Common relay harness (995 files): skipped`);
    }
    console.log(`Antigravity: excluded`);
  }
};

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
