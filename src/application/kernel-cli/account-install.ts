import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { resolveRuntimeRoot } from '../../shared/runtime-assets.js';
import { canonicalPath } from '../../kernel/runtime-home.js';
import { physicalTargetIdentity } from '../../host/kernel/profile-target.js';

const repoRoot = resolveRuntimeRoot(import.meta.url);
const kernelInstaller = path.join(repoRoot, 'bin', 'moon-relay-kernel.mjs');
const deliverySubmit = path.join(repoRoot, 'scripts', 'delivery-submit.mjs');
const retroCli = path.join(repoRoot, 'tools', 'retro', 'retro-cli.mjs');
const PROFILE_RUNTIMES = ['claude', 'codex', 'qwen', 'ade', 'antigravity'] as const;
type ProfileRuntime = typeof PROFILE_RUNTIMES[number];
const isProfileRuntime = (value: string): value is ProfileRuntime => PROFILE_RUNTIMES.some(runtime => runtime === value);

const usage = `Usage:
  moonshot-relay [install] [--dry-run] [--json] [--sync]
  moonshot-relay install [--runtime all|claude,codex,qwen,ade,antigravity] [--claude-home <dir>] [--codex-home <dir>] [--qwen-home <dir>] [--ade-home <dir>] [--antigravity-home <dir>] [--antigravity-skills-home <dir>]
  moonshot-relay kernel [--json]
  moonshot-relay delivery submit --score <json-file> --verification <json-file> --current-sha <sha> [--mode local|pr|release] [--out <submission.json>] [--json]
  moonshot-relay retro collect|import|daily|propose|issue-draft [options]

The install command materializes the Kernel runtime and native-provider
integrations. Provider HOME, auth, session, cache, and unrelated user files
remain outside Kernel ownership.`;


export async function runAccountInstall(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
const args = argv.filter(arg => arg !== '--');

if (args.includes('--help') || args.includes('-h')) {
  console.log(usage);
  process.exit(0);
}

let command = 'install';
if (args[0] && !args[0].startsWith('-')) command = args.shift() ?? 'install';

if (!['install', 'kernel', 'delivery', 'retro', 'bridge'].includes(command)) {
  console.error(`Unknown command: ${command}\n${usage}`);
  process.exit(1);
}

const jsonMode = args.includes('--json');

const emitRetiredRelay = (surface = command) => {
  const receipt = {
    schemaVersion: 1,
    status: 'retired',
    runtime: 'moon-relay-kernel',
    surface,
    errorCode: 'relay_track_retired',
    message: 'The legacy Relay runtime path is retired; use the Kernel install and native surfaces.',
    sensitiveContentRead: false,
  };
  if (jsonMode) console.log(JSON.stringify(receipt, null, 2));
  else console.error(`${receipt.errorCode}: ${receipt.message}`);
  process.exit(1);
};

// These options belonged to the retired profile/runtime path. Refuse them
// explicitly so an old caller cannot silently request a different authority.
const RETIRED_OPTIONS = Object.freeze(['--moonshot-home', '--no-backup', '--clean-overlay']);
const isRetiredOption = (arg: string) => RETIRED_OPTIONS.some((option) => arg === option || arg.startsWith(`${option}=`));
const retiredOption = args.find(isRetiredOption);
if (retiredOption) emitRetiredRelay(retiredOption);

if (command === 'retro') {
  if (!existsSync(retroCli)) {
    console.error(`Moonshot Relay retro command not found: ${retroCli}`);
    process.exit(1);
  }
  const result = spawnSync(process.execPath, [retroCli, ...args], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

if (command === 'delivery') {
  const subcommand = args.shift();
  if (subcommand !== 'submit') {
    console.error(`Unknown delivery command: ${subcommand || ''}\n${usage}`);
    process.exit(1);
  }
  if (!existsSync(deliverySubmit)) {
    console.error(`Moonshot Relay delivery submit command not found: ${deliverySubmit}`);
    process.exit(1);
  }
  const result = spawnSync(process.execPath, [deliverySubmit, 'submit', ...args], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

if (command === 'bridge') emitRetiredRelay('bridge');

if (!existsSync(kernelInstaller)) {
  console.error(`Kernel installer not found: ${kernelInstaller}`);
  process.exit(1);
}

const userHome = process.env.USERPROFILE || process.env.HOME || os.homedir();
const optionValue = (flag: string) => {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] ?? null : null;
};

const adeHome = optionValue('--ade-home') || process.env.ADE_HOME;
const providerHomes = {
  claude: canonicalPath(optionValue('--claude-home') || process.env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_HOME || path.join(userHome, '.claude')),
  codex: canonicalPath(optionValue('--codex-home') || process.env.CODEX_HOME || path.join(userHome, '.codex')),
  qwen: canonicalPath(optionValue('--qwen-home') || process.env.QWEN_HOME || path.join(userHome, '.qwen')),
  ade: adeHome ? canonicalPath(adeHome) : null,
  antigravity: canonicalPath(optionValue('--antigravity-home') || process.env.ANTIGRAVITY_HOME || path.join(userHome, '.gemini', 'antigravity')),
};
const antigravitySkillsHome = optionValue('--antigravity-skills-home')
  || process.env.ANTIGRAVITY_SKILLS_HOME
  || path.join(userHome, '.gemini', 'config');

const requestedKernelHome = process.env.MOON_RELAY_KERNEL_HOME || path.join(userHome, '.moon-relay-kernel');
const kernelHomeIdentity = await physicalTargetIdentity(requestedKernelHome, {
  protectedRoots: [...Object.values(providerHomes).filter((home): home is string => home !== null), antigravitySkillsHome],
});
if (!kernelHomeIdentity.safe) {
  console.error(`Setup refused: unsafe Kernel home ${requestedKernelHome}`);
  process.exit(1);
}
const kernelHome = kernelHomeIdentity.canonicalPath;
const kernelEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  MOON_RELAY_TRACK: 'kernel',
  MOON_RELAY_KERNEL_HOME: kernelHome,
};
const legacyRuntimeEnvKey = ['MOONSHOT', 'RELAY', 'HOME'].join('_');
delete kernelEnvironment[legacyRuntimeEnvKey];

const requestedRuntimes = () => {
  const raw = optionValue('--runtime') || 'all';
  const names = raw === 'all'
    ? PROFILE_RUNTIMES.filter((runtime) => runtime !== 'ade' || providerHomes.ade)
    : raw.split(',').map((runtime) => runtime.trim()).filter(Boolean);
  if (!names.length || names.some((runtime) => !isProfileRuntime(runtime))) {
    console.error(`Unsupported runtime: ${raw}\n${usage}`);
    process.exit(1);
  }
  const unique = [...new Set(names)];
  if (unique.includes('ade') && !providerHomes.ade) {
    console.error(`ADE runtime requires --ade-home <dir> or ADE_HOME.\n${usage}`);
    process.exit(1);
  }
  return unique.filter(isProfileRuntime);
};

const runKernelCommand = (kernelArgs: readonly string[], label: string): unknown => {
  const childArgs = [...kernelArgs];
  if (jsonMode) childArgs.push('--json');
  const result = spawnSync(process.execPath, [kernelInstaller, ...childArgs], {
    cwd: repoRoot,
    env: kernelEnvironment,
    encoding: 'utf8',
    stdio: jsonMode ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.error) {
    console.error(`${label} failed: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${label} failed with exit code ${result.status}`);
    process.exit(result.status || 1);
  }
  if (!jsonMode) return { status: 'executed', command: label };
  try {
    const resultValue: unknown = JSON.parse(result.stdout || '{}');
    if (!resultValue || typeof resultValue !== 'object' || Array.isArray(resultValue)) throw new TypeError('Kernel command returned no receipt object');
    return resultValue;
  } catch (error) {
    console.error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
};

const runKernelInstall = () => runKernelCommand([
  'install',
  '--target-root', kernelHome,
  '--source-root', repoRoot,
  ...(args.includes('--sync') ? ['--sync'] : []),
], 'Kernel runtime install');

const runKernelIdentityBootstrap = () => runKernelCommand([
  'identity', 'bootstrap',
  '--project-root', repoRoot,
  '--runtime-home', kernelHome,
  '--policy', 'isolate',
], 'Kernel project identity bootstrap');

const runKernelProfileInstall = (runtime: ProfileRuntime) => {
  const providerHome = providerHomes[runtime];
  if (!providerHome) throw new Error(`Provider home is required for ${runtime}`);
  return runKernelCommand([
  'profile-install',
  '--runtime', runtime,
  '--target-root', providerHome,
  '--source-root', repoRoot,
  '--runtime-home', kernelHome,
  ...(runtime === 'codex' ? ['--account-root'] : []),
  ...(runtime === 'antigravity' ? ['--skills-root', antigravitySkillsHome] : []),
  ...(args.includes('--sync') ? ['--sync'] : []),
], `Kernel ${runtime} profile install`);
};

const runKernelIntegrations = (runtimes: readonly ProfileRuntime[]) => runtimes.map(runKernelProfileInstall);

const runInstall = () => {
  const runtimes = command === 'kernel' ? ['codex'] as const : requestedRuntimes();
  if (args.includes('--dry-run')) {
    const kernelPlan = runKernelCommand(['package', '--dry-run'], 'Kernel package dry-run');
    return {
      schemaVersion: 1,
      productId: 'moon-relay-kernel',
      runtime: 'moon-relay-kernel',
      dryRun: true,
      kernel: kernelPlan,
      profileRuntimes: runtimes,
      manifests: [],
    };
  }

  const kernel = runKernelInstall();
  const identity = runKernelIdentityBootstrap();
  const profiles = runKernelIntegrations(runtimes);
  return {
    schemaVersion: 1,
    productId: 'moon-relay-kernel',
    runtime: 'moon-relay-kernel',
    dryRun: false,
    kernel,
    identity,
    profiles,
    // Keep the top-level result easy for existing callers to consume while
    // making every entry explicitly Kernel-owned.
    manifests: [kernel, ...profiles],
  };
};

const result = runInstall();
if (!args.includes('--dry-run')) {
  console.error('Kernel installation and native-provider integration completed.');
}
if (jsonMode) console.log(JSON.stringify(result, null, 2));

}
