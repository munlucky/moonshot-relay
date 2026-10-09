import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

export const slash = (value) => value.replaceAll('\\', '/');
export const relativeSpecifier = (from, to) => {
  const value = path.posix.relative(path.posix.dirname(from), to);
  return value.startsWith('.') ? value : './' + value;
};

export const listFiles = async (root, relative = '') => {
  const result = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = slash(path.join(relative, entry.name));
    if (entry.isSymbolicLink()) throw new Error('Source/output symlink is not supported: ' + name);
    if (entry.isDirectory()) result.push(...await listFiles(root, name));
    else result.push(name);
  }
  return result.sort();
};

// Read only module syntax. Policy strings, comments, and import.meta.url asset
// paths are deliberately left unchanged.
export const moduleReferences = (file, text) => {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    file.endsWith('.mts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) {
    throw new Error(file + ': ' + ts.flattenDiagnosticMessageText(ast.parseDiagnostics[0].messageText, '\n'));
  }
  const references = [];
  const visit = (node) => {
    let value;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) value = node.moduleSpecifier;
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) value = node.arguments[0];
    if (value && ts.isStringLiteralLike(value)) {
      references.push({ specifier: value.text, start: value.getStart(ast) + 1, end: value.getEnd() - 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return references;
};

export const rewriteReferences = (text, references, resolve) => {
  for (const reference of [...references].sort((left, right) => right.start - left.start)) {
    const replacement = resolve(reference.specifier);
    if (replacement !== reference.specifier) {
      text = text.slice(0, reference.start) + replacement + text.slice(reference.end);
    }
  }
  return text;
};

export const readSourceGraph = async (root) => {
  const layout = JSON.parse(await readFile(path.join(root, 'package/source-layout.json'), 'utf8'));
  if (layout.schemaVersion !== 1 || !Array.isArray(layout.modules)) throw new Error('Unsupported source layout');
  const entries = [];
  const outputs = new Set();
  for (const module of layout.modules) {
    for (const directory of [module.source, module.output]) {
      if (!directory || path.isAbsolute(directory) || directory.split('/').includes('..')) throw new Error('Invalid module path: ' + directory);
    }
    if ((await lstat(path.join(root, module.source))).isSymbolicLink()) throw new Error('Source root is a symlink: ' + module.source);
    for (const name of await listFiles(path.join(root, module.source))) {
      if (name.endsWith('.d.mts') || name.endsWith('.md')) continue;
      if (!/\.(mjs|mts)$/.test(name)) throw new Error('Unsupported source file: ' + name);
      const source = module.source + '/' + name;
      const output = module.output + '/' + name.replace(/\.mts$/, '.mjs');
      if (outputs.has(output)) throw new Error('Duplicate runtime output: ' + output);
      outputs.add(output);
      const text = (await readFile(path.join(root, source), 'utf8')).replace(/\r\n/g, '\n');
      entries.push({ source, output, module, text, references: moduleReferences(source, text) });
    }
  }
  const bySource = new Map(entries.map((entry) => [entry.source, entry]));
  const resolveSource = (source, specifier) => {
    const candidate = path.posix.normalize(path.posix.join(path.posix.dirname(source), specifier));
    return bySource.get(candidate) || bySource.get(candidate.replace(/\.mjs$/, '.mts')) || null;
  };
  const edges = [];
  const usedExceptions = new Set();
  for (const entry of entries) {
    for (const reference of entry.references) {
      const specifier = reference.specifier;
      if (!specifier.startsWith('.')) {
        if (!specifier.startsWith('node:') && specifier !== 'better-sqlite3') throw new Error('Undeclared runtime package: ' + specifier + ' in ' + entry.source);
        continue;
      }
      const target = resolveSource(entry.source, specifier);
      const key = entry.source + ' -> ' + (target?.source || specifier);
      if (!target) {
        if (!(layout.externalImports || []).some((item) => item.from === entry.source && item.specifier === specifier)) throw new Error('Unresolved source dependency: ' + key);
        continue;
      }
      const exception = (layout.exceptions || []).find((item) => item.from === entry.source && item.to === target.source && item.reason);
      if (!entry.module.dependencies.includes(target.module.id) && !exception) throw new Error('Module boundary violation: ' + key);
      if (exception) usedExceptions.add(exception);
      edges.push({ from: entry.source, to: target.source });
    }
  }
  for (const exception of layout.exceptions || []) {
    if (!usedExceptions.has(exception)) throw new Error('Stale boundary exception: ' + exception.from + ' -> ' + exception.to);
  }
  return { layout, entries: entries.sort((a, b) => a.source.localeCompare(b.source)), resolveSource, edges };
};
