// Generated build tool. Edit the corresponding .ts source.
import ts from 'typescript';
import { readFile, writeFile, mkdir, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSourceGraph, moduleReferences, rewriteReferences, relativeSpecifier, listFiles } from './source-graph.mjs';
import { checkSafeOutput } from './runtime.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readOptional = async (file) => {
    try {
        return await readFile(file, 'utf8');
    }
    catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
            return null;
        throw error;
    }
};
export async function buildTests({ root = ROOT, check = false } = {}) {
    root = path.resolve(root);
    const configFile = ts.readConfigFile(path.join(root, 'tsconfig.tests.json'), ts.sys.readFile);
    const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
    const program = ts.createProgram(config.fileNames, config.options);
    const diagnostics = [...config.errors, ...ts.getPreEmitDiagnostics(program)];
    if (configFile.error)
        diagnostics.push(configFile.error);
    if (diagnostics.length)
        throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
            getCanonicalFileName: name => name, getCurrentDirectory: () => root, getNewLine: () => '\n',
        }));
    const graph = await readSourceGraph(root);
    const generated = [];
    const testFiles = config.fileNames.filter(file => file.endsWith('.ts') && !file.endsWith('.d.ts') && !file.replaceAll('\\', '/').includes('/tests/types/'));
    const testOutputs = new Map(testFiles.map(file => [path.relative(root, file).replaceAll('\\', '/'), 'dist/' + path.relative(root, file).replaceAll('\\', '/').replace(/\.ts$/, '.mjs')]));
    for (const file of testFiles) {
        if ((await lstat(file)).isSymbolicLink())
            throw new Error('Test source is a symlink: ' + file);
        const source = path.relative(root, file).replaceAll('\\', '/');
        await checkSafeOutput(root, source);
        const output = 'dist/' + source.replace(/\.ts$/, '.mjs');
        let text = await readFile(file, 'utf8');
        text = rewriteReferences(text, moduleReferences(source, text), specifier => {
            if (!specifier.startsWith('.'))
                return specifier;
            const target = graph.resolveSource(source, specifier);
            if (target)
                return relativeSpecifier(output, target.output);
            const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(source), specifier));
            const testOutput = testOutputs.get(resolved.replace(/\.js$/, '.ts'));
            if (testOutput)
                return relativeSpecifier(output, testOutput);
            if (resolved.startsWith('tools/build/') && resolved.endsWith('.js'))
                return relativeSpecifier(output, resolved.replace(/\.js$/, '.mjs'));
            return relativeSpecifier(output, resolved);
        });
        // Resolve canonical fixture locations at execution time; never embed the build machine root.
        const canonicalRelative = relativeSpecifier(output, source);
        const canonicalPreamble = `import {fileURLToPath as __kernelTestFilePath} from 'node:url';\nconst __kernelTestSourceUrl = new URL(${JSON.stringify(canonicalRelative)}, import.meta.url).href;\nconst __kernelTestSourceDir = __kernelTestFilePath(new URL('.', __kernelTestSourceUrl));\n`;
        if (/\b__kernelTest(?:FilePath|SourceUrl|SourceDir)\b/.test(text))
            throw new Error('Reserved generated test binding');
        const result = ts.transpileModule(text, {
            fileName: source, compilerOptions: { ...config.options, noEmit: false, sourceMap: false, module: ts.ModuleKind.ESNext },
            transformers: { before: [context => sourceFile => {
                        const visit = (node) => {
                            if (ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression)
                                && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword) {
                                if (node.name.text === 'url')
                                    return context.factory.createIdentifier('__kernelTestSourceUrl');
                                if (node.name.text === 'dirname')
                                    return context.factory.createIdentifier('__kernelTestSourceDir');
                            }
                            return ts.visitEachChild(node, visit, context);
                        };
                        return ts.visitEachChild(sourceFile, visit, context);
                    }] },
        });
        generated.push({ file: output, text: '// Generated test. Edit ' + source + '.\n' + canonicalPreamble + result.outputText });
        const wrapper = source.replace(/\.ts$/, '.mjs');
        const previous = await readOptional(path.join(root, wrapper));
        if (previous !== null && !previous.startsWith('// Generated test entrypoint.'))
            throw new Error('Refusing to overwrite maintained test: ' + wrapper);
        const target = JSON.stringify(relativeSpecifier(wrapper, output));
        const syntax = ts.createSourceFile(source, text, ts.ScriptTarget.Latest, true);
        const hasDefault = syntax.statements.some(statement => (ts.isExportAssignment(statement) && !statement.isExportEquals)
            || (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword))
            || (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)
                && statement.exportClause.elements.some(element => element.name.text === 'default')));
        const defaultExport = hasDefault ? 'export { default } from ' + target + ';\n' : '';
        generated.push({ file: wrapper, text: '// Generated test entrypoint. Edit ' + source + '.\nexport * from ' + target + ';\n' + defaultExport });
    }
    const expected = new Set(generated.map(entry => entry.file));
    const stale = [];
    for (const directory of ['dist/tests', 'tests']) {
        let files;
        try {
            files = await listFiles(path.join(root, directory));
        }
        catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
                continue;
            throw error;
        }
        for (const name of files) {
            const file = directory + '/' + name;
            if (!file.endsWith('.mjs') || expected.has(file))
                continue;
            const text = await readOptional(path.join(root, file));
            if (text?.startsWith(directory === 'tests' ? '// Generated test entrypoint.' : '// Generated test.'))
                stale.push(file);
            else if (directory === 'dist/tests')
                throw new Error('Refusing unmanaged test artifact: ' + file);
        }
    }
    // Validate every destination before writing or removing generated artifacts.
    for (const file of [...expected, ...stale])
        await checkSafeOutput(root, file);
    if (check && stale.length)
        throw new Error('Orphaned test build: ' + stale.join(', '));
    for (const entry of generated) {
        const existing = await readOptional(path.join(root, entry.file));
        if (check) {
            if (existing !== entry.text)
                throw new Error('Test build is stale: ' + entry.file);
        }
        else if (existing !== entry.text) {
            await mkdir(path.dirname(path.join(root, entry.file)), { recursive: true });
            await writeFile(path.join(root, entry.file), entry.text);
        }
    }
    if (!check)
        for (const file of stale)
            await unlink(path.join(root, file));
    return { status: 'passed', mode: check ? 'check' : 'build', tests: testFiles.filter(file => file.endsWith('.test.ts')).length, helpers: testFiles.filter(file => !file.endsWith('.test.ts')).length, removed: stale.length };
}
