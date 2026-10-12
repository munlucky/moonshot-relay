#!/usr/bin/env node
import { requiredIndex } from '../shared/required-index.js';
import process from 'node:process';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolveKernelNode } from '../kernel/runtime-resolver.js';
import { resolveRuntimeRoot, resolveRuntimeAsset, isDirectEntrypoint } from '../shared/runtime-assets.js';
import { runKernelCliApplication } from '../application/kernel-cli/main.js';

interface KernelCliResult {
  exitCode: number;
  reexecuted?: boolean;
}

interface KernelCliDependencies {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
  spawnSync?: typeof nodeSpawnSync;
  readJsonFile?: (file: string) => Promise<unknown>;
  managedRuntimeHome?: string;
}

const installedPayloadRoot = resolveRuntimeRoot(import.meta.url);
const currentFile = resolveRuntimeAsset(import.meta.url, 'bin', 'moon-relay-kernel.mjs');
const runKernelApplication = runKernelCliApplication;

const getArgValue = (argv: readonly string[], flag: string): string | null => {
  const index = argv.indexOf(flag);
  return index >= 0 && index + 1 < argv.length ? requiredIndex(argv, index + 1) : null;
};

const defaultReadJsonFile = async (file: string): Promise<unknown> => (
  JSON.parse(await readFile(file, 'utf8')) as unknown
);

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

export async function main(
  argv: string[] = process.argv.slice(2),
  deps: KernelCliDependencies = {},
): Promise<KernelCliResult> {
  const cwd = deps.cwd || process.cwd();
  const env = deps.env || process.env;
  const stdout = deps.stdout || ((value: string) => console.log(value));
  const stderr = deps.stderr || ((value: string) => console.error(value));
  const spawnSync = deps.spawnSync || nodeSpawnSync;
  const readJsonFile = deps.readJsonFile || defaultReadJsonFile;
  const managedRuntimeHome = deps.managedRuntimeHome
    || getArgValue(argv, '--managed-runtime-home')
    || installedPayloadRoot;

  if (!env.MOON_RELAY_KERNEL_REEXEC) {
    let runtimeInfo = null;
    try {
      runtimeInfo = await resolveKernelNode({ runtimeHome: managedRuntimeHome });
    } catch {
      runtimeInfo = null;
    }
    if (
      runtimeInfo?.source === 'managed'
      && runtimeInfo.nodePath
      && runtimeInfo.nodePath !== process.execPath
    ) {
      const childEnv = { ...env, MOON_RELAY_KERNEL_REEXEC: '1' };
      const child = spawnSync(
        runtimeInfo.nodePath,
        [currentFile, ...argv],
        { env: childEnv, stdio: 'inherit', cwd },
      );
      if (child.error) throw child.error;
      const signalExitCodes: Partial<Record<NodeJS.Signals, number>> = {
        SIGINT: 130,
        SIGTERM: 143,
        SIGKILL: 137,
      };
      return {
        exitCode: child.signal
          ? (signalExitCodes[child.signal] ?? 1)
          : (child.status ?? 1),
        reexecuted: true,
      };
    }
  }

  const result = await runKernelApplication(argv, {
    cwd,
    env,
    managedRuntimeHome,
    readJsonFile,
    emitOutput: stdout,
    emitError: stderr,
  });
  const exitCode = (
    result
    && typeof result === 'object'
    && 'exitCode' in result
    && typeof result.exitCode === 'number'
  )
    ? result.exitCode
    : 0;
  return { exitCode };
}

if (isDirectEntrypoint(import.meta.url)) {
  main()
    .then((result) => {
      process.exitCode = result.exitCode;
    })
    .catch((error: unknown) => {
      console.error(errorMessage(error));
      process.exitCode = 1;
    });
}
