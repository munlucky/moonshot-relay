export { checkSafeOutput } from './source-graph.js';
import type { RuntimeManifest, RuntimeOutput } from './types.js';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { listFiles, readSourceGraph, rewriteReferences, relativeSpecifier, runtimeOutputForSource, checkSafeOutput } from './source-graph.js';
import { buildContractArtifacts } from './contracts.js';

const errorCode = (error: unknown): unknown => error && typeof error === 'object' && 'code' in error ? error.code : null;

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const readOptional = async (file: string) => {
  try { return await readFile(file, 'utf8'); } catch (error) { if (errorCode(error) === 'ENOENT') return null; throw error; }
};


export const compileRuntime = async (root = ROOT) => {
  root = path.resolve(root);
  await buildContractArtifacts({ root, check: true });
  const graph = await readSourceGraph(root);
  const configFile = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
  if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
  const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
  const buildConfigFile = ts.readConfigFile(path.join(root, 'tsconfig.build.json'), ts.sys.readFile);
  if (buildConfigFile.error) throw new Error(ts.flattenDiagnosticMessageText(buildConfigFile.error.messageText, '\n'));
  const buildConfig = ts.parseJsonConfigFileContent(buildConfigFile.config, ts.sys, root);
  const diagnose = (configuration: ts.ParsedCommandLine) => {
    const program = ts.createProgram(configuration.fileNames, { ...configuration.options, noEmit: true });
    return ts.getPreEmitDiagnostics(program);
  };
  // Release each compiler program before emit or the next program starts.
  const diagnostics = [...config.errors, ...buildConfig.errors, ...diagnose(config), ...diagnose(buildConfig)];
  if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (name) => name, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }));
  const outputs: RuntimeOutput[] = [];
  const debugMaps: { output: string; code: string }[] = [];
  for (const entry of graph.entries) {
    let code = rewriteReferences(entry.text, entry.references, (specifier) => {
      if (!specifier.startsWith('.')) return specifier;
      const target = graph.resolveSource(entry.source, specifier);
      return target ? relativeSpecifier(entry.output, target.output) : specifier;
    });
    if (entry.source.endsWith('.mts') || entry.source.endsWith('.ts')) {
      const result = ts.transpileModule(code, {
        fileName: entry.source,
        compilerOptions: { ...buildConfig.options, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, noEmit: false, outDir: undefined, rootDir: undefined, sourceMap: true, inlineSourceMap: false, inlineSources: false, newLine: ts.NewLineKind.LineFeed },
        reportDiagnostics: true,
      });
      const errors = (result.diagnostics || []).filter((item) => item.category === ts.DiagnosticCategory.Error);
      if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: (name) => name, getCurrentDirectory: () => root, getNewLine: () => '\n' }));
      code = result.outputText.replace(/^\/\/# sourceMappingURL=.*\n?/gm, '');
      if (result.sourceMapText) {
        const output = 'dist/debug/' + entry.output + '.map';
        const sourceMap: { file: string; sources: string[]; sourceRoot?: string; sourcesContent?: unknown; mappings: string } = JSON.parse(result.sourceMapText);
        sourceMap.file = path.posix.relative(path.posix.dirname(output), entry.output);
        sourceMap.sources = [path.posix.relative(path.posix.dirname(output), entry.source)];
        delete sourceMap.sourceRoot;
        delete sourceMap.sourcesContent;
        // The runtime banner occupies one unmapped generated line.
        sourceMap.mappings = ';' + sourceMap.mappings;
        debugMaps.push({ output, code: JSON.stringify(sourceMap) + '\n' });
      }
    }
    const banner = '// Generated from ' + entry.source + '. Edit the source and run npm run build.\n';
    code = code.startsWith('#!') ? code.replace(/^(.*\n)/, '$1' + banner) : banner + code;
    outputs.push({ source: entry.source, output: entry.output, code, sourceDigest: digest(entry.text), outputDigest: digest(code) });
  }
  const tools: Record<string, string> = {};
  const toolInputs = ['package/source-layout.json', 'tools/build/source-graph.mjs', 'tools/build/runtime.mjs', 'tools/build/runtime.ts', 'tools/build/source-graph.ts', 'tools/build/types.ts', 'tools/build/bootstrap.ts', 'tools/build/bootstrap.mjs', 'tools/build/prepare.ts', 'tools/build/prepare.mjs', 'tools/build/contracts.ts', 'tools/build/contracts.mjs', 'tsconfig.tools.json', 'tsconfig.json', 'tsconfig.build.json'];
  for (const file of ['package.json', 'package-lock.json']) {
    if (await readOptional(path.join(root, file))) toolInputs.push(file);
  }
  if (await readOptional(path.join(root, 'catalog/kernel-contracts.json'))) {
    toolInputs.push('catalog/kernel-contracts.json', ...(await listFiles(path.join(root, 'schemas'))).filter(file => /^kernel\..*\.schema\.json$/.test(file)).map(file => 'schemas/' + file));
  }
  for (const file of toolInputs) {
    tools[file] = digest((await readFile(path.join(root, file), 'utf8')).replace(/\r\n/g, '\n'));
  }
  const manifest: RuntimeManifest = {
    schemaVersion: 1,
    compiler: 'typescript@' + ts.version,
    tools,
    files: outputs.map(({ code, ...entry }) => entry),
  };
  return { graph, outputs, manifest, debugMaps };
};

export const buildRuntime = async ({ root = ROOT, check = false, graphOnly = false } = {}) => {
  root = path.resolve(root);
  const compiled = await compileRuntime(root);
  if (graphOnly) return { status: 'passed', modules: compiled.graph.layout.modules.length, files: compiled.outputs.length, edges: compiled.graph.edges.length };
  const expected = new Set(compiled.outputs.map((item) => item.output));
  const expectedMaps = new Set(compiled.debugMaps.map(item => item.output));
  const staleMaps = new Set<string>();
  try {
    for (const file of await listFiles(path.join(root, 'dist/debug'))) {
      const relative = 'dist/debug/' + file;
      if (!file.endsWith('.map')) throw new Error('Unexpected diagnostic artifact: ' + relative);
      if (!expectedMaps.has(relative)) staleMaps.add(relative);
    }
  } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
  const manifestFile = 'dist/runtime-build.json';
  const previousText = await readOptional(path.join(root, manifestFile));
  const previous = previousText ? JSON.parse(previousText) as RuntimeManifest : null;
  const stale = new Set<string>();
  for (const module of compiled.graph.layout.modules.filter((item) => item.exclusiveOutput)) {
    try { for (const file of await listFiles(path.join(root, module.output))) {
      const name = module.output + '/' + file;
      if (!expected.has(name)) stale.add(name);
    } } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
  }
  for (const file of previous?.files || []) {
    if (!expected.has(file.output)) {
      const owner = compiled.graph.layout.modules.find((item) => file.source?.startsWith(item.source + '/'));
      const mappedOutput = owner && runtimeOutputForSource(
        owner.output + file.source.slice(owner.source.length),
        owner.typescriptExtension || '.js',
      );
      if (!owner || file.output !== mappedOutput) throw new Error('Invalid previous output: ' + file.output);
      stale.add(file.output);
    }
  }
  // Check every destination before the first write or delete.
  for (const relative of [...expected, ...stale, ...staleMaps, manifestFile, ...expectedMaps]) await checkSafeOutput(root, relative);
  const changed: string[] = [];
  for (const entry of compiled.outputs) {
    const existing = await readOptional(path.join(root, entry.output));
    if (existing !== entry.code) changed.push(entry.output);
  }
  const manifestText = JSON.stringify(compiled.manifest, null, 2) + '\n';
  const changedMaps: string[] = [];
  for (const entry of compiled.debugMaps) {
    if (await readOptional(path.join(root, entry.output)) !== entry.code) changedMaps.push(entry.output);
  }
  if (check) {
    if (changed.length || stale.size || staleMaps.size || changedMaps.length || previousText !== manifestText) throw new Error('Runtime build is stale. Run npm run build.\n' + JSON.stringify({ changed, diagnosticChanged: changedMaps, orphaned: [...stale, ...staleMaps], manifestChanged: previousText !== manifestText }));
  } else {
    for (const relative of [...stale, ...staleMaps]) {
      try { await unlink(path.join(root, relative)); } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    }
    for (const entry of compiled.outputs) {
      if (!changed.includes(entry.output)) continue;
      await mkdir(path.dirname(path.join(root, entry.output)), { recursive: true });
      await writeFile(path.join(root, entry.output), entry.code);
    }
    for (const entry of compiled.debugMaps) {
      if (!changedMaps.includes(entry.output)) continue;
      await mkdir(path.dirname(path.join(root, entry.output)), { recursive: true });
      await writeFile(path.join(root, entry.output), entry.code);
    }
    await mkdir(path.join(root, 'dist'), { recursive: true });
    if (previousText !== manifestText) await writeFile(path.join(root, manifestFile), manifestText);
  }
  return { status: 'passed', mode: check ? 'check' : 'build', files: compiled.outputs.length, changed: changed.length, removed: stale.size + staleMaps.size, edges: compiled.graph.edges.length };
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await buildRuntime({ check: process.argv.includes('--check'), graphOnly: process.argv.includes('--boundaries') }))); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
