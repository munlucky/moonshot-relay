import path from 'node:path';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';

export const KERNEL_PROFILE_RUNTIMES = [
  'claude',
  'codex',
  'qwen',
  'ade',
  'antigravity',
] as const;

export type KernelProfileRuntime = typeof KERNEL_PROFILE_RUNTIMES[number];

export interface KernelProfileMarker {
  schemaVersion: 1;
  productId: 'moon-relay-kernel';
  track: 'kernel';
  runtime: KernelProfileRuntime;
}

export interface BuildKernelProfileInput {
  sourceRoot?: string;
  runtime: string;
  targetRoot: string;
}

export const buildKernelProfile = async ({
  sourceRoot = process.cwd(),
  runtime,
  targetRoot,
}: BuildKernelProfileInput): Promise<KernelProfileMarker> => {
  if (!KERNEL_PROFILE_RUNTIMES.includes(runtime as KernelProfileRuntime)) {
    throw new Error(`Unsupported Kernel profile runtime: ${runtime}`);
  }

  const normalizedRuntime = runtime as KernelProfileRuntime;
  const source = path.join(
    sourceRoot,
    'package',
    'kernel',
    'profiles',
    normalizedRuntime,
  );
  await mkdir(targetRoot, { recursive: true });
  await cp(source, targetRoot, { recursive: true, force: true });

  const marker: KernelProfileMarker = {
    schemaVersion: 1,
    productId: 'moon-relay-kernel',
    track: 'kernel',
    runtime: normalizedRuntime,
  };
  await writeFile(
    path.join(targetRoot, '.moon-relay-kernel-profile.json'),
    JSON.stringify(marker, null, 2),
  );
  return marker;
};

export const inspectKernelProfile = async (
  targetRoot: string,
): Promise<KernelProfileMarker> => (
  JSON.parse(
    await readFile(
      path.join(targetRoot, '.moon-relay-kernel-profile.json'),
      'utf8',
    ),
  ) as KernelProfileMarker
);
