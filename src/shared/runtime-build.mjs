import { createHash } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const read = (root, name) => readFile(path.join(root, name), 'utf8');
const sourceText = async (root, name) => (await read(root, name)).replace(/\r\n/g, '\n');
const sourceFiles = async (root, name, allFiles = false) => {
  if ((await lstat(path.join(root, name))).isSymbolicLink()) throw new Error('Source root is a symlink');
  const files = [];
  for (const entry of await readdir(path.join(root, name), { withFileTypes: true })) {
    const relative = name + '/' + entry.name;
    if (entry.isSymbolicLink()) throw new Error('Source file is a symlink');
    if (entry.isDirectory()) files.push(...await sourceFiles(root, relative, allFiles));
    else if (allFiles || (/\.(mjs|mts)$/.test(relative) && !relative.endsWith('.d.mts'))) files.push(relative);
  }
  return files.sort();
};

// This guard uses only Node built-ins. Installed payloads contain no src/ and
// never load TypeScript. A checkout must present a fresh build before copying.
export const assertRuntimeBuild = async (sourceRoot) => {
  const root = path.resolve(sourceRoot);
  try { await lstat(path.join(root, 'src/kernel')); }
  catch (error) { if (error.code === 'ENOENT') return { mode: 'runtime-only' }; throw error; }
  try {
    const layout = JSON.parse(await read(root, 'package/source-layout.json'));
    const receipt = JSON.parse(await read(root, 'dist/runtime-build.json'));
    const pkg = JSON.parse(await read(root, 'package.json'));
    if (receipt.schemaVersion !== 1 || receipt.compiler !== 'typescript@' + pkg.devDependencies?.typescript) throw new Error('compiler receipt mismatch');
    for (const [file, expected] of Object.entries(receipt.tools)) {
      if (hash(await sourceText(root, file)) !== expected) throw new Error('build input changed: ' + file);
    }
    const sources = (await Promise.all(layout.modules.map((module) => sourceFiles(root, module.source)))).flat().sort();
    if (JSON.stringify(sources) !== JSON.stringify(receipt.files.map((entry) => entry.source).sort())) throw new Error('source inventory changed');
    for (const entry of receipt.files) {
      if (hash(await sourceText(root, entry.source)) !== entry.sourceDigest) throw new Error('source changed: ' + entry.source);
      if (hash(await read(root, entry.output)) !== entry.outputDigest) throw new Error('runtime changed: ' + entry.output);
    }
    for (const module of layout.modules.filter((item) => item.exclusiveOutput)) {
      const actual = await sourceFiles(root, module.output, true);
      const expected = receipt.files.map((entry) => entry.output).filter((file) => file.startsWith(module.output + '/')).sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('runtime inventory changed: ' + module.output);
    }
    return { mode: 'source-checkout', files: receipt.files.length };
  } catch (error) {
    throw new Error('runtime_build_stale: run npm run build before packaging or installing. ' + error.message, { cause: error });
  }
};
