import { createHash } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';

interface SourceLayoutModule {
  source: string;
  output: string;
  exclusiveOutput?: boolean;
}

interface SourceLayout {
  modules: SourceLayoutModule[];
}

interface RuntimeBuildReceiptFile {
  source: string;
  output: string;
  sourceDigest: string;
  outputDigest: string;
}

interface RuntimeBuildReceipt {
  schemaVersion: number;
  compiler: string;
  tools: Record<string, string>;
  files: RuntimeBuildReceiptFile[];
}

interface PackageMetadata {
  devDependencies?: {
    typescript?: string;
  };
}

export type RuntimeBuildAssertion =
  | { mode: 'runtime-only' }
  | { mode: 'source-checkout'; files: number };

const hash = (value: string): string => (
  createHash('sha256').update(value).digest('hex')
);

const read = (root: string, name: string): Promise<string> => (
  readFile(path.join(root, name), 'utf8')
);

const sourceText = async (root: string, name: string): Promise<string> => (
  await read(root, name)
).replace(/\r\n/g, '\n');

const sourceFiles = async (
  root: string,
  name: string,
  allFiles = false,
): Promise<string[]> => {
  if ((await lstat(path.join(root, name))).isSymbolicLink()) {
    throw new Error('Source root is a symlink');
  }

  const files: string[] = [];
  for (const entry of await readdir(path.join(root, name), { withFileTypes: true })) {
    const relative = `${name}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new Error('Source file is a symlink');
    }
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(root, relative, allFiles));
    } else if (
      allFiles
      || (
        /\.(mjs|mts|ts)$/.test(relative)
        && !relative.endsWith('.d.mts')
        && !relative.endsWith('.d.ts')
      )
    ) {
      files.push(relative);
    }
  }
  return files.sort();
};

const errorCode = (error: unknown): string | null => (
  error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : null
);

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

// This guard uses only Node built-ins. Installed payloads contain no src/ and
// never load TypeScript. A checkout must present a fresh build before copying.
export const assertRuntimeBuild = async (
  sourceRoot: string,
): Promise<RuntimeBuildAssertion> => {
  const root = path.resolve(sourceRoot);

  try {
    await lstat(path.join(root, 'src/kernel'));
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return { mode: 'runtime-only' };
    throw error;
  }

  try {
    const layout = JSON.parse(
      await read(root, 'package/source-layout.json'),
    ) as SourceLayout;
    const receipt = JSON.parse(
      await read(root, 'dist/runtime-build.json'),
    ) as RuntimeBuildReceipt;
    const pkg = JSON.parse(
      await read(root, 'package.json'),
    ) as PackageMetadata;

    if (
      receipt.schemaVersion !== 1
      || receipt.compiler !== `typescript@${pkg.devDependencies?.typescript}`
    ) {
      throw new Error('compiler receipt mismatch');
    }

    for (const [file, expected] of Object.entries(receipt.tools)) {
      if (hash(await sourceText(root, file)) !== expected) {
        throw new Error(`build input changed: ${file}`);
      }
    }

    const sources = (
      await Promise.all(
        layout.modules.map((module) => sourceFiles(root, module.source)),
      )
    ).flat().sort();
    const receiptSources = receipt.files
      .map((entry) => entry.source)
      .sort();
    if (JSON.stringify(sources) !== JSON.stringify(receiptSources)) {
      throw new Error('source inventory changed');
    }

    for (const entry of receipt.files) {
      if (hash(await sourceText(root, entry.source)) !== entry.sourceDigest) {
        throw new Error(`source changed: ${entry.source}`);
      }
      if (hash(await read(root, entry.output)) !== entry.outputDigest) {
        throw new Error(`runtime changed: ${entry.output}`);
      }
    }

    for (const module of layout.modules.filter((item) => item.exclusiveOutput)) {
      const actual = await sourceFiles(root, module.output, true);
      const expected = receipt.files
        .map((entry) => entry.output)
        .filter((file) => file.startsWith(`${module.output}/`))
        .sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`runtime inventory changed: ${module.output}`);
      }
    }

    return { mode: 'source-checkout', files: receipt.files.length };
  } catch (error: unknown) {
    throw new Error(
      'runtime_build_stale: run npm run build before packaging or installing. '
      + errorMessage(error),
      { cause: error },
    );
  }
};
