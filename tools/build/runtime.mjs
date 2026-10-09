#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { listFiles, readSourceGraph, rewriteReferences, relativeSpecifier } from './source-graph.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const readOptional = async (file) => {
  try { return await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const checkSafeOutput = async (root, relative) => {
  if (path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').includes('..')) throw new Error('Invalid output path: ' + relative);
  const absolute = path.resolve(root, relative);
  if (absolute === root || !absolute.startsWith(root + path.sep)) throw new Error('Output escapes repository: ' + relative);
  let current = root;
  for (const part of path.relative(root, absolute).split(path.sep)) {
    current = path.join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Output path contains symlink: ' + relative); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
};

export const compileRuntime = async (root = ROOT) => {
  root = path.resolve(root);
  const graph = await readSourceGraph(root);
  const configFile = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
  if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
  const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
  const program = ts.createProgram(config.fileNames, { ...config.options, noEmit: true });
  const diagnostics = [...config.errors, ...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (name) => name, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }));
  const outputs = [];
  for (const entry of graph.entries) {
    let code = rewriteReferences(entry.text, entry.references, (specifier) => {
      if (!specifier.startsWith('.')) return specifier;
      const target = graph.resolveSource(entry.source, specifier);
      return target ? relativeSpecifier(entry.output, target.output) : specifier;
    });
    if (entry.source.endsWith('.mts')) {
      const result = ts.transpileModule(code, {
        fileName: entry.source,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, verbatimModuleSyntax: true, newLine: ts.NewLineKind.LineFeed },
        reportDiagnostics: true,
      });
      const errors = (result.diagnostics || []).filter((item) => item.category === ts.DiagnosticCategory.Error);
      if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: (name) => name, getCurrentDirectory: () => root, getNewLine: () => '\n' }));
      code = result.outputText;
    }
    const banner = '// Generated from ' + entry.source + '. Edit the source and run npm run build.\n';
    code = code.startsWith('#!') ? code.replace(/^(.*\n)/, '$1' + banner) : banner + code;
    outputs.push({ source: entry.source, output: entry.output, code, sourceDigest: digest(entry.text), outputDigest: digest(code) });
  }
  const tools = {};
  for (const file of ['package/source-layout.json', 'tools/build/source-graph.mjs', 'tools/build/runtime.mjs', 'tsconfig.json']) {
    tools[file] = digest((await readFile(path.join(root, file), 'utf8')).replace(/\r\n/g, '\n'));
  }
  const manifest = {
    schemaVersion: 1,
    compiler: 'typescript@' + ts.version,
    tools,
    files: outputs.map(({ code, ...entry }) => entry),
  };
  return { graph, outputs, manifest };
};

export const buildRuntime = async ({ root = ROOT, check = false, graphOnly = false } = {}) => {
  root = path.resolve(root);
  const compiled = await compileRuntime(root);
  if (graphOnly) return { status: 'passed', modules: compiled.graph.layout.modules.length, files: compiled.outputs.length, edges: compiled.graph.edges.length };
  const expected = new Set(compiled.outputs.map((item) => item.output));
  const manifestFile = 'dist/runtime-build.json';
  const previousText = await readOptional(path.join(root, manifestFile));
  const previous = previousText ? JSON.parse(previousText) : null;
  const stale = new Set();
  for (const module of compiled.graph.layout.modules.filter((item) => item.exclusiveOutput)) {
    try { for (const file of await listFiles(path.join(root, module.output))) {
      const name = module.output + '/' + file;
      if (!expected.has(name)) stale.add(name);
    } } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const file of previous?.files || []) {
    if (!expected.has(file.output)) {
      const owner = compiled.graph.layout.modules.find((item) => file.source?.startsWith(item.source + '/'));
      const mappedOutput = owner && owner.output + file.source.slice(owner.source.length).replace(/\.mts$/, '.mjs');
      if (!owner || file.output !== mappedOutput || !file.output.endsWith('.mjs')) throw new Error('Invalid previous output: ' + file.output);
      stale.add(file.output);
    }
  }
  // Check every destination before the first write or delete.
  for (const relative of [...expected, ...stale, manifestFile]) await checkSafeOutput(root, relative);
  const changed = [];
  for (const entry of compiled.outputs) {
    const existing = await readOptional(path.join(root, entry.output));
    if (existing !== entry.code) changed.push(entry.output);
  }
  const manifestText = JSON.stringify(compiled.manifest, null, 2) + '\n';
  if (check) {
    if (changed.length || stale.size || previousText !== manifestText) throw new Error('Runtime build is stale. Run npm run build.\n' + JSON.stringify({ changed, orphaned: [...stale], manifestChanged: previousText !== manifestText }));
  } else {
    for (const relative of stale) {
      try { await unlink(path.join(root, relative)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const entry of compiled.outputs) {
      if (!changed.includes(entry.output)) continue;
      await mkdir(path.dirname(path.join(root, entry.output)), { recursive: true });
      await writeFile(path.join(root, entry.output), entry.code);
    }
    await mkdir(path.join(root, 'dist'), { recursive: true });
    if (previousText !== manifestText) await writeFile(path.join(root, manifestFile), manifestText);
  }
  return { status: 'passed', mode: check ? 'check' : 'build', files: compiled.outputs.length, changed: changed.length, removed: stale.size, edges: compiled.graph.edges.length };
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await buildRuntime({ check: process.argv.includes('--check'), graphOnly: process.argv.includes('--boundaries') }))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
