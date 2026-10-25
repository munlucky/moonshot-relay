#!/usr/bin/env node
// Generated build tool. Edit the corresponding .ts source.
// Node 20 bootstrap. This file is the canonical strict TypeScript build entrypoint.
import ts from '@typescript/typescript6';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export async function buildDevelopmentTools({ check = false } = {}) {
    const file = ts.readConfigFile(path.join(root, 'tsconfig.tools.json'), ts.sys.readFile);
    const config = ts.parseJsonConfigFileContent(file.config, ts.sys, root);
    const program = ts.createProgram(config.fileNames, config.options);
    const diagnostics = [file.error, ...config.errors, ...ts.getPreEmitDiagnostics(program)].filter((value) => Boolean(value));
    if (diagnostics.length)
        throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
            getCanonicalFileName: name => name, getCurrentDirectory: () => root, getNewLine: () => '\n',
        }));
    const outputs = [];
    const emitted = program.emit(undefined, (file, text) => {
        const generatedFile = file.replace(/\.js$/, '.mjs');
        const generatedText = text.replace(/(['"]\.\/(?:types|source-graph|runtime|tests|bootstrap|contracts))\.js(['"])/g, '$1.mjs$2');
        const banner = '// Generated build tool. Edit the corresponding .ts source.\n';
        outputs.push({ file: generatedFile, text: generatedText.startsWith('#!') ? generatedText.replace(/^(.*\n)/, '$1' + banner) : banner + generatedText });
    });
    if (emitted.emitSkipped)
        throw new Error('Build tool compilation failed');
    for (const output of outputs) {
        let existing = null;
        try {
            existing = await readFile(output.file, 'utf8');
        }
        catch (error) {
            if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
                throw error;
        }
        if (check) {
            if (existing !== output.text)
                throw new Error('Build tool is stale: ' + output.file);
        }
        else if (existing !== output.text)
            await writeFile(output.file, output.text);
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await buildDevelopmentTools({ check: process.argv.includes('--check') || process.argv.includes('--boundaries') });
    if (process.argv.includes('--tests')) {
        const { buildTests } = await import('./tests.mjs');
        console.log(JSON.stringify(await buildTests({ check: process.argv.includes('--check') })));
    }
    else {
        const { buildRuntime } = await import('./runtime.mjs');
        console.log(JSON.stringify(await buildRuntime({ check: process.argv.includes('--check'), graphOnly: process.argv.includes('--boundaries') })));
    }
}
