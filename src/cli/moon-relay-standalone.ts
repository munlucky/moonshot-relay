#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import { printResult } from '../kernel/standalone/common.js';
import { resolveRuntimeRoot, isDirectEntrypoint } from '../shared/runtime-assets.js';
import { runStandaloneCliApplication } from '../application/kernel-cli/standalone.js';

interface StandaloneCliResult {
  exitCode: number;
}

interface StandaloneOutputOptions {
  json?: boolean;
}

type StandaloneOutput = (
  value: unknown,
  options?: StandaloneOutputOptions,
) => unknown;

interface StandaloneCliDependencies {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runtimeRoot?: string | null;
  invokedPath?: string;
  output?: StandaloneOutput;
}

interface ResolvedStandaloneInvocation {
  name: string;
  argv: string[];
}

const invokedName = (
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  invokedPath: string,
): ResolvedStandaloneInvocation => {
  const explicit = argv[0] === '--utility' ? argv[1] : null;
  if (explicit) return { name: explicit, argv: argv.slice(2) };
  const envName = env.MOON_RELAY_STANDALONE_NAME;
  if (envName) return { name: envName, argv: [...argv] };
  const basename = path.basename(invokedPath || '').replace(/\.(?:cmd|ps1|mjs)$/i, '');
  return { name: basename, argv: [...argv] };
};

const errorRecord = (error: unknown): Record<string, unknown> => (
  error && typeof error === 'object'
    ? error as Record<string, unknown>
    : {}
);

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

export async function runStandaloneCli(
  name: string,
  argv: string[] = [],
  {
    cwd = process.cwd(),
    env = process.env,
    runtimeRoot = null,
  }: Omit<StandaloneCliDependencies, 'invokedPath' | 'output'> = {},
): Promise<Record<string, unknown>> {
  return runStandaloneCliApplication(
    name,
    argv,
    {
      cwd,
      env,
      runtimeRoot: runtimeRoot || resolveRuntimeRoot(import.meta.url),
    },
  );
}

export async function main(
  argv: string[] = process.argv.slice(2),
  {
    cwd = process.cwd(),
    env = process.env,
    runtimeRoot = null,
    invokedPath = process.argv[1] || '',
    output = printResult as StandaloneOutput,
  }: StandaloneCliDependencies = {},
): Promise<StandaloneCliResult> {
  const resolved = invokedName(argv, env, invokedPath);
  try {
    const result = await runStandaloneCli(
      resolved.name,
      resolved.argv,
      { cwd, env, runtimeRoot },
    );
    output(result, { json: resolved.argv.includes('--json') });
    return { exitCode: 0 };
  } catch (error: unknown) {
    const details = errorRecord(error);
    output(
      {
        status: 'error',
        errorCode: details.code || errorMessage(error),
        findings: details.findings || undefined,
        recovery: details.recovery || undefined,
      },
      { json: true },
    );
    return { exitCode: 1 };
  }
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
